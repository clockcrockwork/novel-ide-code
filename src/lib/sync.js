import { workerFetch, workerFetchWithCSRF } from './workerClient';
import { dbPut, dbGet } from './db';
import { computeCanonicalHash, deriveSyncAction, isValidCanonicalHash, pickGithubCoords } from './sync/identity';
import {
  mergeStructure,
  parseRemoteStructure,
  readBaseStructure,
  foldersArrayToDict,
  foldersDictToArray,
  STRUCTURE_BASE_KEY,
  normalizeLocalParentId,
} from './sync/structure';
import { sanitizeFileName } from './security/validateSafeFileName';
import { validatePulledContent, toSecurityRecord } from './security/validatePulledContent';
import { isValidTimestamp } from './normalizeFileRecord';
import {
  SYNC_ERROR_CODES,
  SyncRequestError,
  SyncAbortError,
  readSyncFailure,
  pickPrimaryCategory,
  syncFailureMessage,
  categorizeThrown,
  logSyncFailure,
  LEGACY_DEFAULT_FORMAT_VERSION,
  FORMAT_CAPABILITY_VERSION,
} from './syncErrors';

const NAME_MAX = 100; // not-a-threshold（ファイル名の最大長）

// files.github は owner/repo/branch/path が canonical、sha は derived（remote concurrency
// state。作品リポジトリ側の blob sha であり別端末では意味を持たない。sync-contract.md §2）。
// push payload・manifest entry・carryOver のいずれからも sha を落とす（契約9）。
// #394 C-1 round2 (S1): sync/identity.js の pickGithubCoords（canonicalSerialize と同じ定義）を
// 再利用する。挙動差: 非文字列フィールドを null に倒す（安全側）。
const githubCoordsOnly = pickGithubCoords;

// #394 C-1 round2 (S2): normalizeFileRecord.js の isValidTimestamp を再利用する（1 箇所に集約）。
const isValidCreatedAt = isValidTimestamp;

// files 配列 → id をキーにした parentId 辞書（Object.create(null)。INVARIANTS #11）。
// mergeStructure の local 入力・init の structure 書き込みの両方で使う。
function buildLocalFileParentIds(files) {
  const dict = Object.create(null);
  for (const f of Array.isArray(files) ? files : []) {
    if (f && typeof f.id === 'string') dict[f.id] = normalizeLocalParentId(f.parentId);
  }
  return dict;
}

// ── Observable sync status ──────────────────────────────────────────────────

// init（初回同期）へ入ってよいのは「remote に manifest が存在しないと確認できた」場合だけ。
// init は local 全ファイルを分類なしで push するため、一時的な取得失敗を不在と誤認すると
// remote の新しい内容を上書きしうる。未知 code・code 不在は init に入らない（fail-closed）。
const INIT_ALLOWED_CODES = new Set([
  SYNC_ERROR_CODES.repoMissing,
  SYNC_ERROR_CODES.manifestMissing,
]);

let _status = {
  isSyncing: false,
  lastSyncedAt: null,
  error: null,
  errorCategory: null,
  progress: null,
};
const _listeners = new Set();

function setStatus(patch) {
  _status = { ..._status, ...patch };
  for (const fn of _listeners) fn({ ..._status });
}

export function onSyncStatusChange(fn) {
  _listeners.add(fn);
  fn({ ..._status });
  return () => _listeners.delete(fn);
}

export function getSyncStatus() {
  return { ..._status };
}

// 起動時に一度だけ meta から lastSyncedAt を読み、リロード後も最終同期時刻を表示する
// （#610 完了条件11）。syncAll が先に成功していれば（_status.lastSyncedAt が既に入っている）
// この古い値で上書きしない（読み込みの解決順に依らず新しい方が勝つ）。
dbGet('meta', 'lastSyncedAt')
  .then((rec) => {
    if (typeof rec?.value === 'number' && _status.lastSyncedAt == null) {
      setStatus({ lastSyncedAt: rec.value });
    }
  })
  .catch(console.warn);

// remote manifest がこの client の capability を超える formatVersion を宣言していると
// syncAll が確認した場合に true になる。syncFile（entity write の単一 choke point）が
// これを見て、syncAll を経由しない呼び出し元（debounce autosave の syncFileSilent・
// conflict 採用時の直接呼び出し）でも一律に write を止める。契約全体・既知の残存窓
// （ページ読み込み直後、一度も syncAll が確認していない間）は
// docs/data-model/sync-contract.md「manifest の formatVersion 契約」を正本とする。
//
// _status.errorCategory では代替できない: syncAll 冒頭の setStatus が呼び出しごとに
// errorCategory を null へ戻すため同期実行中は常に「未検出」に見え、catch の
// setStatus では直近の失敗 category で上書きされるため、無関係な失敗（network 等）が
// protocol 超過の検出結果を消してしまう。
let _protocolUpgradeRequired = false;

// 直近の syncAll が確認した snapshot 世代（#609 A-2）。syncFileSilent（debounce autosave）が
// manifestSha / entry sha を持たずに直接呼ばれても entity write の choke point
// （_manifestSha 必須。下記 syncFile）を満たせるよう、syncAll がこれを更新し
// syncFileSilent が読む。syncAll が一度も成功していない間は null のままで、
// syncFileSilent は通信せず null を返す（best-effort。stale はサイレントに失敗し
// 次回 syncAll が拾う）。
let _snapshotRef = null;

// badge（useSyncPending）が読む、直近の同期が確認した remote canonical hash の写し
// （id → hash）。syncAll が一度も成功していない間は null（呼び出し側は「remote map
// 未取得」として localHash と adoptedHash の不一致だけで pending 判定する。#610）。
export function getSnapshotRemoteHashes() {
  return _snapshotRef?.hashes ?? null;
}

// ── Push a single file to sync repo ────────────────────────────────────────

// throw された値を category 付きの SyncRequestError へ正規化する。workerFetch /
// workerFetchWithCSRF は fetch の拒否を SyncRequestError として throw する契約だが
// （型付け境界は workerClient.js）、万一契約外の型が来ても categorizeThrown に
// category 抽出を委ねて機械的に扱う。expectAbsent の絶対条件（下記 checkAbsence）を
// 「想定外の例外だから素通し」で anythingを一つでも回避させないための正規化。
function toFailure(e, operation) {
  return e instanceof SyncRequestError ? e : new SyncRequestError(categorizeThrown(e), { operation });
}

// remote に entity が存在しないと **明示的な 404 でだけ**確定する。GET が reject した
// 場合・404 以外の応答を返した場合はいずれも absence を証明できていないため、呼び出し側は
// 中止側へ倒す。push 前の不在確認・create PUT 失敗後の再確認の両方から使う共通の判定で、
// 個々の status/category を列挙する方式は取らない（列挙は新しい失敗形（reject 等）を
// 見落とす。#608 A-1 Codex 10周目 P1）。
//   'absent'  — 明示的な 404。create-only 違反ではない（一般の validation failure 等）
//   'present' — 実在が確認できた
//   'unknown' — 確認不能（403 / 5xx / 通信断など）。実在しうるので中止側へ倒す
async function checkAbsence(id, operation) {
  let fr;
  try {
    fr = await workerFetch(`/sync/file/${id}`);
  } catch (e) {
    return { presence: 'unknown', failure: toFailure(e, operation) };
  }
  if (fr.ok) return { presence: 'present', failure: null };
  if (fr.status === 404) return { presence: 'absent', failure: null };
  return { presence: 'unknown', failure: await readSyncFailure(fr, operation) };
}

