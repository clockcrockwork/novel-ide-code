import { workerFetch, workerFetchWithCSRF } from './workerClient';
import { sanitizeFileName } from './security/validateSafeFileName';
import { validateGitHubWritePath } from './security/validateGitHubWritePath';

// セッション内で authorize 済みの owner/repo（lowercase）をメモ化し二重送信を抑止する。
// let で宣言し clearAuthorizedRepos() で新インスタンスに置き換えることで、
// ログアウト後のインフライトリクエストが旧インスタンスを参照し新セッションを汚染するのを防ぐ（#283）。
let authorizedRepos = new Set();
// 進行中の認可リクエストを保持し、同一 slug への並行呼び出しを 1 本に束ねる（#283）。
let pendingAuthorizations = new Map();

// ログアウト・セッション失効時に呼ぶ。インスタンスを新規に差し替え、既存の Promise が旧インスタンスを参照し続けるよう設計（#283）。
export function clearAuthorizedRepos() {
  authorizedRepos = new Set();
  pendingAuthorizations = new Map();
}

// ユーザーが明示選択した repo を worker セッションの認可リストへ登録する（#283）。
// 失敗時は throw する。後続の proxy 呼び出しが必ず 403 になるため、正確なエラーを伝播させる。
export async function authorizeRepo(owner, repo) {
  if (typeof owner !== 'string' || typeof repo !== 'string' || !owner || !repo) {
    throw new Error('authorizeRepo: owner/repo が不正です');
  }
  const slug = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  // 呼び出し時点のインスタンスをキャプチャし、clear() 後も旧インスタンスにのみ書き込む（#283）。
  const currentAuthorized = authorizedRepos;
  const currentPending = pendingAuthorizations;
  if (currentAuthorized.has(slug)) return;
  if (currentPending.has(slug)) return currentPending.get(slug);
  const promise = (async () => {
    try {
      const r = await workerFetchWithCSRF('/auth/authorize-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo }),
      });
      if (r.ok) {
        currentAuthorized.add(slug);
      } else {
        throw new Error(`リポジトリの認可に失敗しました (${r.status})`);
      }
    } catch (e) {
      console.warn('authorizeRepo error', e);
      throw e;
    } finally {
      currentPending.delete(slug);
    }
  })();
  currentPending.set(slug, promise);
  return promise;
}

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// worker の validateCSRFToken が返す文言（worker/src/middleware.ts）。ここで直接文字列を
// 比較する。sync 系の category catalog（syncErrors.js CATEGORY_MESSAGE）を流用しない
// 理由: あちらは workerFetchWithCSRF のリトライ失敗時に SyncRequestError として throw される
// 経路向けで、github.js の呼び出し元は res.ok を見て parseError() の文言を直接使うため
// 別の文言カタログを参照する必要がある（parity は csrfErrorMessageParity.test.js で別途担保）。
const CSRF_ERROR_BODIES = new Set(['csrf token missing', 'csrf token invalid']);

async function parseError(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) return '認証に失敗しました。再度ログインしてください。';
  if (res.status === 403) {
    // CSRF token 不正（workerFetchWithCSRF の自動リトライ後もなお失敗した場合）は
    // repo 認可失敗と原因が異なるため、行動指示（再読み込み）を含む専用文言にする。
    if (CSRF_ERROR_BODIES.has(body.error)) {
      return 'セッション情報の更新が必要です。ページを再読み込みしてください。';
    }
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining === '0')
      return 'API レート制限に達しました。しばらく待ってから再試行してください。';
    return 'アクセスが拒否されました。';
  }
  if (res.status === 404) return 'リソースが見つかりません。';
  if (res.status === 409)
    return 'リモートで変更が検出されました。GitHubから最新版を開き直してください。';
  if (res.status === 422 && body.message?.includes('too large')) {
    return 'ファイルサイズが大きすぎます（上限 1MB）。';
  }
  return body.message || `エラー (${res.status})`;
}

export async function getUser() {
  const r = await workerFetch('/github/user');
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function listRepos(page = 1) {
  const r = await workerFetch(`/github/user/repos?sort=updated&per_page=50&page=${page}`);
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function getRepo(owner, repo) {
  const r = await workerFetch(`/github/repos/${owner}/${repo}`);
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function getContents(owner, repo, path = '', ref = 'HEAD') {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const r = await workerFetch(
    `/github/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  );
  if (!r.ok) throw new Error(await parseError(r));
  const data = await r.json();
  if (!Array.isArray(data) && data.size > 1_000_000) {
    throw new Error('ファイルサイズが大きすぎます（上限 1MB）。');
  }
  return data;
}

export async function getFileContent(owner, repo, path, ref = 'HEAD') {
  const data = await getContents(owner, repo, path, ref);
  if (Array.isArray(data)) throw new Error('パスはファイルではなくディレクトリです。');
  return {
    content: decodeBase64(data.content),
    sha: data.sha,
    name: sanitizeFileName(data.name) || 'unnamed',
  };
}

export async function commitFile(owner, repo, path, message, content, sha, branch) {
  const check = validateGitHubWritePath(path);
  if (!check.ok) throw new Error(`書き込み不可のパスです: ${check.reason}`);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const body = { message, content: encodeBase64(content), branch };
  if (sha) body.sha = sha;

  const r = await workerFetchWithCSRF(`/github/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function listBranches(owner, repo) {
  const r = await workerFetch(`/github/repos/${owner}/${repo}/branches?per_page=100`);
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function listPRs(owner, repo, state = 'open') {
  const r = await workerFetch(
    `/github/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=100`,
  );
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function createPR(owner, repo, { title, body = '', head, base }) {
  const r = await workerFetchWithCSRF(`/github/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}

export async function mergePR(owner, repo, pullNumber) {
  const r = await workerFetchWithCSRF(`/github/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return r.json();
}
