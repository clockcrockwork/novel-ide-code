import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateCSRFToken, requireJsonBody, bodySize, revokeSessionIfTokenInvalid } from './middleware';
import { validateBranch, validateFileName, validateWorkspaceRootPath } from './validation';
import {
  GitHubUpstreamError, RemoteContentCorruptError, ProtocolUpgradeRequiredError,
  syncErrorResponse, syncMissingResponse, syncNotFoundResponse,
  syncConflictResponse, syncProtocolUpgradeResponse,
} from './syncErrors';
import {
  KNOWN_SAFE_FORMAT_VERSION, LEGACY_DEFAULT_FORMAT_VERSION, FORMAT_CAPABILITY_HEADER,
} from './syncErrorCodes';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();
const GH_API = 'https://api.github.com';
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SYNC_BODY_LIMIT = bodySize(2 * 1024 * 1024);

// manifest.version は数値であることを保証しない（Git 管理の可読ファイルで手編集されうる）。
// 欠落・非数値・非整数は「宣言なしの旧 client」として LEGACY_DEFAULT_FORMAT_VERSION に倒す。
// 高い方に倒すと、壊れた/古い manifest に対して不必要に書き込みを拒否してしまう。
function parseFormatVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : LEGACY_DEFAULT_FORMAT_VERSION;
}

// token は context から取得する。GitHub が token 失効を示す応答を返したら
// 単一の入口でKVセッションを破棄する（#288）。
async function ghFetch(c: Context<AppEnv>, path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers as HeadersInit);
  headers.set('Authorization', `Bearer ${c.get('githubToken')}`);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  if (opts.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${GH_API}${path}`, { ...opts, headers });
  if (await revokeSessionIfTokenInvalid(c, res.status)) {
    throw new HTTPException(401, { message: 'GitHub token revoked, please re-login' });
  }
  return res;
}

function encodeJson(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeJson(b64: string): unknown {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// upstream 応答の JSON parse 失敗を SyntaxError のまま投げない。route の共通ハンドラは
// SyntaxError を「client のリクエスト本文が不正」の 400 として扱うため、GET route
// （リクエスト本文を parse していない）で混ざると原因の帰属が逆になる。
async function upstreamJson<T>(r: Response, operation: string): Promise<T> {
  try {
    return (await r.json()) as T;
  } catch {
    throw new GitHubUpstreamError(502, operation);
  }
}

async function repoFile(c: Context<AppEnv>, login: string, path: string) {
  const r = await ghFetch(c, `/repos/${login}/.novel-ide/contents/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new GitHubUpstreamError(r.status, `read ${path}`);
  const d = await upstreamJson<{ content: string; sha: string }>(r, `parse ${path} response`);
  try {
    return { content: decodeJson(d.content), sha: d.sha };
  } catch {
    throw new RemoteContentCorruptError(path);
  }
}

// `.novel-ide/files/` に entity が 1 つでもあるか。manifest 不在時に「本当に空の workspace か」
// を判定するために使う。contents API はディレクトリに対して配列を返し、存在しなければ 404。
// 戻り値は「entity が無いと確認できた」ときだけ false。判定できない応答（配列でない =
// submodule / symlink / 単一ファイル、JSON でない等）は entity 無しの肯定に使わない。
// false は init（全件 push）を許可する側なので、曖昧さは fail-closed に倒す。
async function hasSyncedEntities(c: Context<AppEnv>, login: string) {
  const r = await ghFetch(c, `/repos/${login}/.novel-ide/contents/files`);
  if (r.status === 404) return false;
  if (!r.ok) throw new GitHubUpstreamError(r.status, 'list files');
  const listing = await r.json().catch(() => null);
  if (!Array.isArray(listing)) return true;
  return listing.length > 0;
}

