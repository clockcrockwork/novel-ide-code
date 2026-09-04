import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FORMAT_CAPABILITY_VERSION, FORMAT_CAPABILITY_HEADER } from './syncErrors';

// workerFetchWithCSRF は capability header を **明示的に formatCapability: true を渡した
// 呼び出しにだけ**送る（#619 レビュー round 13 指摘）。以前は全変更系リクエストに一律付与
// していたため、フロントエンドを Worker より先に配備するクロスオリジン構成で、新ヘッダーを
// 知らない旧 Worker の CORS Access-Control-Allow-Headers が preflight を拒否し、manifest
// 同期だけでなく entity 同期・端末削除・repo 認可まで通信エラーになっていた（現在は
// entity write へ意図的に送る＝下記）。worker がこの header を実際に消費するのは
// formatVersion ゲートを通る 2 ルート（PUT /sync/manifest の checkFormatCapability と
// PUT /sync/file/:id の checkRemoteFormatVersion。#394 C-0）だけなので、他ルートに送る
// 必要が無い。
//
// このモジュールは cachedCSRFToken 等をモジュールスコープの private state に持つため、
// テストごとに vi.resetModules() で状態をリセットし、fetch モックを都度差し替えて
// 動的 import する。
describe('workerFetchWithCSRF — capability header は formatCapability: true のときだけ送る', () => {
  let fetchMock;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockCsrfThenRequest(requestResponse) {
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ csrfToken: 'tok-1', expiresIn: 3600 }),
        });
      }
      return Promise.resolve(requestResponse);
    });
  }

  it('formatCapability: true を渡した PUT（manifest write）には capability header を送る', async () => {
    mockCsrfThenRequest({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/manifest', {
      method: 'PUT',
      body: '{}',
      formatCapability: true,
    });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/manifest');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts.headers.get(FORMAT_CAPABILITY_HEADER)).toBe(String(FORMAT_CAPABILITY_VERSION));
  });

  // entity write（PUT /sync/file/:id）も checkRemoteFormatVersion（formatVersion ゲート）を
  // 通るため、manifest write と同じく formatCapability: true を渡す（#394 C-0。
  // src/lib/sync.js の syncFile が渡す）。
  it('formatCapability: true を渡した PUT（entity write）には capability header を送る', async () => {
    mockCsrfThenRequest({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/file/abc', {
      method: 'PUT',
      body: '{}',
      formatCapability: true,
    });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/file/abc');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts.headers.get(FORMAT_CAPABILITY_HEADER)).toBe(String(FORMAT_CAPABILITY_VERSION));
  });

  // formatCapability を渡さないルート（例: settings write）には送らない。entity write は
  // 上のテストが示すとおり formatCapability: true を渡す側に回ったため、ここでは
  // 渡さない側の代表として settings write を使う。
  it('formatCapability を渡さない PUT（settings write）には capability header を送らない', async () => {
    mockCsrfThenRequest({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/settings', { method: 'PUT', body: '{}' });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/settings');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts.headers.get(FORMAT_CAPABILITY_HEADER)).toBeNull();
  });

  it('formatCapability を渡さない POST（/sync/init）にも capability header を送らない', async () => {
    mockCsrfThenRequest({ ok: true, status: 200, json: () => Promise.resolve({ branch: 'main' }) });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/init', { method: 'POST' });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/init');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts.headers.get(FORMAT_CAPABILITY_HEADER)).toBeNull();
  });

  it('formatCapability: true は CSRF 403 リトライ後の再送にも引き継がれる', async () => {
    let requestAttempt = 0;
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ csrfToken: `tok-${requestAttempt}`, expiresIn: 3600 }),
        });
      }
      requestAttempt++;
      if (requestAttempt === 1) {
        return Promise.resolve({
          ok: false,
          status: 403,
          clone: () => ({ json: () => Promise.resolve({ error: 'csrf token invalid' }) }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/manifest', {
      method: 'PUT',
      body: '{}',
      formatCapability: true,
    });

    const requestCalls = fetchMock.mock.calls.filter(([path]) => path === '/sync/manifest');
    expect(requestCalls.length).toBe(2); // 最初の 403 + リトライ
    const [, retryOpts] = requestCalls[1];
    expect(retryOpts.headers.get(FORMAT_CAPABILITY_HEADER)).toBe(String(FORMAT_CAPABILITY_VERSION));
  });

  // entity write（syncFile）は CSRF 403 リトライ経路を通ることが多い（世代拘束の再送等）。
  // 初回送信・リトライ再送信の両方で header が落ちないことを固定する（#394 C-0。
  // workerClient.js L208/L234 の両方で setCapabilityHeaderIfRequested を呼ぶ実装を検査）。
  it('formatCapability: true（entity write）は CSRF 403 リトライ後の再送にも引き継がれる', async () => {
    let requestAttempt = 0;
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ csrfToken: `tok-${requestAttempt}`, expiresIn: 3600 }),
        });
      }
      requestAttempt++;
      if (requestAttempt === 1) {
        return Promise.resolve({
          ok: false,
          status: 403,
          clone: () => ({ json: () => Promise.resolve({ error: 'csrf token invalid' }) }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/file/abc', {
      method: 'PUT',
      body: '{}',
      formatCapability: true,
    });

    const requestCalls = fetchMock.mock.calls.filter(([path]) => path === '/sync/file/abc');
    expect(requestCalls.length).toBe(2); // 最初の 403 + リトライ
    const [, firstOpts] = requestCalls[0];
    const [, retryOpts] = requestCalls[1];
    expect(firstOpts.headers.get(FORMAT_CAPABILITY_HEADER)).toBe(String(FORMAT_CAPABILITY_VERSION));
    expect(retryOpts.headers.get(FORMAT_CAPABILITY_HEADER)).toBe(String(FORMAT_CAPABILITY_VERSION));
  });
});

