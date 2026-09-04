import {
  SyncRequestError,
  FORMAT_CAPABILITY_VERSION,
  FORMAT_CAPABILITY_HEADER,
} from './syncErrors';

let onUnauthorized = null;
let cachedCSRFToken = null;
let csrfTokenExpiresAt = 0;
let refreshPromise = null;

// clearCSRFToken() が呼ばれるたびに増える世代番号。in-flight の refreshCSRFToken() は
// 開始時点の世代を捕捉し、応答到着時に世代がずれていたら（= 途中で logout/clear された）
// cachedCSRFToken への書き戻しを行わない（レビュー N1/S3/F-2）。
// これにより「破棄後に到着した古い refresh の応答」が新セッションの token を上書きしない。
let csrfGeneration = 0;

// worker 側の GET/HEAD 判定（worker/src/middleware.ts の CSRF_SAFE_METHODS）と同じ集合・
// 同じ名前にする（F-6）。「変更系メソッドを4種列挙」ではなく「安全メソッド以外はすべて
// 変更系扱い」に反転しておくことで、標準外のメソッド（例: QUERY）や将来 worker 側の
// allowlist に無い新メソッドを追加した場合も client 側が個別追従不要になる。
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD']);

const CSRF_REFRESH_THRESHOLD = 5 * 60 * 1000;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// logout / セッション失効時に呼ぶ。キャッシュ済み CSRF token を破棄する（#283 の
// clearAuthorizedRepos と対）。呼ばずに放置すると、旧セッションの CSRF token が
// キャッシュに残ったまま新セッション（再ログイン後）の変更系リクエストに使われ、
// worker 側で `csrf token invalid` として拒否される（workerFetchWithCSRF が1回だけ
// 自動リトライするため実害は小さいが、無駄な往復と失敗ログが発生する）。
// 403 リトライ経路（workerFetchWithCSRF）もこの関数を経由する — インライン破棄だと
// csrfGeneration が bump されず、logout と同じ世代管理に参加できない。
// refreshPromise も破棄する: 破棄前に始まった in-flight refresh の完了を待たせない
// （その応答は世代チェックで無視されるため、待つ意味がない）。
export function clearCSRFToken() {
  cachedCSRFToken = null;
  csrfTokenExpiresAt = 0;
  csrfGeneration += 1;
  refreshPromise = null;
}

// トークン取得に失敗した理由。null を返すだけだと呼び出し側が「通信不能」と
// 「セッション失効」と「サーバー障害」を区別できず、同期の失敗表示が一律
// 「整合性チェックのため中止」に潰れる（#608）。
let lastCSRFFailure = null;

export function getLastCSRFFailureCategory() {
  return lastCSRFFailure;
}

// fetch〜parse を行い、結果を表す tagged object を返す副作用なしの内部関数。
// cache 書き戻し・lastCSRFFailure・onUnauthorized はここでは一切行わない
// （世代照合を1回だけ行った後、呼び出し元の refreshCSRFToken で適用する。
// round6 所見1: 5箇所に重複していた isStale() 分岐を1箇所へ畳む）。
async function fetchCSRFTokenResult() {
  // fetch の拒否（到達できていない = network）と、成功応答の解析・形状不正
  // （到達はしている = server）を分ける。ひとつの try で包むと、HTTP 200 で非 JSON を
  // 返された場合まで「通信に失敗しました」と案内してしまう。
  let res;
  try {
    res = await fetch('/auth/csrf-token', { credentials: 'include' });
  } catch {
    return { kind: 'network' };
  }
  if (res.status === 401) {
    return { kind: 'auth' };
  }
  if (!res.ok) {
    return { kind: 'http', status: res.status };
  }
  try {
    const data = await res.json();
    if (typeof data?.csrfToken !== 'string' || data.csrfToken.length === 0) {
      return { kind: 'parse' };
    }
    return { kind: 'ok', token: data.csrfToken, expiresIn: data.expiresIn };
  } catch {
    // 応答は届いているが解析できない = worker / 中間層の応答不正
    return { kind: 'parse' };
  }
}