// expectAbsent: init 経路専用。init は「remote に自分以外の snapshot が無い」ことを確認して
// から全件を分類なしで push するが、その確認から個々の push までの間に別端末が同じ id の
// entity を作る窓が残る。manifest の CAS は index しか守らない（entity write は in-place
// 上書きで世代検査を持たない = #609 の範囲）ため、その窓では別端末の本文が失われ、
// 最後の manifest PUT だけが 409 になる。init では **entity が既にあれば上書きせず中止**する。
//
// internal: runInitSync 自身の entity push だけに使う内部フラグ（pushOneFile 経由で
// { expectAbsent: true, internal: true } として渡す）。true のときだけ _protocolUpgradeRequired
// のチェックを迂回する。debounce autosave（syncFileSilent）・conflict 採用時の直接呼び出しは
// このオプションを渡さない（渡す経路が存在しない）ため、init 中でも常にガードで止まる。
// これにより syncAll は init の間もグローバルフラグを一時的に false へ書き換える必要がなく
// （旧実装はここで競合していた: #609 レビュー指摘）、init の内部 push だけが素通りし、
// 外部からの並行呼び出しは init 中も常にブロックされる。
// entity write は必ず「書く側が読んだ manifest 世代」（manifestSha）に拘束される
// （#609 A-2。契約は docs/data-model/sync-contract.md「entity write の世代拘束と reconcile」
// を正本とする）。呼び出し側は次のいずれかを渡す:
//   - entrySha: manifest entry が持つ blob sha（無ければ null。worker が entry の有無・
//     sha 一致を検査する）
//   - reconcileSha: reconcile（sync_entity_stale / orphan からの復帰・conflict 解決での
//     local 採用）で、live entity の sha を明示的に acknowledge して CAS 書き込みする場合
// 「PUT 前に live GET して sha を取る」経路は廃止した。snapshot（manifest 読み取り時点）が
// 指す sha 以外を使わない。legacy entry（sha を持たない manifest entry）への push は
// entrySha: null を送る（worker が create-only で判定する。#609 round2 F1/F4）。
// legacy entry（canonical hash を持たない manifest entry）の live GET 補完は呼び出し側
// （runSyncPass が呼ぶ resolveClassification）の責務。
// 戻り値: { synced, sha }。sha は書き込み後の新しい entity sha（IDB の files には保存しない
// ＝ derived state。runSyncPass 側が pushManifest 用に別途保持する）。
export async function syncFile(file, branch, {
  manifestSha,
  entrySha = null,
  expectAbsent = false,
  internal = false,
  reconcileSha,
} = {}) {
  // 全 entity write の単一 choke point（_protocolUpgradeRequired の定義コメント参照）。
  // 通信を一切発生させない（remote の状態を理解できない以上、読み取り確認も安全ではない）。
  if (_protocolUpgradeRequired && !internal) {
    throw new SyncAbortError('protocol_upgrade_required', {
      operation: `entity write blocked by protocol upgrade: ${file.id}`,
    });
  }
  if (typeof manifestSha !== 'string' || manifestSha.length === 0) {
    throw new SyncRequestError('internal', {
      operation: `entity write missing manifestSha: ${file.id}`,
    });
  }

  if (expectAbsent) {
    const check = await checkAbsence(file.id, `read file ${file.id}`);
    if (check.presence === 'present') {
      throw new SyncAbortError('workspace_inconsistent', {
        operation: `entity appeared during init: ${file.id}`,
      });
    }
    if (check.presence === 'unknown') {
      // init は「不在を確認できた」ことだけを根拠に上書きなしの create を行う。確認できな
      // かった場合を通常の失敗として扱うと、その id を欠いた manifest が確定し、次回同期の
      // 通常経路が別端末の本文を上書きする。不在確認の失敗は中止扱いにする。
      throw new SyncAbortError(check.failure.category, {
        status: check.failure.status,
        code: check.failure.code,
        operation: `absence check failed during init: ${file.id}`,
      });
    }
    // presence === 'absent': create-only（sha は null のまま）で push する。
  }

  // reconcile は「key が渡されたか」で判定する（値ではない）。呼び出し側は live entity が
  // 見つからなかった場合も `reconcileSha: null` を明示的に渡す契約にしており（#609 round2
  // F3/F4）、`reconcileSha != null` 判定だと null と undefined を区別できず、その場合に
  // `_reconcile: true` を送り損ねる（create-only の明示的な acknowledge にならない）。
  const reconcile = reconcileSha !== undefined;
  const sha = reconcile ? reconcileSha : (entrySha ?? null);

  const payload = {
    id: file.id,
    name: file.name,
    content: file.content,
    github: githubCoordsOnly(file.github),
    // createdAt は epoch ms 数値（#394 契約10）。無効なローカル値は push 時点の
    // Date.now() へ倒す（pull 側は逆に「無効なら local 保持」— parseRemoteFile 参照）。
    createdAt: isValidCreatedAt(file.createdAt) ? file.createdAt : Date.now(),
    updatedAt: new Date(file.updatedAt || Date.now()).toISOString(),
    _sha: sha,
    _manifestSha: manifestSha,
    _branch: branch,
    ...(reconcile ? { _reconcile: true } : {}),
  };

  let r = null;
  let putFailure = null;
  try {
    r = await workerFetchWithCSRF(`/sync/file/${file.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // entity write も checkRemoteFormatVersion（formatVersion ゲート）を通るため
      // capability header を送る（#394 C-0）。省略すると、remote が v3 化した瞬間に
      // 未宣言＝legacy default(2) < 3 でこの client 自身の entity write が 426 になり、
      // 全端末の同期が恒久停止する（docs/data-model/sync-contract.md 参照）。
      formatCapability: true,
    });
  } catch (e) {
    // PUT 自体が reject（通信断等）した場合も、応答が返って !r.ok だった場合と同じ「失敗」
    // として扱う。ここで捕まえず素通しすると、expectAbsent 時に下の再確認を経由しないまま
    // pushOneFile の catch へ落ち、通常の partial failure として握られてしまう。
    putFailure = toFailure(e, `write file ${file.id}`);
  }

  if (r?.ok) {
    // r.json が関数でない最小 mock（テスト double 等）でも壊れないよう try/catch で包む
    // （.catch() チェーンは r.json() 自体が同期的に throw すると効かない）。
    let newSha = null;
    try {
      const body = await r.json();
      if (typeof body?.sha === 'string') newSha = body.sha;
    } catch {
      newSha = null;
    }
    const synced = { ...file, isDirty: false };
    dbPut('files', synced).catch(console.warn);
    return { synced, sha: newSha };
  }

  const failure = putFailure ?? (await readSyncFailure(r, `write file ${file.id}`));

  if (expectAbsent) {
    // 不在確認（GET）と create（PUT）の間にも窓が残る。その間に別端末が同じ id を作ると
    // 別端末の entity が実在するようになる。PUT の失敗理由を conflict / unprocessable
    // （create-only 違反の典型）に限定して再確認を判断すると、429 / 5xx / PUT 自体の
    // reject 等それ以外の理由で失敗した場合に再確認自体が行われず、実在していても
    // 見逃す（#608 A-1 Codex 10周目 P1-2）。**失敗理由を問わず常に再確認**し、
    // absence を明示的な 404 で証明できたときだけ部分失敗として続行する。
    const recheck = await checkAbsence(file.id, `entity presence recheck ${file.id}`);
    if (recheck.presence !== 'absent') {
      throw new SyncAbortError(failure.category, {
        status: failure.status,
        code: failure.code,
        operation: `entity created elsewhere during init: ${file.id}`,
      });
    }
    throw failure;
  }

  // 通常 push（expectAbsent でない）で manifest 世代がずれていた場合、この pass の残り
  // entity write もすべて同じ理由で失敗する。1 ファイルの失敗として積まず pass 全体を
  // 中止し、syncAll に manifest を読み直させて 1 回だけ再試行させる（sync-contract.md 参照）。
  if (failure.code === SYNC_ERROR_CODES.manifestStale) {
    throw new SyncAbortError(failure.category, {
      status: failure.status, code: failure.code, operation: failure.operation,
    });
  }

  throw failure;
}

// 失敗理由を意図的に捨てる版。debounce autosave（AppContext）が使う。直近の syncAll が
// 確認した snapshot（_snapshotRef）を使って entity write の choke point を満たす。
// 未取得（syncAll が一度も成功していない）なら通信せず null を返す（best-effort。stale は
// サイレントに失敗し、次回 syncAll が拾う）。成功したら _snapshotRef.entries を更新し、
// 同じ file への次回 autosave が直近の sha を使えるようにする。
export async function syncFileSilent(file, branch) {
  if (!_snapshotRef) return null;
  try {
    const { synced, sha } = await syncFile(file, branch, {
      manifestSha: _snapshotRef.manifestSha,
      entrySha: _snapshotRef.entries[file.id] ?? null,
    });
    if (sha) _snapshotRef.entries[file.id] = sha;
    return synced;
  } catch {
    return null;
  }
}

// conflict 解決で local を採用する経路（AppContext）専用。manifest / live entity を読み直し、
// live の有無に関わらず常に明示的な acknowledge（_reconcile: true）で書き込む（#609 round2
// F4。worker は reconcile の真正性を検証しない — 同一信頼境界内からの明示 acknowledge として
// 受け入れる）。live entity が 404（remote から消えている）なら `_sha: null` で create-only。
export async function resolveConflictKeepLocal(file, branch) {
  const mr = await workerFetch('/sync/manifest');
  if (!mr.ok) throw await readSyncFailure(mr, 'resolve conflict: read manifest');
  const manifestJson = await mr.json();
  const manifestSha = typeof manifestJson?._sha === 'string' && manifestJson._sha
    ? manifestJson._sha
    : null;
  if (!manifestSha) {
    throw new SyncRequestError('internal', { operation: 'resolve conflict: manifest sha missing' });
  }

  const fr = await workerFetch(`/sync/file/${file.id}`);
  let reconcileSha = null;
  if (fr.ok) {
    const remote = await fr.json();
    if (typeof remote._sha === 'string' && remote._sha) reconcileSha = remote._sha;
  } else if (fr.status !== 404) {
    throw await readSyncFailure(fr, 'resolve conflict: read live entity');
  }

  const { synced, sha } = await syncFile(file, branch, { manifestSha, reconcileSha });
  if (sha && _snapshotRef) _snapshotRef.entries[file.id] = sha;
  await markAdopted(synced);
  return synced;
}

// conflict 解決で local/remote を採用したあと syncState の adoptedHash を更新する（#610）。
// AppContext の resolveConflictLocal（resolveConflictKeepLocal 経由で内部から呼ぶ）・
// resolveConflictRemote・resolveConflictBoth（remote 採用は network を伴わないため直接
// この関数を呼ぶ）が使う、単一の採用処理。hash 計算に失敗しても採用そのものは失敗させない
// （syncState の更新は best-effort。次回同期の legacy 補完が追いつく）。
//
// `_snapshotRef.hashes`（remote 写し）には触れない（#610 round2 F4）: この写しは
// manifest 由来の値だけを持つべきで、ローカルの採用判断（local を保持した／remote を
// 未転送のまま信用した等）を書き込むと、manifest がまだ古い値を指しているのに
// badge が「同期済み」に見えてしまう。keep-local 直後は L===A でも R（manifest）は
// 旧値のまま残るため、badge は次回 syncAll が manifest を書き直すまで「同期待ち」を
// 表示し続ける（この不整合は意図的 — manifest が実際に直るまで正しく pending を保つ）。
export async function markAdopted(file) {
  let hash;
  try {
    hash = await computeCanonicalHash(file);
  } catch {
    return;
  }
  writeAdoptedHash(file.id, hash);
}

// push 用の entity write expected sha。entry.sha が文字列ならそれを使い、無ければ（entry が
// 無い＝create-only、または legacy manifest で sha フィールドを持たない）null を返す。
// **legacy entry を live GET で補完しない**（#609 round2 F1/F4）: worker は legacy entry を
// 素通しせず create-only 経路（実在確認）に倒すため、client が `_sha` を正確に当てる必要が
// 無くなった。実在すれば 409 sync_entity_orphan → reconcile が live を採用/conflict へ倒す。
// これは resolveClassification（下記。canonical hash の legacy 補完）とは無関係 —
// push の CAS token（sha）と分類用の canonical hash（hash）は別の bookkeeping。
function resolveEntrySha(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return typeof entry.sha === 'string' ? entry.sha : null;
}

// syncState（IDB v4。#610）へ adoptedHash を書く。転送を伴わない採用（skip の A 補正・
// push 成功・pull 採用・reconcile 採用）のたびに呼ぶ。dbPut('files', ...) と同様
// fire-and-forget（同期パス自体をブロックしない。失敗は次回同期が再判定するだけで
// データを失わない）。
function writeAdoptedHash(id, hash) {
  dbPut('syncState', { id, adoptedHash: hash, adoptedAt: Date.now() }).catch(console.warn);
}

// ローカル file 一覧の canonical hash をまとめて計算する（#610）。計算に失敗した id は
// failedIds に積む（呼び出し側が fail-closed で扱う。hash 計算失敗の理由は
// identity.js の computeCanonicalHash を正本とする）。
async function computeLocalHashes(files) {
  const hashes = Object.create(null);
  const failedIds = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        hashes[f.id] = await computeCanonicalHash(f);
      } catch {
        failedIds.push(f.id);
      }
    }),
  );
  return { hashes, failedIds };
}

// remote entry の canonical hash を解決し、deriveSyncAction で同期アクションを決める
// （#610 契約1）。entry が hash を持たない、または形式が妥当でない（legacy manifest・
// 改変された値。#610 round2 F2 の isValidCanonicalHash）場合だけ、その entity を live GET
// して 1 回だけ計算する（#625 の legacy 補完と同じ位置の一回限り補完。新しい manifest
// entry には常に妥当な hash が書かれるため、この分岐は徐々に不要になる）。
// entry はあるが entity が無い（drift）場合は「entry 無し」と同じ扱い（remoteHash undefined）
// にして push（create-only）へ倒す。
async function resolveClassification(fileId, entry, localHash, adoptedHash) {
  if (!entry || !isValidCanonicalHash(entry.hash)) {
    if (!entry) return deriveSyncAction({ localHash, remoteHash: undefined, adoptedHash });
    let fr;
    try {
      fr = await workerFetch(`/sync/file/${fileId}`);
    } catch (e) {
      return { failure: toFailure(e, `resolve legacy hash ${fileId}`) };
    }
    if (fr.status === 404) {
      return deriveSyncAction({ localHash, remoteHash: undefined, adoptedHash });
    }
    if (!fr.ok) {
      return { failure: await readSyncFailure(fr, `resolve legacy hash ${fileId}`) };
    }
    const remoteJson = await fr.json();
    const parsed = parseRemoteFile(remoteJson);
    let remoteHash;
    try {
      remoteHash = await computeCanonicalHash(parsed);
    } catch (e) {
      return { failure: toFailure(e, `compute legacy hash ${fileId}`) };
    }
    const liveSha = typeof remoteJson._sha === 'string' ? remoteJson._sha : null;
    return { ...deriveSyncAction({ localHash, remoteHash, adoptedHash }), remoteHash, liveSha };
  }
  return { ...deriveSyncAction({ localHash, remoteHash: entry.hash, adoptedHash }), remoteHash: entry.hash };
}

// github 座標のうち canonical な部分（owner/repo/branch/path）だけを比較する。sha は
// derived state なので比較対象にしない（sync-contract.md §2）。
function sameGithubCoords(a, b) {
  const an = a || null;
  const bn = b || null;
  if (an === bn) return true;
  if (!an || !bn) return false;
  return an.owner === bn.owner && an.repo === bn.repo && an.branch === bn.branch && an.path === bn.path;
}

// entity write が sync_entity_stale / sync_entity_orphan を受けたときの reconcile（#609 A-2）。
// live entity を GET し、canonical フィールド（name / content / github）が local と同一なら
// 書かずに採用する（同一端末の再試行が残した正当な orphan・自分自身の直近の push を
// 恒久的にブロックしないため）。異なれば conflict として扱う（他端末の変更を無検査上書き
// しない）。live GET が 404（stale/orphan の原因〔blob 消失・別端末の orphan〕が既に解消
// されていた）なら、`_reconcile: true, _sha: null` の明示的な acknowledge で create-only
// 書き込みを試み、成功したら採用扱いにする（#609 round2 F3）。
async function reconcileEntityWrite(file, branch, manifestSha) {
  let fr;
  try {
    fr = await workerFetch(`/sync/file/${file.id}`);
  } catch (e) {
    return { outcome: 'failed', failure: toFailure(e, `reconcile fetch ${file.id}`) };
  }
  if (fr.status === 404) {
    try {
      const { synced, sha } = await syncFile(file, branch, { manifestSha, reconcileSha: null });
      return { outcome: 'adopted', synced, sha };
    } catch (e) {
      // manifest 世代がずれていた場合は pass 全体を中止して再試行に乗せる（他の call site と
      // 同じ扱い）。ここで飲み込むと SyncAbortError が握り潰され再試行に乗らない。
      if (e instanceof SyncAbortError) throw e;
      return { outcome: 'failed', failure: toFailure(e, `reconcile create ${file.id}`) };
    }
  }
  if (!fr.ok) {
    return { outcome: 'failed', failure: await readSyncFailure(fr, `reconcile fetch ${file.id}`) };
  }
  const remoteJson = await fr.json();
  const remote = parseRemoteFile(remoteJson);
  const sameContent = remote.name === file.name
    && remote.content === file.content
    && sameGithubCoords(remote.github, file.github);
  if (sameContent) {
    const synced = { ...file, isDirty: false };
    dbPut('files', synced).catch(console.warn);
    const sha = typeof remoteJson._sha === 'string' ? remoteJson._sha : null;
    return { outcome: 'adopted', synced, sha };
  }
  return { outcome: 'conflict', remote };
}

function isReconcilableConflict(failure) {
  return failure?.category === 'conflict'
    && (failure.code === SYNC_ERROR_CODES.entityStale || failure.code === SYNC_ERROR_CODES.entityOrphan);
}

// ── Pure helpers (exported for unit testing) ────────────────────────────────

export function upsertIntoList(list, file) {
  const idx = list.findIndex((f) => f.id === file.id);
  if (idx >= 0) return list.map((f, i) => (i === idx ? { ...f, ...file } : f));
  return [...list, file];
}

export function parseRemoteFile(json) {
  // transport フィールド（`_` で始まる全て。`_sha` / `_branch` / `_manifestSha` /
  // `_reconcile` 等）を一律除去してから IDB へ書く（#609 round2 運用性F1+L1）。旧 worker が
  // 未知フィールドをそのまま entity JSON へ永続化した場合の汚染を吸収する。フィルタは
  // `__proto__`（`_` で始まる）も除外するが、remote 由来の動的キー辞書は念のため
  // null-prototype に正規化する（INVARIANTS #11）。
  const remoteFile = Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(json).filter(([key]) => !key.startsWith('_'))),
  );
  const time = new Date(remoteFile.updatedAt).getTime();
  // remote のファイル名は EXTERNAL。永続化前に必ず sanitize する（#285）
  const name = sanitizeFileName(remoteFile.name, NAME_MAX) || 'ファイル.md';
  // 非文字列 content（壊れた JSON 等）は空文字に正規化し、downstream のクラッシュを防ぐ（#285）
  const content = typeof remoteFile.content === 'string' ? remoteFile.content : '';
  // createdAt は「数値かつ >0」以外は欠落扱いにする（契約10）。updatedAt の NaN→0 fallback
  // とは異なり Date.now() へは倒さない — ここで倒すと呼び出し側（processPull）が
  // 「local を保持すべきか」を判定できなくなる（isValidCreatedAt で local 側と同じ基準を使う）。
  const createdAt = isValidCreatedAt(remoteFile.createdAt) ? remoteFile.createdAt : undefined;
  return {
    ...remoteFile, name, content, createdAt, updatedAt: Number.isNaN(time) ? 0 : time, isDirty: false,
  };
}

// push 完了時、IDB に対して何をすべきかを判定する。syncFile() は戻り値を待たず
// { ...pushedSnapshot, isDirty: false } を dbPut('files', ...) で無条件に書き込み済みのため、
// push 中（往復の間）に対象ファイルが編集・削除されていた場合はその dbPut が古い/誤った
// 内容を書き戻したままになる。currentFile は push 完了時点の files store の値
// （見つからなければ削除されたとみなす）。
//   'delete'  — 往復中に削除された。syncFile の dbPut が復活させたレコードを消す
//   'restore' — 往復中に編集された。syncFile の dbPut が上書きした古い本文を最新版で書き戻す
//   'none'    — 変化なし。syncFile の dbPut がそのまま正で追加の書き込みは不要
export function resolvePushedFileIdbAction(pushedSnapshot, currentFile) {
  if (!currentFile) return { action: 'delete' };
  if (currentFile.updatedAt !== pushedSnapshot.updatedAt) {
    return { action: 'restore', file: currentFile };
  }
  return { action: 'none' };
}

// remote manifest の version フィールドを解釈する。非整数・欠落は「version を書かなかった
// 旧 client」として LEGACY_DEFAULT_FORMAT_VERSION（2）へ倒す。worker 側 parseFormatVersion
// （worker/src/sync.ts）と同じ既定値にしないと、client と worker が異なる version を
// 前提に読み書きし、既存の v2 manifest を境界のどちらかだけが「未知」と誤判定する。
function parseFormatVersion(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : LEGACY_DEFAULT_FORMAT_VERSION;
}

export function buildRemoteMap(json) {
  // formatVersion は v2 固有の形状検証（files 等）より **先に**判定する。v3 以降で files が
  // 削除・配列化されるなど manifest の形状自体を変える場合、先に files 検証を走らせると
  // その検証が corrupt を投げて終わり、呼び出し元（syncAll）の formatVersion 比較・
  // _protocolUpgradeRequired の設定に到達しない。その結果、未知 formatVersion への
  // gate が発火しないまま syncFileSilent 経由の entity write だけが続いてしまう
  // （Codex レビュー指摘）。未知 formatVersion のときは v2 の形状検証を一切行わず、
  // 呼び出し元が formatVersion 比較だけで中止できるようにする。
  const formatVersion = parseFormatVersion(json?.version);
  // client の読み側の停止判定は「この client の現行 capability を超えるか」
  // （FORMAT_CAPABILITY_VERSION）。KNOWN_SAFE_FORMAT_VERSION（無条件許可の安全域上限。
  // worker の checkFormatCapability 早期 return 専用）と混同しない — KNOWN_SAFE は 3 に
  // 上げないため、ここで KNOWN_SAFE のまま判定すると、この client 自身が v3 manifest を
  // 書いた直後に自分の次回読み取りが protocol_upgrade_required で恒久停止する（#394）。
  if (formatVersion > FORMAT_CAPABILITY_VERSION) {
    return {
      branch: json?._branch, manifestSha: json?._sha, formatVersion, fileOrder: [],
      remoteFiles: Object.create(null), rawFolders: undefined,
    };
  }

  // remote manifest は Git 管理の可読ファイルで手編集されうる。files が dict でない場合に
  // Object.keys へ渡すと、文字列のインデックス（'0','1',…）を id として pull しにいき、
  // 全件 404 → 恒久的に snapshot を成立させられない状態になる。形状を検証して弾く。
  // 欠落も「空」と解釈しない。manifest.json が JSON 配列に置き換わる等で files キーごと
  // 消えた場合に空扱いすると、remote が空に見えて全件 push へ倒れ、他端末の entry を
  // 一掃したうえで「同期済み」と表示する。
  const files = json?.files;
  const isDict = files !== null && typeof files === 'object' && !Array.isArray(files);
  if (!isDict) {
    throw new SyncRequestError('corrupt', { operation: 'parse remote manifest files' });
  }
  // #394 C-1 round3 (item13): v3 は worker PUT が folders を dict 必須にする（write-strict。
  // 契約3）ため、この client 自身も他の正規 v3 client も folders 欠落/非 dict の v3 manifest
  // を書けない。v3 を宣言しながら folders が欠落/非 dict なのは手編集等の破損でしか生じない
  // — 「structure unknown（local 保持）」で継続すると、破損した manifest に対して
  // 次に書き戻す際 folders:{} を書いてしまい「全 folder 削除」として他端末へ増幅しうる
  // （敵対的 N-A3 クラス）。files 非 dict と同じ corrupt（fail-closed）にし、この pass では
  // manifest を一切書かない。v2（folders キー自体が無い正規の未移行状態）は対象外
  // （contract2: missing ≠ empty。unknown として local を保持する既存経路を維持する）。
  if (formatVersion >= 3) {
    const rawFolders = json?.folders;
    const foldersIsDict = rawFolders !== null && typeof rawFolders === 'object' && !Array.isArray(rawFolders);
    if (!foldersIsDict) {
      throw new SyncRequestError('corrupt', { operation: 'parse remote manifest folders' });
    }
  }
  // fileOrder は「書くだけで読まれない」フィールドだった（#609 A-2）。形状だけをここで
  // 検証・正規化する（非配列・欠落は空配列、非文字列要素は除外）。**呼び出し元は現時点で
  // この値を消費していない**（sortOrder への配線は表示順の攪乱バグを起こすため revert 済み。
  // 理由・follow-up の設計条件は docs/data-model/sync-contract.md の該当節を正本とする）。
  const rawOrder = json?.fileOrder;
  const fileOrder = Array.isArray(rawOrder) ? rawOrder.filter((id) => typeof id === 'string') : [];
  return {
    branch: json._branch,
    manifestSha: json._sha,
    formatVersion,
    fileOrder,
    // remote 由来の動的キー辞書は null-prototype に正規化する（INVARIANTS #11）。
    // JSON.parse の生オブジェクトのままだと、`__proto__` 等の id で `remoteFiles[id]` が
    // 継承値（Object.prototype）を返し、実在しない entity の manifest entry を合成できる。
    remoteFiles: Object.assign(Object.create(null), files),
    // structure（folders / files[id].parentId）の生値。形状検証・null-prototype 正規化は
    // sync/structure.js の parseRemoteStructure が担う（呼び出し元がそこへ渡す）。
    rawFolders: json?.folders,
  };
}

// 失敗の件数と代表 category から status の error 部分を作る。
//
// 件数は **push 失敗だけでなく pull / 競合取得の失敗も含める**（failureCategories の長さ）。
// push 失敗だけを見ると、pull だけが失敗した回に error=null が入り、前回の lastSyncedAt が
// 緑のまま残って「成功」に見える。実際には snapshot が成立しておらず、以後の変更が
// 他端末へ届かないまま時計だけが止まる。
//
// 文言は件数だけを持つ。失敗の理由は errorCategory 側が持ち、表示（SyncBadge）が
// そこからラベルを決める。文言へ category を埋め込むと同じ事実を 2 箇所で持つことになり、
// 片方だけ更新した不整合（ラベルは競合・文言は障害）が入り込む。
function syncFailureStatus(failureCategories) {
  if (failureCategories.length === 0) return { error: null, errorCategory: null };
  return {
    error: `${failureCategories.length} 件の同期に失敗しました`,
    errorCategory: pickPrimaryCategory(failureCategories),
  };
}

// 進捗表示用の概算件数（#610）。localHashes は computeLocalHashes が事前計算した
// id→hash の写し。entry が妥当な hash（isValidCanonicalHash。#610 round2 F2）を持たない
// （legacy manifest・改変された値）場合は、実際の判定に live GET が要る（runSyncPass 側）
// ため、ここでは保守的に「作業あり」として数える（updatedAt・isDirty は読まない。完了条件1〜3）。
export function countSyncWork(files, remoteFiles, localIds, localHashes = {}) {
  let total = 0;
  for (const f of files) {
    const entry = remoteFiles[f.id];
    if (!entry) {
      total++;
      continue;
    }
    if (!isValidCanonicalHash(entry.hash)) {
      total++;
      continue;
    }
    if (localHashes[f.id] !== entry.hash) total++;
  }
  for (const id of Object.keys(remoteFiles)) {
    if (!localIds.has(id)) total++;
  }
  return total;
}

// ── Async I/O helpers ───────────────────────────────────────────────────────

// 1 ファイルを push し、結果を nextFiles へ反映する。成功時のコールバック呼び出しと
// 失敗時のカウント対象判定は runInitSync / runSyncPass で共通のため、ここに集約する
// （進捗更新の位置は呼び出し側ごとに異なるため含めない）。fileShas は push 成功時の
// 新しい entity sha を id ごとに書き込む（pushManifest の manifest entry 用。呼び出し側が
// 保持するオブジェクトをそのまま渡し、この関数は書き込むだけ）。
// success: 呼び出し側（#610 のハッシュ・syncState 採用）が「本当に成功したか」を
// hasConflict だけでは判定できない（通常失敗も hasConflict:false で返るため）。
async function pushOneFile(f, branch, nextFiles, onPushFile, onConflict, failureCategories, fileShas, options) {
  try {
    const { synced, sha } = await syncFile(f, branch, options);
    if (sha) fileShas[f.id] = sha;
    const updated = upsertIntoList(nextFiles, synced);
    onPushFile?.(f);
    return { nextFiles: updated, hasConflict: false, success: true };
  } catch (e) {
    // init の create-only 前提が崩れた失敗だけは飲み込まない（SyncAbortError のコメント参照）。
    // 呼び出し元（runInitSync）まで送出し、manifest を確定させずに中止する。
    if (e instanceof SyncAbortError) throw e;
    const failure = toFailure(e, `push file ${f.id}`);
    // reconcile は通常 push（expectAbsent でない）にだけ適用する。init の create-only push は
    // 独自の不在再確認（syncFile 内）で同じ安全性を別の形で既に満たしている。
    if (!options?.expectAbsent && isReconcilableConflict(failure)) {
      const result = await reconcileEntityWrite(f, branch, options?.manifestSha);
      if (result.outcome === 'adopted') {
        if (result.sha) fileShas[f.id] = result.sha;
        const updated = upsertIntoList(nextFiles, result.synced);
        onPushFile?.(f);
        return { nextFiles: updated, hasConflict: false, success: true };
      }
      if (result.outcome === 'conflict') {
        onConflict?.({ local: f, remote: result.remote });
        return { nextFiles, hasConflict: true, success: false };
      }
      logSyncFailure(result.failure);
      failureCategories.push(result.failure.category);
      return { nextFiles, hasConflict: false, success: false };
    }
    // 1 ファイルの失敗で同期全体を止めない従来の挙動は維持しつつ、失敗の意味だけ拾う。
    logSyncFailure(e);
    failureCategories.push(categorizeThrown(e));
    return { nextFiles, hasConflict: false, success: false };
  }
}

// pull の部分更新（契約8・9）: payload に無い / device-local なフィールドは local から
// 引き継ぐ。全置換しない。github.sha は別端末では意味を持たない local concurrency state
// なので、remote の canonical 4 フィールド（owner/repo/branch/path）だけを採用し、
// sha は local の値を保持する（消すと PrePushModal の isFirstPush/isRemoteAhead が
// 誤発火する — isFirstPush は `github.sha == null` を「まだ push していない」の判定に使う）。
function mergePulledGithub(localGithub, remoteGithub) {
  const coords = githubCoordsOnly(remoteGithub);
  if (!coords) return localGithub ?? null;
  const localSha = localGithub && typeof localGithub === 'object' ? localGithub.sha : undefined;
  return typeof localSha === 'string' ? { ...coords, sha: localSha } : coords;
}

// createdAt は remote が妥当な値（parseRemoteFile が既に isValidCreatedAt で検証済み）を
// 持たない場合、local の値を保持する（Date.now() へは倒さない。契約10）。
function applyPulledCreatedAt(pulled, localFile) {
  if (typeof pulled.createdAt === 'number') return;
  if (typeof localFile?.createdAt === 'number') pulled.createdAt = localFile.createdAt;
  else delete pulled.createdAt;
}

// #394 C-1 round2 (SP1): parentId は manifest 側（structure）が管轄し、entity payload には
// 含まれない（契約1）ため remote 由来のレコード（parseRemoteFile の出力）は parentId を
// 持たない。この record で IDB を dbPut すると全置換になり、既存の parentId が消える
// （IDB put は部分更新できない）。pull・conflict の remote/both 採用のいずれも、書き込み前に
// 必ず local の parentId を引き継ぐ（契約8: payload に無いフィールドは local から引き継ぐ）。
export function applyLocalParentId(record, localFile) {
  record.parentId = typeof localFile?.parentId === 'string' ? localFile.parentId : null;
}

// success: 呼び出し側（#610 round2 F1）が「本当に成功したか」を判定するための明示フラグ。
// GET が reject（通信断等）した場合も !ok と同じ失敗として扱う（pushOneFile と同じ理由。
// このガードが無かったのが F1 の直接原因: 失敗時にも adoptedHash/manifest hash を
// 書いてしまい、pull できていない内容を「同期済み」と誤認する）。
async function processPull(fileId, nextFiles, onPullFile, failureCategories) {
  let fileR;
  try {
    fileR = await workerFetch(`/sync/file/${fileId}`);
  } catch (e) {
    const failure = toFailure(e, `pull file ${fileId}`);
    logSyncFailure(failure);
    failureCategories.push(failure.category);
    return { nextFiles, sha: null, success: false };
  }
  if (!fileR.ok) {
    // 取得できなかったファイルは nextFiles に入らない = そのまま manifest を push すると
    // remote manifest から entry が消え、全端末から見えなくなる（entity は orphan 化）。
    // 失敗として数え、snapshot を成立させない。
    const failure = await readSyncFailure(fileR, `pull file ${fileId}`);
    logSyncFailure(failure);
    failureCategories.push(failure.category);
    return { nextFiles, sha: null, success: false };
  }
  const remoteJson = await fileR.json();
  const localFile = nextFiles.find((f) => f.id === fileId);
  const pulled = parseRemoteFile(remoteJson);
  // 契約8・9: github.sha は local を保持、createdAt は無効なら local を保持する。
  // parentId は manifest 側（structure）が管轄するためここでは触らない。
  pulled.github = mergePulledGithub(localFile?.github, pulled.github);
  applyPulledCreatedAt(pulled, localFile);
  // SP1: parentId は entity payload に含まれないため、dbPut（全置換）前に local の値を
  // 引き継ぐ（引き継がないと既存の所属が IDB から消える）。
  applyLocalParentId(pulled, localFile);
  // pull 直後に 1 回だけ走査し、結果を file.security として永続化する（#285）。
  // preview / エディタはこのメタデータを参照し、本文を再走査しない。
  // 正規化前の生の content / name を渡し、非文字列・nameChanged を正しく検出する。
  const validation = validatePulledContent(remoteJson.content, remoteJson.name);
  pulled.security = toSecurityRecord(validation);
  // remote は source of truth のため DB へは書き、危険な内容は security flag で制御する。
  await dbPut('files', pulled);
  onPullFile?.(pulled, validation);
  // pull は非破壊（読み取りのみ）なので、entry.sha と不一致でも live sha をそのまま採用する
  // （#609 A-2「pull」契約）。
  const sha = typeof remoteJson._sha === 'string' ? remoteJson._sha : null;
  return { nextFiles: upsertIntoList(nextFiles, pulled), sha, success: true, pulled };
}

async function processConflict(localFile, onConflict, branch, onQuarantine, failureCategories, manifestSha) {
  const fileR = await workerFetch(`/sync/file/${localFile.id}`);
  if (!fileR.ok) {
    // 「競合なし」と報告すると local の内容で manifest が更新され、次回同期で
    // resolveClassification が push と判定して remote の新しい本文を無条件上書きする。
    // 取得できなかった以上、競合の有無は不明。失敗として扱い snapshot を成立させない。
    const failure = await readSyncFailure(fileR, `fetch conflict ${localFile.id}`);
    logSyncFailure(failure);
    failureCategories.push(failure.category);
    return { hasConflict: true };
  }
  const remoteJson = await fileR.json();
  // 競合 remote も EXTERNAL。parseRemoteFile で name sanitize・content 正規化・updatedAt 変換を共通化する。
  const remoteFile = parseRemoteFile(remoteJson);
  // resolveConflictRemote/Both が採用する経路も「pull」と同じ部分更新契約に従う
  // （契約8・9: github.sha / 無効な createdAt は local を保持する）。
  remoteFile.github = mergePulledGithub(localFile.github, remoteFile.github);
  applyPulledCreatedAt(remoteFile, localFile);
  // 本文を 1 回走査して security を付与する（#285）。検証は正規化前の生の値で実施する。
  const validation = validatePulledContent(remoteJson.content, remoteJson.name);
  remoteFile.security = toSecurityRecord(validation);
  // この fetch 自体が live GET なので、直後の quarantine push の entrySha はここで得た
  // live sha を使う（別途 legacy 補完 GET を打たない）。
  const liveSha = typeof remoteJson._sha === 'string' ? remoteJson._sha : null;

  // deny remote は隔離する（#291）。DiffMode / 採用経路に危険コンテンツを渡さず、ローカル版を
  // push して上書きし競合ループを終端する（local dirty work を保持）。
  if (validation.decision === 'deny') {
    // 隔離 push の失敗理由も拾う。捨てると SyncBadge は権限・サイズ超過・一時制限を
    // 表示できず、onQuarantine の汎用文言（次回の同期で再試行）が 413 のような
    // 再試行不能ケースにも出てしまう。
    // #291 の意図どおり明示的な上書きなので reconcileSha（_reconcile: true）で書く
    // （#609 round3 M1）。entrySha（非 reconcile）のままだと legacy entry（sha 無し）で
    // worker が create-only と判定し、既に実在する entity に対して常に 409
    // sync_entity_orphan になり毎回失敗する（回復手段が無い）。
    let pushResult = null;
    try {
      pushResult = await syncFile(localFile, branch, { manifestSha, reconcileSha: liveSha });
    } catch (e) {
      // manifest 世代がずれていた（sync_manifest_stale）場合は他の call site と同じく
      // 握り潰さず再送出し、pass 中止→1 回再試行に乗せる（#609 round2 risk-model）。
      if (e instanceof SyncAbortError) throw e;
      logSyncFailure(e);
      failureCategories.push(categorizeThrown(e));
    }
    // push 失敗時は remote を上書きできていないため成功扱いにせず conflict として残し、
    // manifest push を止める（「ローカル版を保持」表示と remote 実体の乖離を防ぐ）。
    onQuarantine?.(localFile, validation, pushResult != null);
    // 成功時は synced（isDirty:false）を呼び出し側へ返し state/IDB の churn を防ぐ。
    return pushResult
      ? { hasConflict: false, synced: pushResult.synced, sha: pushResult.sha }
      : { hasConflict: true };
  }

  // 非 deny は従来どおり diff 表示・リモート採用に検証済みメタデータを伴わせる。
  onConflict?.({ local: localFile, remote: remoteFile });
  return { hasConflict: true };
}

async function runInitSync({
  files, deviceId, knownBranch: _knownBranch, onBranch, onPushFile, localHashes, folders, structureReady,
}) {
  // init は「remote に自分以外の snapshot が無い」ことを確認して初回書き込みする経路なので、
  // structure についても local が無条件に権威（merge 対象が存在しない）。hydrate 未完了
  // （structureReady=false）なら folders/fileParentIds を書かず、次回の通常同期が
  // remote unknown からの union で回復する（H1 と同じ理由でここでも local を信用しない）。
  const initStructure = structureReady
    ? { folders: foldersArrayToDict(folders), fileParentIds: buildLocalFileParentIds(files) }
    : { folders: Object.create(null), fileParentIds: Object.create(null) };
  const initR = await workerFetchWithCSRF('/sync/init', { method: 'POST' });
  if (!initR.ok) throw await readSyncFailure(initR, 'init sync repo');
  const initData = await initR.json();
  const branch = initData.branch;
  onBranch?.(branch);

  // manifest の write 先は entity を push する **前** に決める。push した後に remote を
  // 読むと、自分が今作った entity のせいで worker の entity 実在確認が必ず true になり、
  // workspace_inconsistent が返って create 分岐へ到達できない（manifest を永久に書けず、
  // 以後すべての端末のすべての同期が同じ code で止まる）。
  let target = await resolveManifestWriteTarget(initData.created === true);

  // manifest がまだ無い場合は、**entity を push する前に空 manifest を確定させる**。
  // 先に entity を push すると、その後の manifest PUT が 429・通信断で失敗したときに
  // 「entity はあるが manifest が無い」状態が残り、次回以降は worker が
  // sync_workspace_inconsistent を返して init に再突入できず恒久停止する。
  // 空 manifest さえあれば、以後は通常同期の経路（remote が空 → 全件 push）で回復できる。
  if (target.create) {
    // E8: entity push 前の create 空 manifest は files:{} folders:{}（isEmptyManifest は
    // files キー数だけを見るため、folders を追加しても壊れないが、この橋渡し manifest は
    // 実 push 前なので実 folders も空のまま書く。本体の folders は下の実 push が書く）。
    const createdSha = await pushManifest([], deviceId, branch, null, {
      create: true, structure: { folders: Object.create(null), fileParentIds: Object.create(null) },
    });
    // 応答から新 SHA を読めなかった場合は remote を読み直して取得する。ここで
    // { sha: null, create: false } にすると、本体の write が expected SHA なしになり
    // create 意図ガードに弾かれて init 自体が失敗する。
    target = createdSha
      ? { sha: createdSha, create: false }
      : await resolveManifestWriteTarget(true);
  }

  const initTotal = files.length;
  let initCurrent = 0;
  const failureCategories = [];
  // remote 由来の動的キー辞書は null-prototype に正規化する（INVARIANTS #11。id は remote
  // manifest 由来のことがあり __proto__ を名乗りうる。#609 round2 運用性 L1）。
  const fileShas = Object.create(null);
  // push に成功した file の canonical hash（#610。manifest entry.hash の入力）。
  const fileHashes = Object.create(null);
  // manifest には **push に成功した entity だけ**を載せる。
  //   - 失敗した entity を載せると、manifest が指すのに remote に存在しない entry ができ、
  //     他端末は毎回その pull に失敗する
  //   - かといって manifest を書かずに終えると、次回以降は entity だけが存在する状態に
  //     なって worker が workspace_inconsistent を返し、init に再突入できず恒久停止する
  // 成功分だけの manifest は remote の実体と一致した snapshot であり、未 push の分は
  // 次回の通常同期（manifest あり経路）が push する。
  let pushedFiles = [];
  if (initTotal > 0) setStatus({ progress: { current: 0, total: initTotal } });
  for (const f of files) {
    // init は create-only で push する（上のコメント参照）。internal: true は
    // syncFile の _protocolUpgradeRequired ガードを迂回する唯一の経路で、この
    // runInitSync 自身の push にしか渡さない（syncFile の定義コメント参照）。
    // manifestSha は target.sha（entity を push する前に確定させた、このタイミングの
    // manifest 世代）を全 push で共有する（#609 A-2）。
    const result = await pushOneFile(f, branch, pushedFiles, onPushFile, undefined, failureCategories, fileShas, {
      expectAbsent: true,
      internal: true,
      manifestSha: target.sha,
    });
    pushedFiles = result.nextFiles;
    if (result.success && typeof localHashes?.[f.id] === 'string') {
      fileHashes[f.id] = localHashes[f.id];
      writeAdoptedHash(f.id, localHashes[f.id]);
    }
    initCurrent++;
    if (initTotal > 0) setStatus({ progress: { current: initCurrent, total: initTotal } });
  }

  const newManifestSha = await pushManifest(
    pushedFiles, deviceId, branch, target.sha,
    { create: target.create, fileShas, fileHashes, structure: initStructure },
  );
  // init が確定させた snapshot を syncFileSilent 用に保持する（#609 A-2）。
  if (newManifestSha) _snapshotRef = { manifestSha: newManifestSha, entries: fileShas, hashes: fileHashes };
  // base 更新は structure が local 権威で書けた（structureReady）ときだけ進める（契約4・D4）。
  if (newManifestSha && structureReady) {
    await writeStructureBase(initStructure).catch(console.warn);
  }
  await upsertDevice(deviceId, branch).catch(logSyncFailure);
  // 失敗が残る回は lastSyncedAt を進めない（未 push の分が残っている）。
  await finishSync(failureCategories, { snapshotCommitted: true });
}

// syncState(STRUCTURE_BASE_KEY) へ「この pass で採用した structure」を書く。base 更新は
// 契約4（(a) local 適用の永続化成功 かつ (b) snapshot 成立）を満たした呼び出し元だけが呼ぶ。
function writeStructureBase({ folders, fileParentIds }) {
  return dbPut('syncState', {
    id: STRUCTURE_BASE_KEY,
    folders: Object.assign(Object.create(null), folders),
    fileParentIds: Object.assign(Object.create(null), fileParentIds),
    updatedAt: Date.now(),
  });
}

// 同期完了時の status 更新。**snapshot が成立した回だけ** lastSyncedAt を進める。
// push 失敗や競合が残る回でも進めると、リロードで error（メモリのみ）が消えたあとに
// 緑の「最終同期 hh:mm」だけが残り、未転送データがあるのに「同期済み」に見える
// （false 同期済み）。sync-contract.md §1 の同期完了の定義に合わせる。
async function finishSync(failureCategories, { snapshotCommitted }) {
  const status = syncFailureStatus(failureCategories);
  if (snapshotCommitted && failureCategories.length === 0) {
    const lastSyncedAt = Date.now();
    await dbPut('meta', { key: 'lastSyncedAt', value: lastSyncedAt });
    setStatus({ isSyncing: false, lastSyncedAt, ...status, progress: null });
    return;
  }
  setStatus({ isSyncing: false, ...status, progress: null });
}

// init 直後・**entity を push する前**の manifest write 先を決める。
// repoCreated: この同期の /sync/init が repo を新規作成したか。
//
// init の前提は「remote に自分以外の snapshot が無い」こと。前提が崩れた状態で local の
// みの一覧を書くと他端末の entry が消えるため、次のどちらかでなければ中止する:
//   - manifest が存在しない（＝新規作成）
//   - repo を今 init が作り、かつ見つかった manifest が **空のまま**（＝init が書いた初期 manifest）
// repoCreated だけを根拠にしないのは、init 直後・再取得までの間に別端末がその空 manifest を
// 基に通常同期を完了しうるため。その manifest は「自分が作った空 manifest」ではない。
async function resolveManifestWriteTarget(repoCreated) {
  const r = await workerFetch('/sync/manifest');
  if (r.ok) {
    const remote = await r.json();
    if (!repoCreated || !isEmptyManifest(remote)) {
      throw new SyncRequestError('workspace_inconsistent', {
        operation: 'manifest advanced during init',
      });
    }
    const sha = remote?._sha ?? null;
    if (sha) return { sha, create: false };
    // manifest はあるのに _sha が無い = expected SHA を得られていない。無条件 create へ
    // 倒すと他端末の snapshot を上書きしうるため止める。
    throw new SyncRequestError('internal', { operation: 'resolve manifest sha after init' });
  }
  const failure = await readSyncFailure(r, 'read manifest after init');
  if (r.status === 404 && INIT_ALLOWED_CODES.has(failure.code)) return { sha: null, create: true };
  throw failure;
}

// init が書いた初期 manifest かどうか。entry を 1 つでも持つ manifest は他端末の
// snapshot でありうるため、init の上書き対象にしない。
function isEmptyManifest(remote) {
  const files = remote?.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return false;
  return Object.keys(files).length === 0;
}

// pull 後の manifest entry.hash / syncState 採用値を、pull した実体から検算する
// （#610 round2 F2）。manifest entry の主張値（entry.hash）は信用しない —
// 改変された manifest・取りこぼしを検出するため、常に pull した実体（parsed）から
// computeCanonicalHash で計算する。検算自体が失敗した場合は pull 失敗として扱う
// （#610 round4 N1）: failureCategories に 'internal' を積んで fail-closed にする —
// hash が抜けたまま manifest を書く・adoptedHash を進めると、実際には検証できていない
// pull 結果を「採用済み」として扱ってしまう（snapshot を成立させない）。
async function computeVerifiedHash(pulled, failureCategories) {
  try {
    return await computeCanonicalHash(pulled);
  } catch {
    failureCategories.push('internal');
    return null;
  }
}

async function runSyncPass({
  files,
  remoteFiles,
  localIds,
  branch,
  nextFiles,
  total,
  manifestSha,
  onPullFile,
  onConflict,
  onQuarantine,
  onPushFile,
  quarantinedIds = [],
  localHashes = {},
}) {
  let hasConflict = false;
  let current = 0;
  const failureCategories = [];
  // push/pull/conflict/skip-legacy-backfill が確認した entity sha（id ごと）。
  // pushManifest の manifest entry `files[id].sha` の入力になる（#609 A-2）。remote 由来の
  // 動的キー辞書は null-prototype に正規化する（INVARIANTS #11。#609 round2 運用性 L1）。
  const fileShas = Object.create(null);
  // 同上、canonical hash（`files[id].hash`。#610）。
  const fileHashes = Object.create(null);

  for (const f of files) {
    const localHash = localHashes[f.id];
    if (typeof localHash !== 'string') {
      // ローカル hash 計算に失敗した file は分類できない。fail-closed で失敗として数え、
      // 他の file の処理は続ける（sync-contract.md「hash 計算失敗」）。
      failureCategories.push('internal');
      current++;
      if (total > 0) setStatus({ progress: { current, total } });
      continue;
    }
    const entry = remoteFiles[f.id];
    const adoptedRec = await dbGet('syncState', f.id).catch(() => null);
    const adoptedHash = typeof adoptedRec?.adoptedHash === 'string' ? adoptedRec.adoptedHash : undefined;
    const resolved = await resolveClassification(f.id, entry, localHash, adoptedHash);
    if (resolved.failure) {
      logSyncFailure(resolved.failure);
      failureCategories.push(resolved.failure.category);
      current++;
      if (total > 0) setStatus({ progress: { current, total } });
      continue;
    }
    const { action, adopt, remoteHash, liveSha } = resolved;

    if (action === 'push') {
      // legacy entry（sha 無し）は live GET せず null を送る（#609 round2 F1/F4。
      // resolveEntrySha 定義コメント参照）。
      const result = await pushOneFile(f, branch, nextFiles, onPushFile, onConflict, failureCategories, fileShas, {
        manifestSha, entrySha: resolveEntrySha(entry),
      });
      nextFiles = result.nextFiles;
      if (result.hasConflict) {
        hasConflict = true;
      } else if (result.success) {
        fileHashes[f.id] = localHash;
        writeAdoptedHash(f.id, localHash);
      }
    } else if (action === 'pull') {
      const result = await processPull(f.id, nextFiles, onPullFile, failureCategories);
      nextFiles = result.nextFiles;
      // pull が失敗（GET !ok / 例外）した file は syncState/manifest hash を書かない
      // （#610 round2 F1）。push/conflict の成功分岐と同じく、成功時のみ採用する。
      if (result.success) {
        if (result.sha) fileShas[f.id] = result.sha;
        // manifest entry の主張値（remoteHash/entry.hash）は信用せず、pull した実体から
        // 検算する（#610 round2 F2）。
        const verifiedHash = await computeVerifiedHash(result.pulled, failureCategories);
        if (verifiedHash) {
          fileHashes[f.id] = verifiedHash;
          writeAdoptedHash(f.id, verifiedHash);
        }
      }
    } else if (action === 'conflict') {
      const res = await processConflict(f, onConflict, branch, onQuarantine, failureCategories, manifestSha);
      if (res.hasConflict) {
        hasConflict = true;
      } else if (res.synced) {
        nextFiles = upsertIntoList(nextFiles, res.synced);
        if (res.sha) fileShas[f.id] = res.sha;
        // deny quarantine push（local を採用して上書き）の成功経路。remote は local と
        // 一致した状態になったので localHash を採用する。
        fileHashes[f.id] = localHash;
        writeAdoptedHash(f.id, localHash);
      }
    } else {
      // skip: 転送は不要。legacy entry（hash 未記録・形式が妥当でない値。#610 round2 F2）は
      // resolveClassification が既に補完済み（remoteHash・liveSha）。次回の manifest に
      // hash・sha を載せる。entry.hash の妥当性は resolveClassification と同じ
      // isValidCanonicalHash で判定する（"0" 等の壊れた値を誤って書き戻さない）。
      if (isValidCanonicalHash(entry?.hash)) {
        fileHashes[f.id] = entry.hash;
      } else if (remoteHash) {
        fileHashes[f.id] = remoteHash;
      }
      // liveSha は legacy hash 解決のために行った live GET から得た最新の sha（entry.sha は
      // 古いままのことがある — 例: entry.sha はあるが entry.hash が無い legacy entry で、
      // その entity が別経路（reconcile 等）で既に更新済みのケース）。liveSha を優先する。
      const entrySha = resolveEntrySha(entry);
      if (liveSha) fileShas[f.id] = liveSha;
      else if (entrySha) fileShas[f.id] = entrySha;
      if (adopt) writeAdoptedHash(f.id, adopt);
      continue; // progress は変化しない
    }
    current++;
    if (total > 0) setStatus({ progress: { current, total } });
  }

  for (const id of Object.keys(remoteFiles)) {
    if (localIds.has(id)) continue;
    const result = await processPull(id, nextFiles, onPullFile, failureCategories);
    nextFiles = result.nextFiles;
    if (result.success) {
      if (result.sha) fileShas[id] = result.sha;
      const hash = await computeVerifiedHash(result.pulled, failureCategories);
      if (hash) fileHashes[id] = hash;
    }
    current++;
    if (total > 0) setStatus({ progress: { current, total } });
  }

  // 隔離ファイルは localIds に含めて re-pull churn を防ぐが、remote が更新されていれば
  // 再取得・再検証して復帰できるようにする（#291 復帰経路）。安全な内容に直っていれば
  // onPullFile 側で active リストへ戻り、隔離が解除される。
  // ローカル record の updatedAt 取得（dbGet）は並列化し、再取得対象だけ順次 pull する。
  const recoveryChecks = await Promise.all(
    quarantinedIds.map(async (id) => {
      const remoteMeta = remoteFiles[id];
      if (!remoteMeta) return null;
      const localRec = await dbGet('files', id).catch(() => null);
      const remoteAt = new Date(remoteMeta.updatedAt).getTime();
      const localAt = localRec?.updatedAt || 0;
      if (Number.isNaN(remoteAt) || remoteAt <= localAt) return null;
      return id;
    }),
  );
  for (const id of recoveryChecks) {
    if (id) {
      const result = await processPull(id, nextFiles, onPullFile, failureCategories);
      nextFiles = result.nextFiles;
      if (result.success) {
        if (result.sha) fileShas[id] = result.sha;
        const hash = await computeVerifiedHash(result.pulled, failureCategories);
        if (hash) fileHashes[id] = hash;
      }
    }
  }

  return { nextFiles, hasConflict, failureCategories, fileShas, fileHashes };
}

// ── Full sync ───────────────────────────────────────────────────────────────
// Compares local files with remote manifest, pulls/pushes as needed.
// Callbacks:
//   onPullFile(file) — called when a remote file is pulled into IDB
//   onConflict({ local, remote }) — local / remote / adopted の canonical hash が
//     いずれも不一致（方向不明）のとき。updatedAt は使わない
//   onPushFile(originalFile) — called every time a push succeeds, including the first-sync
//     (manifest 404 → runInitSync) path. Not limited to the normal diff pass.

export async function syncAll({
  files,
  deviceId,
  branch: knownBranch,
  onPullFile,
  onConflict,
  onQuarantine,
  onPushFile,
  onBranch,
  quarantinedIds = [],
  // structure（folders / files[id].parentId）は folders ストアと files/folders 両方の
  // hydrate 完了フラグを追加で受け取る（#394 契約7）。呼び出し側（AppContext）が省略した
  // 場合（既存の呼び出し・テスト）は structureReady=false になり、structure の
  // merge・適用・base 更新を一切行わない（既存の file 同期挙動は変えない）。
  folders = [],
  filesLoaded = false,
  foldersLoaded = false,
  onApplyStructure,
}) {
  if (_status.isSyncing) return;
  setStatus({ isSyncing: true, error: null, errorCategory: null });

  const structureReady = Boolean(filesLoaded && foldersLoaded);
  const args = {
    files, deviceId, knownBranch, onPullFile, onConflict, onQuarantine, onPushFile, onBranch, quarantinedIds,
    folders, structureReady, onApplyStructure,
  };
  try {
    try {
      await runSyncCycle(args);
    } catch (e) {
      // manifest 世代がこの pass の途中で進んでいた（別端末が snapshot を確定・
      // formatVersion を引き上げた等）。manifest を読み直して 1 回だけ再試行する
      // （sync-contract.md「entity write の世代拘束と reconcile」）。それでも stale
      // なら通常の失敗処理（下の catch）へ落ちて conflict category で終了する。
      if (e instanceof SyncRequestError && e.code === SYNC_ERROR_CODES.manifestStale) {
        await runSyncCycle(args);
      } else {
        throw e;
      }
    }
  } catch (e) {
    // どの操作で失敗したかは表示に出さず診断ログへ残す。
    logSyncFailure(e);
    // typed でない失敗も category へ落とし、文言は catalog から引く。e.message をそのまま
    // 出すと `Failed to fetch` 等のブラウザ既定英文が badge に載る。
    const category = categorizeThrown(e);
    // manifest read 時点では既知安全域内でも、この同期の途中（他端末が並行して formatVersion
    // を引き上げた・最終 manifest PUT が worker の checkFormatCapability に弾かれた 等）で
    // protocol_upgrade_required が返ることがある。その場合もラッチしないと、以後の
    // syncFile 呼び出しが未知 formatVersion のまま素通りしてしまう（Codex レビュー指摘）。
    if (category === 'protocol_upgrade_required') {
      _protocolUpgradeRequired = true;
    }
    setStatus({
      isSyncing: false,
      error: e instanceof SyncRequestError ? e.message : syncFailureMessage(category),
      errorCategory: category,
      progress: null,
    });
  }
}

// structure（folders / files[id].parentId）の merge・適用（契約4・7。runSyncCycle から
// 抽出。複雑度を下げるための分割）。hydrate 未完了（structureReady=false）なら unknown
// として扱い、削除判定・適用・base 更新を行わない。manifest には remote の現在値を
// そのまま carry over する（H1: local を「全削除」と誤判定して remote の folders を
// 消さない。folders を空で書くことはしない）。
//
// #394 C-1 round2 (SP2/item6) → round3 (item13) で確定: remoteStructure.known=false に
// なるのは「formatVersion<3 と解釈された」場合だけ（v3 を宣言しながら folders が欠落/非
// dict の manifest は buildRemoteMap が corrupt として先に fail-closed にするため。
// worker PUT が v3 write で folders を dict 必須にする。契約3）。この「formatVersion<3」は
// 広義の「v2」だが、次の具体例をすべて含む（round5 で明確化）:
//   - 素直な v2（`version` フィールドが無い、または整数 2）。folders キー自体が無い。
//   - `version` が非整数（例: 文字列 `"3"`）で `parseFormatVersion` が
//     LEGACY_DEFAULT_FORMAT_VERSION（2）へ倒したもの。folders が実際には妥当な dict を
//     持っていても、formatVersion の時点で known=false になる。
//   - v2 へ rollback したが `folders` dict が残存している manifest（folders の中身は
//     無視され known=false のまま扱われる）。
// いずれの場合も folders キーを書かず、version も remote の値のまま維持する（worker PUT は
// version<=KNOWN_SAFE では folders 必須ではない。この client が v3 を宣言していないため
// 「v3 化した瞬間に folders を落とした」にならない）。
function structureForUnknownRemote(remoteStructure) {
  // round5 (item19): manifest write は既存ファイルの完全上書きのため、folders キーを省略
  // すると remote に既に存在していた（この client には解釈できない）folders の生値も
  // 一緒に消える。rawFolders が存在する（manifest に folders キー自体はあった）場合は
  // 生のまま carryOver し、キー自体が無かった場合だけ省略する（omitFolders）。
  const hasRawFolders = remoteStructure.rawFolders !== undefined;
  return {
    folders: Object.create(null),
    fileParentIds: Object.create(null),
    omitFolders: !hasRawFolders,
    rawFoldersOverride: hasRawFolders ? remoteStructure.rawFolders : undefined,
    versionOverride: remoteStructure.formatVersion,
  };
}

async function resolveStructureForPass({ structureReady, folders, files, remoteStructure, onApplyStructure }) {
  // item6a/item9: remote の dict の中で「不明」だった folder entry（不正 value・ID_RE 不適合
  // key）は、merge の内外を問わず常に生のまま carry over する（削除として伝搬させない）。
  const malformedFolderRaw = remoteStructure.known ? remoteStructure.malformedFolderRaw : Object.create(null);

  let structureForManifest = {
    ...(remoteStructure.known
      ? { folders: remoteStructure.folders, fileParentIds: remoteStructure.fileParentIds }
      : structureForUnknownRemote(remoteStructure)),
    malformedFolderRaw,
  };
  let structureApplyFailed = false;
  let structureBaseToWrite = null;
  if (!structureReady) {
    return { structureForManifest, structureApplyFailed, structureBaseToWrite };
  }

  // F2 (round5): remote が structure を表現できない（unknown）かつ local にも folder が
  // 1 つも無い場合（新規インストール・IDB クリア後等）、これは missing ≠ empty（契約2）の
  // 「local もまだ何も知らない」ケースであり、remote の実際の削除ではない。このまま下の
  // 通常 merge/適用へ進むと、空の local を union した結果（= 空）を v3 として書き戻し、
  // remote の既存 folders を消してしまう（他端末が次に読むと「全 folder 削除」として
  // 伝搬する。実測）。structureForManifest はここで確定させた unknown 用の値（omit または
  // 生 carryOver）のまま返し、後続のどの分岐でも上書きしない。base も進めない。
  // local に folder が 1 つでもあれば、E1（v2→v3 初回移行）として下の通常 merge へ進む。
  if (!remoteStructure.known && !(Array.isArray(folders) && folders.length > 0)) {
    return { structureForManifest, structureApplyFailed, structureBaseToWrite: null };
  }

  const baseRecord = await dbGet('syncState', STRUCTURE_BASE_KEY).catch(() => null);
  const base = readBaseStructure(baseRecord);
  const localStructure = { folders: foldersArrayToDict(folders), fileParentIds: buildLocalFileParentIds(files) };
  const localFileIds = new Set(files.map((f) => f.id));
  const merged = mergeStructure({ base, local: localStructure, remote: remoteStructure, localFileIds });

  if (!onApplyStructure) {
    // callback 無し（呼び出し側が structure 適用を実装していない）でも merge 結果自体は
    // manifest へ反映する（テスト double 等、適用しない前提の呼び出しを許容する）。
    // R-1: ただし local へ適用していないため base は進めない（契約4(a): base 更新は
    // local 適用の永続化成功が前提。unknown と同じ扱いにする）。
    structureForManifest = { folders: merged.folders, fileParentIds: merged.fileParentIds, malformedFolderRaw };
    return { structureForManifest, structureApplyFailed, structureBaseToWrite: null };
  }

  try {
    const applied = await onApplyStructure({
      folders: foldersDictToArray(merged.folders),
      fileParentIds: merged.fileParentIds,
      deletedFolderIds: merged.deletedFolderIds,
      // round5 (F1): merge の local 入力として使った snapshot をそのまま渡す。適用側
      // （applyStructure.js）はこの snapshot とライブ値を突き合わせ、同期パス開始後に
      // ユーザーが変更したレコードを保護する（巻き戻し・上書きの防止）。
      localSnapshot: localStructure,
    });
    if (!applied || applied.ok === false) {
      // D5: structure の local 適用（IDB）失敗は failure に積み、snapshot を不成立に
      // する（base も進まない）。
      structureApplyFailed = true;
    } else {
      // 適用側（AppContext）が repairParentReferences 後の最終値を正とする（適用結果と
      // 書き込む値を一致させる）。
      structureForManifest = {
        folders: Array.isArray(applied.folders) ? foldersArrayToDict(applied.folders) : merged.folders,
        fileParentIds: applied.fileParentIds ?? merged.fileParentIds,
        malformedFolderRaw,
      };
      structureBaseToWrite = structureForManifest;
    }
  } catch (e) {
    console.warn('[sync] structure 適用に失敗', e);
    structureApplyFailed = true;
  }
  return { structureForManifest, structureApplyFailed, structureBaseToWrite };
}

// syncAll の本体（1 回分の manifest 読み取り〜snapshot commit）。manifest 世代が pass の
// 途中でずれた（sync_manifest_stale）場合に syncAll が 1 回だけ呼び直せるよう分離した
// （#609 A-2）。isSyncing/setStatus の開始処理は呼び出し元（syncAll）が行う。
async function runSyncCycle({
  files, deviceId, knownBranch, onPullFile, onConflict, onQuarantine, onPushFile, onBranch, quarantinedIds,
  folders, structureReady, onApplyStructure,
}) {
  let nextFiles = [...files];
  // ローカル file の canonical hash（#610）。同期判定の一次入力（updatedAt・isDirty は
  // 読まない）。hash 計算に失敗した file は runSyncPass 側が fail-closed で数える。
  const { hashes: localHashes } = await computeLocalHashes(files);
  const mr = await workerFetch('/sync/manifest');

  if (!mr.ok) {
    const failure = await readSyncFailure(mr, 'read manifest');
    // remote に manifest が「無い」と確定した場合のみ init。403 / 5xx / 未知 code の
    // 404 では init に入らず、失敗として報告する（誤 init は remote の上書きになる）。
    if (mr.status === 404 && INIT_ALLOWED_CODES.has(failure.code)) {
      // manifest が確認できない（repo 未作成／manifest 未作成）時点では formatVersion の
      // 衝突は起こりようがない。ただし runInitSync 自身の entity push は syncFile の
      // 単一 choke point を通るため、グローバルフラグが立っていれば通常はここでも
      // ブロックされてしまう（Codex レビュー指摘・P2）。
      //
      // 以前はこれを「グローバルフラグを一時的に解除→init 失敗時に復元」で解いていたが、
      // 解除している間は debounce autosave 等の外部呼び出し（syncFileSilent）も無防備に
      // なる並行 write の窓が生じていた（Codex レビュー指摘。src/lib/sync.js#636 スレッド）。
      // 代わりに runInitSync 自身の push だけへ internal: true を渡し（pushOneFile 呼び出し
      // 側参照）、グローバルフラグは一切書き換えない。これにより:
      //   - init 自身の push は internal フラグでガードを迂回でき、init は実行できる
      //   - 外部からの並行呼び出しは全 write 中で唯一グローバルフラグの実際の値を見るため、
      //     init の最中でも変わらずブロックされ続ける（フラグを false にしていないため）
      // init が成功したら、この回で自分が FORMAT_CAPABILITY_VERSION（この client の現行
      // version）の manifest を書いた ＝ remote はこの client が理解できる状態にあると
      // 確定するため、ここで初めてフラグを解除する。
      // init が失敗した場合はフラグを一切変更していないため、restore は不要。
      await runInitSync({
        files, deviceId, knownBranch, onBranch, onPushFile, localHashes, folders, structureReady,
      });
      _protocolUpgradeRequired = false;
      return;
    }
    throw failure;
  }

  const { branch: remoteBranch, manifestSha, remoteFiles, formatVersion, rawFolders } =
    buildRemoteMap(await mr.json());

  // client の停止判定は「この client の現行 capability を超えるか」（FORMAT_CAPABILITY_VERSION）。
  // KNOWN_SAFE_FORMAT_VERSION（worker の無条件許可域。3 に上げない）のままだと、この
  // client 自身が v3 manifest を書いた直後の次回読み取りで恒久的に停止する（#394）。
  // countSyncWork・runSyncPass・pushManifest のいずれにも到達させず全同期を停止する
  // （契約は docs/data-model/sync-contract.md 参照）。
  if (formatVersion > FORMAT_CAPABILITY_VERSION) {
    _protocolUpgradeRequired = true;
    throw new SyncRequestError('protocol_upgrade_required', { operation: 'read manifest' });
  }
  // remote が既知安全域に戻っていれば解除する（手編集の巻き戻し・v3 デプロイのロールバック等）。
  _protocolUpgradeRequired = false;

  // remote structure（folders / files[id].parentId）を読む。missing ≠ empty（契約2）:
  // known=false（v≤2・folders 非 dict）のときは呼び出し側が local を保持する。
  const remoteStructure = parseRemoteStructure({ formatVersion, rawFolders, remoteFiles });

  // この同期が確認した snapshot 世代を保持する（debounce autosave の syncFileSilent 用。
  // #609 A-2）。entries は entry.sha を持つものだけ（legacy entry は skip/push 対象なら
  // runSyncPass 内の resolveClassification が pass 中に個別補完する。push 対象は null を
  // 送るため補完しない）。hashes は同様に entry.hash を持つものだけ（#610。badge の
  // useSyncPending が getSnapshotRemoteHashes() で読む）。
  _snapshotRef = {
    manifestSha,
    // remote 由来の動的キー辞書は null-prototype に正規化する（INVARIANTS #11。
    // remoteFiles の id は __proto__ を own key として持ちうるため、
    // Object.fromEntries を素通しすると prototype pollution になる）。
    entries: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(remoteFiles)
          .filter(([, entry]) => typeof entry?.sha === 'string')
          .map(([id, entry]) => [id, entry.sha]),
      ),
    ),
    hashes: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(remoteFiles)
          .filter(([, entry]) => isValidCanonicalHash(entry?.hash))
          .map(([id, entry]) => [id, entry.hash]),
      ),
    ),
  };

  const branch = remoteBranch || knownBranch;
  if (branch) onBranch?.(branch);

  // 隔離ファイル（active リスト外）も既知 id として扱い、毎回 re-pull される churn を防ぐ（#291）。
  const localIds = new Set([...files.map((f) => f.id), ...quarantinedIds]);
  const total = countSyncWork(files, remoteFiles, localIds, localHashes);
  if (total > 0) setStatus({ progress: { current: 0, total } });

  const result = await runSyncPass({
    files,
    remoteFiles,
    localIds,
    branch,
    nextFiles,
    total,
    manifestSha,
    onPullFile,
    onConflict,
    onQuarantine,
    onPushFile,
    quarantinedIds,
    localHashes,
  });
  nextFiles = result.nextFiles;

  const {
    structureForManifest, structureApplyFailed, structureBaseToWrite,
  } = await resolveStructureForPass({ structureReady, folders, files, remoteStructure, onApplyStructure });
  // 他の failure と同じ経路（syncFailureStatus）で利用者に見える error にする。conflict と
  // 異なり structure 適用失敗には別の UI 通知チャンネル（onConflict 等）が無いため、ここで
  // 積まないと commit=false だけがサイレントに起き、利用者は何も気づけない。
  if (structureApplyFailed) result.failureCategories.push('internal');

  // snapshot は全 entity の転送が成功した回だけ成立させる（sync-contract.md §1）。
  // structure の local 適用（IDB）失敗も snapshot を不成立にする（契約4・D5）。
  // 失敗を含む nextFiles で manifest を push すると、push できなかった版や取得できな
  // かった entry を指す（あるいは落とした）snapshot が成立してしまう。
  const commit = !result.hasConflict && result.failureCategories.length === 0;
  // 隔離ファイル（#291）は files / nextFiles のどちらにも入らないため、そのまま manifest を
  // 作ると「完全成功」の snapshot から entry が消え、全端末のファイル一覧から見えなくなる
  // （entity は orphan として残る）。remote manifest の既存 entry を引き継ぐ。
  // remote 由来の entry をそのまま書き戻さない。entry.id は remote が key と独立に
  // 決められるため、無検証で使うと隔離とは無関係のファイルの entry を上書きできる
  // （しかも自分で書き戻すので汚染が永続化する）。**キーは隔離 id 側を正**とし、
  // 既知フィールドだけを取り出して再構築する。
  const carryOver = quarantinedIds
    .filter((id) => Object.hasOwn(remoteFiles, id))
    .map((id) => [id, remoteFiles[id]])
    .filter(([, entry]) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
  if (commit) {
    const newManifestSha = await pushManifest(
      nextFiles, deviceId, branch, manifestSha,
      { carryOver, fileShas: result.fileShas, fileHashes: result.fileHashes, structure: structureForManifest },
    );
    // base 更新は (a) structure の local 適用が永続化成功 かつ (b) snapshot 成立
    // （既存 commit 条件）の両方を満たしたときだけ進める（契約4・D4）。
    if (newManifestSha && structureReady && structureBaseToWrite) {
      await writeStructureBase(structureBaseToWrite).catch(console.warn);
    }
    // snapshot が成立したら _snapshotRef もこの pass の結果へ進める（syncFileSilent が
    // 次の syncAll を待たず新しい世代を使えるようにする）。
    if (newManifestSha) {
      // 動的キー辞書は null-prototype を維持する（INVARIANTS #11。#609 round3 L2）。
      // spread（`{ ...a, ...b }`）は plain object に戻ってしまう。
      _snapshotRef = {
        manifestSha: newManifestSha,
        entries: Object.assign(Object.create(null), _snapshotRef.entries, result.fileShas),
        hashes: Object.assign(Object.create(null), _snapshotRef.hashes, result.fileHashes),
      };
    }
  }
  await upsertDevice(deviceId, branch).catch(logSyncFailure);
  await finishSync(result.failureCategories, { snapshotCommitted: commit });
}

async function upsertDevice(deviceId, branch) {
  const payload = {
    id: deviceId,
    name: navigator.userAgent.slice(0, 80),
    lastSeenAt: new Date().toISOString(),
    platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
    _branch: branch,
  };
  const r = await workerFetchWithCSRF(`/sync/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw await readSyncFailure(r, 'upsert device');
}

// sha なしの manifest write は「remote に manifest が無いことを確認した初回作成」だけに
// 許す。expected SHA なしの無条件書き込み経路を構造的に塞ぐため、create 意図を明示させる
// （GitHub 側も sha 省略時は create のみを受け付けるが、client 側で先に閉じる）。
async function pushManifest(
  files, deviceId, branch, sha,
  { create = false, carryOver = [], fileShas = {}, fileHashes = {}, structure = null } = {},
) {
  // structure（folders / files[id].parentId）。呼び出し元が省略した場合（呼ばない経路が
  // 無いはずだが防御的に）は空 dict — folders を書かない経路を新設しないための既定値。
  const structureFolders = structure?.folders ?? Object.create(null);
  const structureFileParentIds = structure?.fileParentIds ?? Object.create(null);
  // #394 C-1 round2 item6/item9: remote の dict の中で「不明」だった folder entry（不正
  // value・ID_RE 不適合 key）は生のまま carry over する（削除として伝搬させない）。
  const malformedFolderRaw = structure?.malformedFolderRaw ?? Object.create(null);
  // item6: remote が structure を表現できず（v2）、この pass も判定できない
  // （!structureReady）場合は folders キー自体を書かず、version も remote の値を維持する
  // （E8 の逆側 — この client 自身が folders を落とす経路を新設しない）。
  const omitFolders = structure?.omitFolders === true;
  // item19 (round5): manifest write は完全上書きのため、remote に既に存在した（この
  // client には解釈できない）folders の生値は、省略せず verbatim で carry over する
  // （structureForUnknownRemote が rawFolders 存在時に設定する）。
  const rawFoldersOverride = structure?.rawFoldersOverride;
  const versionToWrite = typeof structure?.versionOverride === 'number'
    ? structure.versionOverride
    : FORMAT_CAPABILITY_VERSION;
  // 引き継ぐ entry は「隔離 id をキーに、既知フィールドだけ」を再構築する。sha / hash は
  // 文字列のときだけ引き継ぐ（#609 A-2・#610。壊れた値を manifest entry へ伝播させない）。
  // github は canonical 4 フィールドのみ（sha は device-local。契約9）。
  const localIds = new Set(files.map((f) => f.id));
  const carried = carryOver
    .filter(([id]) => !localIds.has(id))
    .map(([id, entry]) => [
      id,
      {
        id,
        name: typeof entry.name === 'string' ? entry.name : id,
        updatedAt:
          typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
        github: githubCoordsOnly(entry.github),
        ...(typeof entry.sha === 'string' ? { sha: entry.sha } : {}),
        ...(isValidCanonicalHash(entry.hash) ? { hash: entry.hash } : {}),
        // B9: quarantine 由来の entry は merge 対象外として structure の値をそのまま
        // carry over する（mergeStructure が既に remote/base から引き継ぎ済み）。
        ...(Object.hasOwn(structureFileParentIds, id) ? { parentId: structureFileParentIds[id] } : {}),
      },
    ]);
  const carriedIds = carried.map(([id]) => id);
  const hasExpectedSha = typeof sha === 'string' && sha.length > 0;
  if (!hasExpectedSha && !create) {
    throw new SyncRequestError('internal', { operation: 'push manifest without expected sha' });
  }
  const manifest = {
    // client が書く version は現行 capability（#394 契約12。KNOWN_SAFE_FORMAT_VERSION は
    // 3 に上げない — worker の無条件許可域専用の別定数）。item6: structure が unknown で
    // v2 のまま維持する回は versionToWrite が remote の値になる。
    version: versionToWrite,
    updatedAt: new Date().toISOString(),
    deviceId,
    fileOrder: [...files.map((f) => f.id), ...carriedIds],
    // folders dict（#394。存在の正はこの dict のみ。IDB / remote 由来の動的キー辞書は
    // Object.create(null) で作る。INVARIANTS #11）。omitFolders（item6: folders キー自体が
    // remote に無かった回）はキー自体を書かない。rawFoldersOverride（item19: remote に
    // folders キーはあったが unknown だった回）はその生値を verbatim で書く。item6a/item9:
    // 個々の不正 entry（malformedFolderRaw）は生のまま carry over する（解釈できないだけで
    // 削除ではない）。
    ...(omitFolders ? {} : {
      folders: rawFoldersOverride !== undefined ? rawFoldersOverride : Object.assign(
        Object.create(null),
        Object.fromEntries(
          Object.keys(structureFolders).map((id) => {
            const f = structureFolders[id];
            return [id, { id, name: f.name, parentId: f.parentId, sortOrder: f.sortOrder, createdAt: f.createdAt }];
          }),
        ),
        malformedFolderRaw,
      ),
    }),
    // IDB / remote 由来の動的キーを持つ辞書は Object.create(null) で作る（INVARIANTS #11）
    files: Object.assign(
      Object.create(null),
      Object.fromEntries([
        // 引き継ぎを先に置き、local 側の entry を後勝ちにする（remote 由来が
        // local で push したばかりの entry を上書きしないこと）。
        ...carried,
        ...files.map((f) => [
          f.id,
          {
            id: f.id,
            name: f.name,
            updatedAt: new Date(f.updatedAt || Date.now()).toISOString(),
            github: githubCoordsOnly(f.github),
            // push 成功時の新 sha・pull の live sha・legacy 補完で得た sha（#609 A-2）。
            // 不明（一度もこの pass で確認できなかった）なら sha フィールド自体を書かず、
            // 次回の pass が legacy として再補完できるようにする。
            ...(typeof fileShas[f.id] === 'string' ? { sha: fileShas[f.id] } : {}),
            // canonical hash（#610）。同様に不明なら書かず、次回 legacy 補完に回す。
            ...(typeof fileHashes[f.id] === 'string' ? { hash: fileHashes[f.id] } : {}),
            // files[id].parentId（#394 契約1）。structure 側が管轄する — merge 済みの値が
            // 無ければ（極めて稀。unknown structure 経路では単に書かない）フィールド自体を省く。
            ...(Object.hasOwn(structureFileParentIds, f.id) ? { parentId: structureFileParentIds[f.id] } : {}),
          },
        ]),
      ]),
    ),
    _sha: sha,
    _branch: branch,
  };
  const r = await workerFetchWithCSRF('/sync/manifest', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
    // capability header は formatVersion ゲートを通る 2 ルート（manifest write と
    // entity write。#394 C-0）にのみ送る。他ルートに一律送ると Worker-first でない配備で
    // preflight が旧 Worker に拒否される。workerClient.js の workerFetchWithCSRF 定義
    // コメント参照）。
    formatCapability: true,
  });
  if (!r.ok) throw await readSyncFailure(r, 'push manifest');
  // 新しい SHA を返す（init が空 manifest を確定させてから本体を書くのに使う）。
  // 本文が読めなくても書き込み自体は成功しているので、失敗にはしない。
  try {
    const body = await r.json();
    return typeof body?.sha === 'string' ? body.sha : null;
  } catch {
    return null;
  }
}