// clearCSRFToken() は logout / セッション失効時に AppContext.jsx から呼ばれる（#283 の
// clearAuthorizedRepos と対）。世代カウンタ（csrfGeneration）で「破棄後に到着した古い
// in-flight refresh の応答」を無視することを固定する（レビュー N1/S3/F-2）。
// capability header のテストと同じ理由で vi.resetModules() + 動的 import を使う。
describe('clearCSRFToken / getCSRFToken の世代管理', () => {
  let fetchMock;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('破棄後の次回 getCSRFToken() が再取得する（キャッシュを使わない）', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-1', expiresIn: 3600 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-2', expiresIn: 3600 }) });
    const { getCSRFToken, clearCSRFToken } = await import('./workerClient');

    const first = await getCSRFToken();
    expect(first).toBe('token-1');
    expect(fetchMock).toHaveBeenCalledOnce();

    // TTL 内の再呼び出しはキャッシュを使い、fetch を増やさない
    const cached = await getCSRFToken();
    expect(cached).toBe('token-1');
    expect(fetchMock).toHaveBeenCalledOnce();

    clearCSRFToken();

    const afterClear = await getCSRFToken();
    expect(afterClear).toBe('token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logout 中の in-flight refresh が clearCSRFToken を追い越さない（旧応答を書き戻さず、次回は再取得する）', async () => {
    let resolveRefresh;
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return new Promise((resolve) => {
          resolveRefresh = () => resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ csrfToken: 'stale-token', expiresIn: 3600 }),
          });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'fresh-token', expiresIn: 3600 }) });
    });
    const { getCSRFToken, clearCSRFToken } = await import('./workerClient');

    // refresh 開始（まだ応答は来ない = in-flight）
    const inFlight = getCSRFToken();

    // logout: refresh が終わる前にキャッシュと refreshPromise を破棄する
    clearCSRFToken();

    // 遅延していた古い refresh の応答がここで到着する
    resolveRefresh();
    await inFlight;

    // 世代が変わっているため、古い応答は cachedCSRFToken へ書き戻されない。
    // 次回呼び出しは古い 'stale-token' を返さず、新規 fetch で再取得する。
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ csrfToken: 'new-after-clear', expiresIn: 3600 }),
    });
    const { getCSRFToken: getCSRFTokenAgain } = await import('./workerClient');
    const next = await getCSRFTokenAgain();
    expect(next).not.toBe('stale-token');
  });

  // round4 所見1: 世代不一致（stale）の成功応答は lastCSRFFailure を上書きしてはならない。
  // 上書きすると、現世代側で既に記録した失敗分類（例: network）が、無関係な旧世代の
  // 成功応答によって null に消され、呼び出し元の失敗表示が失われる。
  it('世代不一致の成功応答は lastCSRFFailure を上書きしない', async () => {
    let resolveFirst;
    let callCount = 0;
    fetchMock.mockImplementation((path) => {
      if (path !== '/auth/csrf-token') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ csrfToken: 'stale-token', expiresIn: 3600 }),
          });
        });
      }
      return Promise.reject(new Error('network down'));
    });
    const { getCSRFToken, clearCSRFToken, getLastCSRFFailureCategory } = await import('./workerClient');

    // 世代0で refresh A を開始（まだ応答は来ない = in-flight）
    const pendingA = getCSRFToken();

    // logout 等で世代を1へ進める（A の応答はまだ来ていない）
    clearCSRFToken();

    // 世代1で refresh B を開始し、network 失敗を記録させる
    const resultB = await getCSRFToken();
    expect(resultB).toBeNull();
    expect(getLastCSRFFailureCategory()).toBe('network');

    // 世代0の refresh A の遅延応答（成功）がここで到着する
    resolveFirst();
    await pendingA;

    // 世代不一致の成功応答は lastCSRFFailure を上書きしない（'network' のまま）
    expect(getLastCSRFFailureCategory()).toBe('network');
  });

  // round4 所見2: refreshPromise の finally は「自分自身が現在の refreshPromise と
  // 同一の場合だけ」null に戻す必要がある。同一性チェックが無いと、旧世代の refresh
  // （PA）の解決が、既に進行中の新世代の refresh（PB）への参照を横から null にしてしまい、
  // 直後の getCSRFToken() 呼び出しが「進行中の refresh がある」と誤認できず、
  // 不要な追加 fetch を発生させる。
  it('旧世代の refresh（PA）解決が新世代の refresh（PB）を上書きしない（追加 fetch が発生しない）', async () => {
    let resolveA;
    let resolveB;
    let callCount = 0;
    fetchMock.mockImplementation((path) => {
      if (path !== '/auth/csrf-token') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveA = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-A', expiresIn: 3600 }) });
        });
      }
      if (callCount === 2) {
        return new Promise((resolve) => {
          resolveB = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-B', expiresIn: 3600 }) });
        });
      }
      throw new Error('想定外の3回目の /auth/csrf-token fetch');
    });
    const { getCSRFToken, clearCSRFToken } = await import('./workerClient');

    // PA 開始（世代0、まだ応答なし）
    const callA = getCSRFToken();

    // logout 等で世代1へ進める（PA はまだ in-flight のまま）
    clearCSRFToken();

    // PB 開始（世代1、まだ応答なし）
    const callB = getCSRFToken();

    // PA が解決する（旧世代の成功応答）。PA の finally が PB を横から null にしないことを検証する。
    resolveA();
    await callA;

    // PA 解決後も PB は進行中のはずなので、ここでの呼び出しは新規 fetch を発生させない
    const callC = getCSRFToken();
    expect(callCount).toBe(2); // PA + PB のみ（callC で 3 回目の fetch は発生しない）

    // PB を解決する
    resolveB();
    const [resultB, resultC] = await Promise.all([callB, callC]);
    expect(resultB).toBe('token-B');
    expect(resultC).toBe('token-B'); // callC は PB と同じ promise を共有する
    expect(callCount).toBe(2);
  });

  // round5 所見A / round6 所見4: 世代ガードは成功経路だけでなく、
  // network/401/!ok/parse不正の全ての失敗経路にも適用する。旧世代の応答が遅延到着しても、
  // onUnauthorized を発火せず、lastCSRFFailure も更新してはならない（現世代にとって無関係な
  // 旧世代の失敗で、ログイン状態の UI やエラー分類を乱してはならない。round7 減算所見:
  // 401 単独テストを他の失敗経路と同じ構造の it.each へ統合し重複を解消）。
  it.each([
    ['network 失敗', () => Promise.reject(new Error('network down'))],
    ['http（500）', () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })],
    ['parse 不正（JSON でない）', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) })],
    ['401', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) })],
  ])('旧世代の %s 応答は onUnauthorized を発火せず lastCSRFFailure も更新しない', async (_label, makeStaleOutcome) => {
    let resolveStale;
    let callCount = 0;
    fetchMock.mockImplementation((path) => {
      if (path !== '/auth/csrf-token') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve, reject) => {
          resolveStale = () => {
            makeStaleOutcome().then(resolve, reject);
          };
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'gen1-token', expiresIn: 3600 }) });
    });
    const { getCSRFToken, clearCSRFToken, getLastCSRFFailureCategory, setUnauthorizedHandler } = await import('./workerClient');
    const onUnauthorizedSpy = vi.fn();
    setUnauthorizedHandler(onUnauthorizedSpy);

    // 世代0で refresh A を開始（まだ応答は来ない = in-flight）
    const pendingA = getCSRFToken();

    // logout 等で世代を1へ進める（A の応答はまだ来ていない）
    clearCSRFToken();

    // 世代1で refresh B を開始し、成功させる
    const resultB = await getCSRFToken();
    expect(resultB).toBe('gen1-token');
    expect(getLastCSRFFailureCategory()).toBeNull();

    // 世代0の refresh A の遅延応答（network/http/parse 失敗）がここで到着する
    resolveStale();
    await pendingA;

    // 旧世代の失敗は onUnauthorized を発火せず、lastCSRFFailure も更新しない
    expect(onUnauthorizedSpy).not.toHaveBeenCalled();
    expect(getLastCSRFFailureCategory()).toBeNull();
  });

  // round6 所見3: 応答の expiresIn が有限の正数でなければ「即期限切れ」として扱う。
  // `?? 3600` の暗黙デフォルトのままだと、worker/中間層の応答不正で expiresIn が非数値に
  // なった場合、実際には期限切れの token を1時間有効とみなし続けてしまう。
  it('expiresIn が非数値のときは即期限切れとして扱い、次回 getCSRFToken() が再取得する', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-1', expiresIn: 'not-a-number' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'token-2', expiresIn: 3600 }) });
    const { getCSRFToken } = await import('./workerClient');

    const first = await getCSRFToken();
    expect(first).toBe('token-1');
    expect(fetchMock).toHaveBeenCalledOnce();

    // expiresIn が非数値だったため即期限切れ扱いになっており、2回目の呼び出しは
    // キャッシュを使わず再取得する。
    const second = await getCSRFToken();
    expect(second).toBe('token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // clearCSRFToken() は csrfGeneration を bump し refreshPromise も破棄する。403 リトライ
  // 経路がインライン破棄（cachedCSRFToken = null; csrfTokenExpiresAt = 0;）のままだと
  // csrfGeneration が bump されず、logout 等の外部 clearCSRFToken() と同じ世代管理に
  // 参加しない。ここでは「リトライが1回だけ発生し、新しい token で成功する」という
  // 観測可能な振る舞い（clearCSRFToken 呼び出しの直接的な結果）を固定する。
  it('403（csrf token invalid）を受けたら clearCSRFToken 経由で新しい token を取得し、1回だけリトライする', async () => {
    let csrfCalls = 0;
    let putCalls = 0;
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        csrfCalls++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ csrfToken: `tok-${csrfCalls}`, expiresIn: 3600 }),
        });
      }
      putCalls++;
      if (putCalls === 1) {
        return Promise.resolve({
          ok: false,
          status: 403,
          clone: () => ({ json: () => Promise.resolve({ error: 'csrf token invalid' }) }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    const { workerFetchWithCSRF } = await import('./workerClient');

    const res = await workerFetchWithCSRF('/sync/manifest', { method: 'PUT', body: '{}' });

    expect(res.ok).toBe(true);
    expect(csrfCalls).toBe(2); // 初回取得 + 403後の再取得（clearCSRFToken 経由）
    expect(putCalls).toBe(2); // 元リクエスト + リトライ1回のみ
  });

  it('PATCH 以外の未列挙メソッド（例: QUERY）でも変更系として token を添付する', async () => {
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-query', expiresIn: 3600 }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/manifest', { method: 'QUERY', body: '{}' });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/manifest');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts.headers.get('X-CSRF-Token')).toBe('tok-query');
  });

  it('GET / HEAD には token を添付しない', async () => {
    fetchMock.mockImplementation((path) => {
      if (path === '/auth/csrf-token') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-get', expiresIn: 3600 }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    const { workerFetchWithCSRF } = await import('./workerClient');

    await workerFetchWithCSRF('/sync/manifest', { method: 'GET' });

    const requestCall = fetchMock.mock.calls.find(([path]) => path === '/sync/manifest');
    expect(requestCall).toBeDefined();
    const [, opts] = requestCall;
    expect(opts?.headers?.get?.('X-CSRF-Token')).toBeFalsy();
    // /auth/csrf-token への fetch も発生していないこと（GET は CSRF 対象外）
    expect(fetchMock.mock.calls.some(([p]) => p === '/auth/csrf-token')).toBe(false);
  });
});