// expiresIn が有限の正数でなければ「即期限切れ」として扱う（round6 所見3。敵対的
// レビュー: worker/中間層の応答不正で expiresIn が欠落・非数値になった場合、
// `?? 3600` の暗黙デフォルトだと実際には期限切れの token を1時間有効とみなしてしまう。
// 0 を返すと次回の getCSRFToken() が必ず再取得へ回る＝安全側に倒す）。
function computeExpiresAt(expiresIn) {
  if (!(Number.isFinite(expiresIn) && expiresIn > 0)) return 0;
  return Date.now() + expiresIn * 1000;
}

async function refreshCSRFToken() {
  // 開始時点の世代を捕捉する。応答到着時にこの世代と現在の csrfGeneration が異なれば、
  // 待っている間に clearCSRFToken()（logout/セッション失効/403リトライ）が呼ばれたことを
  // 意味し、この応答は古いセッションのものとして cachedCSRFToken へ書き戻さない。
  const startGeneration = csrfGeneration;
  const result = await fetchCSRFTokenResult();
  const isStale = csrfGeneration !== startGeneration;

  if (result.kind === 'ok') {
    if (isStale) {
      // 世代がずれている: 破棄後に到着した古い応答。書き戻さず、取得できた token
      // そのものは呼び出し元（同一世代内で待っていた他の呼び出し）へは返す。
      // lastCSRFFailure には触れない（round4 所見1）: この応答は現世代にとって無関係な
      // 旧世代の成功であり、現世代側で既に記録済みの失敗分類（例: 新しい refresh が
      // network 失敗した）を、無関係な旧世代の成功で上書きしてはならない。
      return result.token;
    }
    cachedCSRFToken = result.token;
    csrfTokenExpiresAt = computeExpiresAt(result.expiresIn);
    lastCSRFFailure = null;
    return cachedCSRFToken;
  }

  // 失敗経路（network/auth/http/parse）。世代ガードは成功経路だけでなく全ての失敗経路にも
  // 適用する（round5 所見A）。stale 側は自分の失敗理由を記録しない —
  // 呼び出し元の要求は既に clear で無効化されているため、現世代にとって無関係な旧世代の
  // 失敗で lastCSRFFailure・onUnauthorized（現世代側の状態や UI）を乱してはならない
  // （round6 所見2）。戻り値は常に null（失敗）。
  if (isStale) return null;

  if (result.kind === 'network') {
    lastCSRFFailure = 'network';
  } else if (result.kind === 'auth') {
    lastCSRFFailure = 'auth';
    if (onUnauthorized) onUnauthorized();
  } else if (result.kind === 'http') {
    lastCSRFFailure = result.status >= 502 && result.status <= 504 ? 'upstream' : 'server';
  } else {
    lastCSRFFailure = 'server';
  }
  return null;
}

// refreshPromise を開始し、完了時に自分自身が現在の refreshPromise と同一の場合だけ
// null に戻す（round4 所見2）。同一性チェックが無いと、旧世代の refresh（PA）が
// 解決した際の finally が、既に進行中の新世代の refresh（PB）への参照を横から
// null にしてしまい、PB の完了を待っている呼び出し元が再度 getCSRFToken() を呼んだ時に
// 「進行中の refresh がある」と誤認できず、不要な追加 fetch を発生させる。
function scheduleRefresh() {
  const promise = refreshCSRFToken().finally(() => {
    if (refreshPromise === promise) refreshPromise = null;
  });
  refreshPromise = promise;
  return promise;
}

export async function getCSRFToken() {
  if (!cachedCSRFToken || Date.now() > csrfTokenExpiresAt) {
    if (!refreshPromise) scheduleRefresh();
    return refreshPromise;
  }
  if (Date.now() > csrfTokenExpiresAt - CSRF_REFRESH_THRESHOLD) {
    if (!refreshPromise) scheduleRefresh();
  }
  return cachedCSRFToken;
}