// remote manifest の現在の formatVersion を、この request の capability 宣言・書き込む
// body 自身の version と突き合わせる。契約全体（GET 404 の扱い・downgrade 防止の理由）は
// docs/data-model/sync-contract.md「manifest の formatVersion 契約」を正本とする。
// 許可してよいときは戻り、そうでなければ ProtocolUpgradeRequiredError を throw する
// （GitHubUpstreamError と同じ「throw → syncErrorResponse が分類」経路に統一）。
// 戻り値は読み取った current（manifest 不在なら null）。呼び出し側（PUT /sync/manifest）が
// manifest CAS（#609 A-2「manifest write は _sha 必須」）にそのまま使う。同一 request 内で
// manifest.json を 2 回読まないため。
async function checkFormatCapability(
  c: Context<AppEnv>, login: string, expectedSha: string | null, writtenVersion: unknown,
): Promise<{ content: unknown; sha: string } | null> {
  const written = parseFormatVersion(writtenVersion);
  const capability = parseFormatVersion(
    Number.parseInt(c.req.header(FORMAT_CAPABILITY_HEADER) ?? '', 10),
  );
  // 以下の KNOWN_SAFE_FORMAT_VERSION 参照は「無条件許可してよい安全域の上限」の意味で使う
  // （#394 C-0 で LEGACY_DEFAULT_FORMAT_VERSION / FORMAT_CAPABILITY_VERSION と分離済み）。
  // 書き込む version 自体が安全域を超えるなら、manifest の有無（初回作成か既存更新か）に
  // 関わらず capability 上限を検査する。capability は「この client が理解できる version の
  // 上限」という契約であり、これを超える version を書き込めてしまうと、書いた client 自身が
  // 理解できない manifest を作ってしまう（詳細は docs 参照。#609 Codex レビュー指摘:
  // 当初は既存 manifest への上書き時にしか効かず、初回作成では素通りしていた）。
  if (written > KNOWN_SAFE_FORMAT_VERSION && written > capability) {
    throw new ProtocolUpgradeRequiredError('PUT /sync/manifest');
  }
  const current = await repoFile(c, login, 'manifest.json');
  if (!current) {
    // GET 404 でも request が既存更新のつもり（_sha 送信）なら矛盾。レプリケーション遅延の
    // 悪用を防ぐ fail-closed（詳細は docs 参照）。
    if (expectedSha) {
      throw new GitHubUpstreamError(502, 'checkFormatCapability: manifest read inconsistent with expected sha');
    }
    return null;
  }
  const remoteVersion = parseFormatVersion((current.content as { version?: unknown })?.version);
  // remote も書き込む version も既知安全域内なら、宣言不問で許可する（安全域は「全 client が
  // 理解する」という定義そのものなので capability 宣言の有無に依存させない。#609 Codex
  // レビュー指摘: remoteVersion だけで早期 return すると、書き込む version が安全域を
  // 超えるケース〔remote=2・capability=2・body.version=3〕を検査せず通してしまっていた）。
  if (remoteVersion <= KNOWN_SAFE_FORMAT_VERSION && written <= KNOWN_SAFE_FORMAT_VERSION) return current;
  // capability 宣言だけでなく書き込む body 自身の version も remoteVersion 以上を要求する
  // （downgrade 防止。written > capability は上で検査済みだが、written <= KNOWN_SAFE_FORMAT_VERSION
  // だが remoteVersion がそれを超える downgrade のケースはここでしか捕まえられない）。
  if (capability < remoteVersion || written < remoteVersion) {
    throw new ProtocolUpgradeRequiredError('PUT /sync/manifest');
  }
  return current;
}

// entity write 用の formatVersion ゲート（#609 A-2）。manifest PUT の checkFormatCapability と
// 違い、entity には「書き込む version」という概念が無いため、remote の宣言と capability の
// 突き合わせだけを行う（manifest GET 自体は呼び出し側が既に済ませたものを渡す。1 request で
// manifest.json を 2 回読まないため）。
function checkRemoteFormatVersion(c: Context<AppEnv>, manifest: { content: unknown }): void {
  const capability = parseFormatVersion(
    Number.parseInt(c.req.header(FORMAT_CAPABILITY_HEADER) ?? '', 10),
  );
  const remoteVersion = parseFormatVersion((manifest.content as { version?: unknown })?.version);
  // KNOWN_SAFE_FORMAT_VERSION = 無条件許可の安全域上限（checkFormatCapability と同じ意味）。
  if (remoteVersion > KNOWN_SAFE_FORMAT_VERSION && capability < remoteVersion) {
    throw new ProtocolUpgradeRequiredError('PUT /sync/file');
  }
}