// fetch の拒否だけを network として型付けする境界。ここで包まないと、成功応答の形状不正や
// 実装上のプロパティアクセス失敗で出る TypeError まで「通信エラー」として集計・表示され、
// remote / client の破損が誰にも気づかれない（#608）。
async function fetchOrNetworkError(path, opts) {
  try {
    return await fetch(path, opts);
  } catch {
    throw new SyncRequestError('network', { operation: `fetch ${path}` });
  }
}

export async function workerFetch(path, opts = {}) {
  const res = await fetchOrNetworkError(path, { ...opts, credentials: 'include' });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  return res;
}

// formatCapability: true のときだけ capability header をセットする。呼び出し側で inline
// if にすると workerFetchWithCSRF 本体の cognitive complexity を押し上げるため、判定を
// ここへ切り出す（初回送信・403 リトライ再送信の両方から呼ぶ）。
function setCapabilityHeaderIfRequested(headers, formatCapability) {
  if (formatCapability) headers.set(FORMAT_CAPABILITY_HEADER, String(FORMAT_CAPABILITY_VERSION));
}

// formatCapability: true の呼び出し側だけが capability header を送る（既定では送らない）。
// worker がこの header を実際に消費するのは formatVersion ゲートを通る 2 ルート
// （PUT /sync/manifest の checkFormatCapability と PUT /sync/file/:id の
// checkRemoteFormatVersion）だけなので、他ルート（settings / devices / GET 系）に
// 付ける意味は現時点で無い。全変更系リクエストに一律付与すると、フロントエンドを
// Worker より先に配備するクロスオリジン構成で、新ヘッダーを知らない旧 Worker の
// Access-Control-Allow-Headers が preflight を拒否し、settings 同期・端末削除まで
// 止まる（#619 レビュー round 13 指摘。CORS 自体は現行 index.ts で許可済みのため、
// entity write への拡張〔#394 C-0〕はこの懸念に当たらない）。呼び出し側は
// `src/lib/sync.js` の manifest PUT（`pushManifest`）と entity PUT（`syncFile`）
// だけがこのオプションを渡す。
export async function workerFetchWithCSRF(path, opts = {}) {
  const { formatCapability = false, ...requestOpts } = opts;
  const method = (requestOpts.method || 'GET').toUpperCase();
  opts = requestOpts;
  const isMutationMethod = !CSRF_SAFE_METHODS.has(method);
  if (isMutationMethod) {
    const csrfToken = await getCSRFToken();
    if (!csrfToken) {
      throw new SyncRequestError(getLastCSRFFailureCategory() ?? 'server', {
        operation: 'acquire csrf token',
      });
    }
    const headers = new Headers(opts.headers);
    headers.set('X-CSRF-Token', csrfToken);
    setCapabilityHeaderIfRequested(headers, formatCapability);
    opts = { ...opts, headers };
  }

  const res = await fetchOrNetworkError(path, { ...opts, credentials: 'include' });

  if (res.status === 403 && isMutationMethod) {
    // ボディをクローンして読む — 元のレスポンスのストリームを消費しない
    const body = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (body.error === 'csrf token missing' || body.error === 'csrf token invalid') {
      // clearCSRFToken() 経由でキャッシュを破棄し、新トークンで1回リトライする
      // （インライン破棄ではなく共通関数を使うことで csrfGeneration も bump される。N2）
      clearCSRFToken();
      const newToken = await getCSRFToken();
      if (!newToken) {
        // 元の 403 をそのまま返すと、同期側は記録済みの network / server ではなく
        // forbidden と分類し「権限・アクセス制限」を案内してしまう。
        throw new SyncRequestError(getLastCSRFFailureCategory() ?? 'server', {
          operation: 'refresh csrf token',
        });
      }
      const retryHeaders = new Headers(opts.headers);
      retryHeaders.set('X-CSRF-Token', newToken);
      setCapabilityHeaderIfRequested(retryHeaders, formatCapability);
      const retryRes = await fetchOrNetworkError(path, {
        ...opts,
        credentials: 'include',
        headers: retryHeaders,
      });
      if (retryRes.status === 401 && onUnauthorized) onUnauthorized();
      return retryRes;
    }
  }

  if (res.status === 401 && onUnauthorized) onUnauthorized();
  return res;
}