async function writeRepoFile(
  c: Context<AppEnv>, login: string, path: string,
  content: unknown, sha: string | null, message: string, branch: string,
) {
  const body: Record<string, unknown> = { message, content: encodeJson(content), branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(c, `/repos/${login}/.novel-ide/contents/${path}`, {
    method: 'PUT', body: JSON.stringify(body),
  });
  if (!r.ok) {
    // 本文は診断ログ用にだけ読む。非 JSON 応答（プロキシの HTML エラーページ等）でも
    // 分類は status のみに依存させ、本文の形に左右されないようにする。
    const e = (await r.json().catch(() => ({}))) as { message?: string };
    console.error('GitHub write error', r.status, e.message);
    throw new GitHubUpstreamError(r.status, `write ${path}`);
  }
  const written = await upstreamJson<{ content: { sha: string } }>(r, `parse write ${path} response`);
  return written.content.sha;
}

// `.novel-ide` の存在確認。404 は「まだ無い」という正常な分岐なので null を返し、
// それ以外の失敗は typed error にする（一時的な障害を「不在」と誤認させない）。
async function syncRepo(c: Context<AppEnv>, login: string) {
  const r = await ghFetch(c, `/repos/${login}/.novel-ide`);
  if (r.status === 404) return null;
  if (!r.ok) throw new GitHubUpstreamError(r.status, 'read repo');
  return await upstreamJson<{ default_branch: string }>(r, 'parse repo response');
}

// POST /sync/init — create .novel-ide if not exists, return branch name
app.post('/init', validateCSRFToken, async c => {
  const login = c.get('login');
  try {
    // 既存 repo の確認は syncRepo に寄せる。非 404 の失敗を「不在」と誤認して
    // repo 作成へ進まないこと（fail-closed）が要件。
    const existing = await syncRepo(c, login);
    if (existing) {
      // manifest が無いのに entity がある workspace では init を成功させない。
      // client 側のガード（sync_workspace_inconsistent で init に入らない）だけだと、
      // worker とフロントの切り替えが非同時な環境で破れる: 旧 bundle を開いたままのタブは
      // 未知 code を無視して従来どおり /sync/init を呼び、200 を受けて全 local ファイルを
      // 分類なしで push し、同じ id の remote 本文を上書きしてしまう。
      // 信頼境界の側（worker）でも閉じる。
      const manifest = await repoFile(c, login, 'manifest.json');
      if (!manifest && (await hasSyncedEntities(c, login))) {
        return syncMissingResponse(c, 'workspaceInconsistent');
      }
      return c.json({ created: false, branch: existing.default_branch });
    }

    const createR = await ghFetch(c, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: '.novel-ide',
        description: 'novel-ide sync repository (auto-managed)',
        private: true,
        auto_init: true,
      }),
    });
    if (!createR.ok) {
      const e = (await createR.json().catch(() => ({}))) as { message?: string };
      console.error('GitHub repo create error', createR.status, e.message);
      // init は client の破壊的経路の入口。ここだけ code なしの固定 500 にすると
      // client は「未知の 500」として扱うしかない。他の失敗と同じ typed error に揃える。
      throw new GitHubUpstreamError(createR.status, 'create repo');
    }
    const repo = await upstreamJson<{ default_branch: string }>(createR, 'parse create repo response');
    const branch = repo.default_branch;

    await new Promise(r => setTimeout(r, 1500));
    try {
      // LEGACY_DEFAULT_FORMAT_VERSION（version フィールドを一度も書かなかった旧 client と
      // 同じ既定値）を書く。client が後で通常同期の pushManifest で現行 version へ上げる
      // （#394 E9。KNOWN_SAFE_FORMAT_VERSION〔無条件許可の安全域上限〕とは意味が違う定数）。
      await writeRepoFile(c, login, 'manifest.json',
        { version: LEGACY_DEFAULT_FORMAT_VERSION, updatedAt: new Date().toISOString(), fileOrder: [], files: {} },
        null, 'init: create sync manifest', branch);
    } catch (e: unknown) {
      // manifest の初期化失敗は致命的でない（初回同期で作られる）。ただし 401 の
      // セッション破棄は握り潰さない。
      if (e instanceof HTTPException) throw e;
    }

    return c.json({ created: true, branch });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// GET /sync/manifest — returns manifest + _sha + _branch
app.get('/manifest', async c => {
  const login = c.get('login');
  try {
    // repo 不在と manifest 不在は client の init 突入判定の入力なので別 code で返す。
    // どちらでもない失敗（403 / 5xx 等）は 404 にせず typed error として伝える。
    const repo = await syncRepo(c, login);
    if (!repo) return syncMissingResponse(c, 'repo');
    const result = await repoFile(c, login, 'manifest.json');
    if (!result) {
      // manifest が取れないだけで「remote には何も無い」と断定しない。contents API は
      // repo 作成直後のレプリケーション遅延でも 404 を返しうるため、entity の実在を確認する。
      // entity があるのに manifest が無い状態は「snapshot index を失った」異常であり、
      // 全件 push（init）で上書きしてよい状態ではない。
      const hasEntities = await hasSyncedEntities(c, login);
      return syncMissingResponse(c, hasEntities ? 'workspaceInconsistent' : 'manifest');
    }
    return c.json({ ...(result.content as object), _sha: result.sha, _branch: repo.default_branch });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// PUT /sync/manifest — body must include _branch
app.put('/manifest', SYNC_BODY_LIMIT, requireJsonBody, validateCSRFToken, async c => {
  const login = c.get('login');
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const { _sha, _branch, ...manifest } = body as Record<string, unknown>;
    const branchErr = validateBranch(_branch);
    if (branchErr) return c.json({ error: branchErr }, 400);
    const writtenVersion = (manifest as { version?: unknown }).version;
    const current = await checkFormatCapability(c, login, (_sha as string) || null, writtenVersion);
    // manifest write は初回作成を除き _sha 必須（#609 A-2）。current が存在するのに
    // _sha が無い、または一致しなければ他端末が manifest を進めている。GitHub に投げる前に
    // worker で判定する（GitHub 自身の CAS より先に検出し、typed な conflict code を返す）。
    // current が存在しないケースは checkFormatCapability が既に fail-closed（_sha 送信時は
    // 502）で扱っているため、ここでは current 有無だけで分岐してよい。
    if (current && (typeof _sha !== 'string' || _sha.length === 0 || current.sha !== _sha)) {
      return syncConflictResponse(c, 'manifestStale');
    }
    // client の読み側（buildRemoteMap）は files が dict でない manifest を corrupt として
    // 弾く。書き側で同じ形状を受け入れると、client 自身が「自分の読み側が拒否する
    // manifest」を書けてしまい、全端末が復旧できない状態を生成できる（受理集合の非対称）。
    // ただしこの v2 固有の形状要求は、書き込む manifest 自身が既知安全域（v2）の場合にだけ
    // 適用する。v3 以降は files を削除・配列化する等 schema 自体を変えてよいため、
    // checkFormatCapability を先に通した正規の v3 write（remote・capability・written version
    // が揃って許可された）まで v2 の形状規則で 400 にしてしまうと、将来の正規 v3 client が
    // 一切 manifest を更新できなくなる（Codex レビュー指摘）。
    if (parseFormatVersion(writtenVersion) <= KNOWN_SAFE_FORMAT_VERSION) {
      const files = (manifest as { files?: unknown }).files;
      if (files === undefined || files === null || typeof files !== 'object' || Array.isArray(files)) {
        return c.json({ error: 'manifest.files must be an object' }, 400);
      }
    } else {
      // v3 以降（#394）: 読み寛容・書き厳格（契約3）。client 読み側は folders 欠落・非 dict を
      // unknown として local を保持するが、worker の書き側は files・folders の両方が
      // dict であることを要求する。v2 と異なり folders 欠落を許すと、client 自身の
      // 読み側が拒否する manifest（files はあるが folders が壊れている）を書けてしまう。
      const files = (manifest as { files?: unknown }).files;
      const okFiles = files !== undefined && files !== null && typeof files === 'object' && !Array.isArray(files);
      const folders = (manifest as { folders?: unknown }).folders;
      const okFolders = folders !== undefined && folders !== null && typeof folders === 'object' && !Array.isArray(folders);
      if (!okFiles || !okFolders) {
        return c.json({ error: 'manifest.files and manifest.folders must be objects' }, 400);
      }
    }
    const sha = await writeRepoFile(c, login, 'manifest.json',
      manifest, (_sha as string) || null, 'sync: update manifest', _branch as string);
    return c.json({ ok: true, sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// GET /sync/file/:id
app.get('/file/:id', async c => {
  const login = c.get('login');
  const id = c.req.param('id');
  if (!FILE_ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
  try {
    const result = await repoFile(c, login, `files/${id}.json`);
    if (!result) return syncNotFoundResponse(c);
    return c.json({ ...(result.content as object), _sha: result.sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// PUT /sync/file/:id — body must include _branch, _manifestSha（#609 A-2 の世代拘束契約は
// docs/data-model/sync-contract.md「entity write の世代拘束と reconcile」を正本とする）。
app.put('/file/:id', SYNC_BODY_LIMIT, requireJsonBody, validateCSRFToken, async c => {
  const login = c.get('login');
  const id = c.req.param('id');
  if (!FILE_ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const { _sha, _branch, _manifestSha, _reconcile, ...file } = body as Record<string, unknown>;
    const branchErr = validateBranch(_branch);
    if (branchErr) return c.json({ error: branchErr }, 400);
    if (!validateFileName(file.name)) return c.json({ error: 'invalid name' }, 400);
    // 旧 bundle（この契約を知らない client）は `_manifestSha` を送らない。in-place 上書きへ
    // 素通しせず、更新を促す（fail-closed）。
    if (typeof _manifestSha !== 'string' || _manifestSha.length === 0) {
      return syncProtocolUpgradeResponse(c, 'manifestRefRequired');
    }
    const reconcile = _reconcile === true;
    // reconcile は _sha: null（create-only の明示的な acknowledge）も受理する（#609 round2 F3）。
    // null 以外を送るなら文字列必須。
    if (reconcile && _sha !== null && (typeof _sha !== 'string' || _sha.length === 0)) {
      return c.json({ error: 'invalid _sha for reconcile' }, 400);
    }

    // manifest 不在では entity を書かない（fail-closed。レプリケーション遅延で manifest だけ
    // 一時的に見えなくなった場合に、世代検査をすり抜けて上書きすることを防ぐ）。
    const manifest = await repoFile(c, login, 'manifest.json');
    if (!manifest) return syncMissingResponse(c, 'manifest');
    // 書く側が読んだ manifest 世代（_manifestSha）に拘束する。別端末が manifest を
    // 進めていれば、この request はもう「snapshot が指す実体」を上書きする根拠を失っている。
    if (manifest.sha !== _manifestSha) return syncConflictResponse(c, 'manifestStale');
    checkRemoteFormatVersion(c, manifest);

    const files = (manifest.content as { files?: unknown })?.files;
    const filesDict =
      files && typeof files === 'object' && !Array.isArray(files)
        ? (files as Record<string, unknown>)
        : null;
    // own property のみを実在 entry とみなす（#609 round2 F2）。プレーンオブジェクトを
    // `files[id]` で素朴に索引すると、`id` が `__proto__` / `constructor` 等のときプロトタイプ
    // チェーン経由で継承値（Object.prototype 自体など）が返り、「entry が存在する」と誤判定
    // して実在確認（create-only の既存チェック）をすり抜けてしまう。
    const entry = filesDict && Object.hasOwn(filesDict, id) ? filesDict[id] : undefined;
    const hasEntry = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const entrySha = hasEntry ? (entry as { sha?: unknown }).sha : undefined;

    let writeSha: string | null = null;
    let createOnly = false;
    if (reconcile) {
      if (typeof _sha === 'string' && _sha.length > 0) {
        // 明示的な acknowledge（reconcile）がある write だけが stale/orphan を上書きできる。
        // entry の有無に関わらず、client が確認した live sha で GitHub CAS する。worker は
        // reconcile の真正性（client が本当に live GET したか）を検証しない — 同一信頼境界内
        // （この session の authorizedRepos）からの明示 acknowledge として受け入れる。
        writeSha = _sha;
      } else {
        // _sha: null → create-only（live entity が無かったことの明示的な acknowledge）。
        writeSha = null;
        createOnly = true;
      }
    } else if (hasEntry && typeof entrySha === 'string') {
      // 「snapshot が指す実体」以外への上書きを防ぐ。
      if (_sha !== entrySha) return syncConflictResponse(c, 'entityStale');
      writeSha = entrySha;
    } else {
      // entry が無い、または legacy entry（sha フィールドを持たない旧 manifest）。
      // legacy entry は以前 client の `_sha` を検査せず素通ししていたが、実在確認を経ない
      // 上書きを許してしまうため、entry 無しと同じ create-only 経路に倒す（#609 round2 F1）。
      const existing = await repoFile(c, login, `files/${id}.json`);
      if (existing) return syncConflictResponse(c, 'entityOrphan');
      writeSha = null;
      createOnly = true;
    }

    let sha: string;
    try {
      sha = await writeRepoFile(c, login, `files/${id}.json`,
        file, writeSha, `sync: update ${(file.name as string) || id}`, _branch as string);
    } catch (e: unknown) {
      if (e instanceof GitHubUpstreamError) {
        // create-only（entry 無し・legacy・reconcile の _sha:null）の書き込みが 409/422
        // （既に存在した等）で失敗した場合は、不在確認と create の間に別端末が作った可能性が
        // ある。orphan へ読み替える（CAS write 側の 409/422 → entity_stale と対称。
        // #609 round3 L3）。
        if (writeSha === null && createOnly && (e.upstreamStatus === 409 || e.upstreamStatus === 422)) {
          return syncConflictResponse(c, 'entityOrphan');
        }
        // sha 付き（CAS）write が GitHub の 409（SHA 不一致）/422（blob 消失等）で拒否された
        // 場合、client の reconcile 経路に乗るよう entity_stale として返す（#609 round2 F3）。
        // 汎用 sync_conflict / sync_unprocessable のままだと reconcile 判定
        // （isReconcilableConflict）に載らず、stale な write が握り潰されて再試行できない。
        if (writeSha !== null && (e.upstreamStatus === 409 || e.upstreamStatus === 422)) {
          return syncConflictResponse(c, 'entityStale');
        }
      }
      throw e;
    }
    return c.json({ ok: true, sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// GET /sync/settings
app.get('/settings', async c => {
  const login = c.get('login');
  try {
    // 以前は repo 取得の非 2xx を一律 404 に潰しており、403 / 5xx が「設定なし」に
    // 見えていた（fail-open）。不在と障害を分ける。
    const repo = await syncRepo(c, login);
    if (!repo) return syncMissingResponse(c, 'repo');
    const result = await repoFile(c, login, 'settings.json');
    if (!result) return syncNotFoundResponse(c);
    return c.json({ ...(result.content as object), _sha: result.sha, _branch: repo.default_branch });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// PUT /sync/settings
app.put('/settings', SYNC_BODY_LIMIT, requireJsonBody, validateCSRFToken, async c => {
  const login = c.get('login');
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const { _sha, _branch, ...settings } = body as Record<string, unknown>;
    const branchErr = validateBranch(_branch);
    if (branchErr) return c.json({ error: branchErr }, 400);
    // 防御多層（#469）: 現状 settings.json はグローバル UI 設定（theme/font 等）のみでパス型
    // フィールドを含まないが、将来トップレベル githubRepoPath が同期される場合に備え worker 側でも
    // 検証する（client 検証はブラウザ内で回避可能）。githubRepoPath は本来 per-WorkSettings の
    // フィールドで、ネスト形状（workSettings[].githubRepoPath 等）で同期する経路が追加された際は
    // その形状に対する検証を別途足すこと。検証形状（per-work ネスト）・空値の扱い（フィールド単位 drop・
    // 全体 400 にしない）は docs/security/github-boundary.md §9（#474）で設計済み。in ではなく
    // Object.hasOwn で own property のみ判定
    // （プロトタイプ汚染対策）
    if (Object.hasOwn(settings, 'githubRepoPath')) {
      const rootErr = validateWorkspaceRootPath(settings.githubRepoPath);
      if (rootErr) return c.json({ error: rootErr }, 400);
    }
    const sha = await writeRepoFile(c, login, 'settings.json',
      settings, (_sha as string) || null, 'sync: update settings', _branch as string);
    return c.json({ ok: true, sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// GET /sync/devices — returns devices.json content
app.get('/devices', async c => {
  const login = c.get('login');
  try {
    const repo = await syncRepo(c, login);
    if (!repo) return c.json({ devices: {}, _sha: null, _branch: null });
    const result = await repoFile(c, login, 'devices.json');
    if (!result) return c.json({ devices: {}, _sha: null, _branch: repo.default_branch });
    return c.json({ ...(result.content as object), _sha: result.sha, _branch: repo.default_branch });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// PUT /sync/devices/:id — upsert a device
app.put('/devices/:id', SYNC_BODY_LIMIT, requireJsonBody, validateCSRFToken, async c => {
  const login = c.get('login');
  const id = c.req.param('id');
  if (!FILE_ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const { _branch, ...deviceData } = body as Record<string, unknown>;
    const branchErr = validateBranch(_branch);
    if (branchErr) return c.json({ error: branchErr }, 400);
    const existing = await repoFile(c, login, 'devices.json');
    const current = (existing?.content as { devices?: Record<string, unknown> })?.devices ?? {};
    const next = { ...(existing?.content as object ?? {}), devices: { ...current, [id]: { ...deviceData, id } } };
    const sha = await writeRepoFile(
      c, login, 'devices.json', next,
      existing?.sha ?? null, `sync: update device ${id}`, _branch as string,
    );
    return c.json({ ok: true, sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

// DELETE /sync/devices/:id — remove a device
app.delete('/devices/:id', SYNC_BODY_LIMIT, requireJsonBody, validateCSRFToken, async c => {
  const login = c.get('login');
  const id = c.req.param('id');
  if (!FILE_ID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const { _branch } = body as Record<string, unknown>;
    const branchErr = validateBranch(_branch);
    if (branchErr) return c.json({ error: branchErr }, 400);
    const existing = await repoFile(c, login, 'devices.json');
    if (!existing) return c.json({ ok: true });
    const current = (existing.content as { devices?: Record<string, unknown> })?.devices ?? {};
    const { [id]: _removed, ...rest } = current;
    const sha = await writeRepoFile(
      c, login, 'devices.json', { ...(existing.content as object), devices: rest },
      existing.sha, `sync: remove device ${id}`, _branch as string,
    );
    return c.json({ ok: true, sha });
  } catch (e: unknown) {
    return syncErrorResponse(c, e);
  }
});

export const syncRoutes = app;
