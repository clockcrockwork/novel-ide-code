import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appFetch, encodeGitHubContent, env, jsonResponse, makeSession, mockFetch, seedCSRF, seedSession,
} from './test-utils';
import { CSRF_TOKEN_FORMAT_RE } from '../middleware';

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- validateCSRFToken の safe-method スキップ（/github/* 一括適用、Finding M1） ---
// safe method（GET/HEAD）判定は validateCSRFToken 内に内包されている（index.ts はメソッド判定を
// 書かず app.use('/github/*', validateCSRFToken) の1行）。/github/* を経由してその内包ロジック自体を検証する。

describe('validateCSRFToken — GET/HEAD は内部でスキップし、それ以外は検証する', () => {
  it('GET はCSRFトークン無しで通過し、POST は検証される（/github/*）', async () => {
    const sessionToken = 'sess-csrf-safe-method';
    await seedSession(sessionToken);

    const fetchMock = mockFetch(() => jsonResponse({ login: 'testuser' }));
    const getRes = await appFetch('/github/user', {}, { 'novel-ide-session': sessionToken });
    expect(getRes.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const postRes = await appFetch(
      '/github/user/repos',
      { method: 'POST' },
      { 'novel-ide-session': sessionToken },
    );
    expect(postRes.status).toBe(403);
    const body = await postRes.json() as { error: string };
    expect(body.error).toBe('csrf token missing');
  });
});

// --- GET /auth/csrf-token（token 発行エンドポイント自体の挙動） ---

describe('GET /auth/csrf-token', () => {
  it('認証済みセッションでCSRFトークンを返す', async () => {
    const sessionToken = 'sess-ok';
    await seedSession(sessionToken);

    const res = await appFetch('/auth/csrf-token', {}, { 'novel-ide-session': sessionToken });
    expect(res.status).toBe(200);
    const body = await res.json() as { csrfToken: string };
    // 発行された token が validateCSRFToken の形式検査（F-5）を満たすことを検査する
    // （typeof/length だけでは、issuer の実際の出力形式と検査 regex が乖離しても検出できない。
    // regex は middleware.ts から export した同じ定数を参照し、テスト内に複製しない。round5 所見E）。
    expect(CSRF_TOKEN_FORMAT_RE.test(body.csrfToken)).toBe(true);

    // KV にトークンが書き込まれていること
    const stored = await env.SESSIONS.get(`csrf:${sessionToken}:${body.csrfToken}`);
    expect(stored).toBe('1');
  });

  // round5 所見E: 発行された token をそのまま変更系ルートに送って通過することを end-to-end
  // で確認する（seedCSRF によるテスト専用の直接シードではなく、実際の発行経路を経由する）。
  it('発行された token をそのまま変更系ルートに送ると通過する（end-to-end）', async () => {
    const sessionToken = 'sess-e2e-issue';
    await seedSession(sessionToken);

    const issueRes = await appFetch('/auth/csrf-token', {}, { 'novel-ide-session': sessionToken });
    expect(issueRes.status).toBe(200);
    const { csrfToken } = await issueRes.json() as { csrfToken: string };

    mockManifestWrite('e2e-manifest-sha');
    const putRes = await appFetch(
      '/sync/manifest',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ _branch: 'main', files: {} }),
      },
      { 'novel-ide-session': sessionToken },
    );
    expect(putRes.status).toBe(200);
  });

  it('未認証（セッションなし）は 401', async () => {
    const res = await appFetch('/auth/csrf-token');
    expect(res.status).toBe(401);
  });

  it('無効なセッショントークンは 401', async () => {
    const res = await appFetch('/auth/csrf-token', {}, { 'novel-ide-session': 'invalid-session' });
    expect(res.status).toBe(401);
  });

  it('期限切れセッション（expiresAt が過去）は 401', async () => {
    const sessionToken = 'sess-expired';
    await seedSession(sessionToken, makeSession({ expiresAt: Date.now() - 1000 }));

    const res = await appFetch('/auth/csrf-token', {}, { 'novel-ide-session': sessionToken });
    expect(res.status).toBe(401);
  });

  it('レスポンスに Cache-Control: no-store が付与される', async () => {
    const sessionToken = 'sess-cc';
    await seedSession(sessionToken);

    const res = await appFetch('/auth/csrf-token', {}, { 'novel-ide-session': sessionToken });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

// --- validateCSRFToken の3挙動（missing / invalid / 通過） ---
// 代表ルートとして PUT /sync/manifest を使う。各 CSRF 保護ルート（/sync/file・/sync/init・
// /sync/settings・/github/* 等）でも同じ3挙動が成立することは、ルート網羅テスト
// （csrf-route-coverage.test.ts、S2/N7）が「missing → 403」を全ルートについて機械検査する。
// ここでは validateCSRFToken 自体の分岐（missing/invalid/valid とその応答形状）に絞る。

// PUT /sync/manifest は書き込み前に現在の manifest を独立に読み直す（#609 capability チェック）。
// GET は「まだ manifest が無い」扱いにして、CSRF の検証だけを見たいテストの書き込み成功を妨げない。
function mockManifestWrite(writeSha: string) {
  return mockFetch((input, init) => {
    const method = ((init?.method) ?? 'GET').toUpperCase();
    if (method === 'GET') return jsonResponse({}, { status: 404 });
    return jsonResponse({ content: { sha: writeSha } });
  });
}

describe('PUT /sync/manifest — CSRF検証（3挙動 + F-5 形式検査）', () => {
  const sessionToken = 'sess-manifest';
  const csrfToken = '3c8b9245-a21d-47ac-8e98-fb297ca1c5bc';

  beforeEach(async () => {
    await seedSession(sessionToken);
    await seedCSRF(sessionToken, csrfToken);
  });

  function putManifest(headers: Record<string, string>) {
    return appFetch(
      '/sync/manifest',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ _branch: 'main', files: {} }),
      },
      { 'novel-ide-session': sessionToken },
    );
  }

  it('有効なCSRFトークンで通過（GitHub API エラーになるが 403 ではない）', async () => {
    mockManifestWrite('manifest-sha');
    const res = await putManifest({ 'X-CSRF-Token': csrfToken });
    expect(res.status).toBe(200);
  });

  it('CSRFトークンなしは 403（csrf token missing）', async () => {
    const res = await putManifest({});
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('csrf token missing');
  });

  it('無効なCSRFトークン（KV に無い正しい形式）は 403（csrf token invalid）', async () => {
    // 形式（UUID）は正しいが KV に存在しないトークン。F-5 の形式検査を通過した後、
    // KV lookup で miss することを確認する（形式検査だけで invalid を誤判定していないか）。
    const res = await putManifest({ 'X-CSRF-Token': '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('csrf token invalid');
  });

  // --- F-5: KV 参照前の形式検査 ---

  it('形式不正（UUID でない）は KV を参照せず 403（csrf token invalid）', async () => {
    const getSpy = vi.spyOn(env.SESSIONS, 'get');
    try {
      const res = await putManifest({ 'X-CSRF-Token': 'wrong-token' });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('csrf token invalid');
      // KV lookup（csrf:* キー）が発生していないこと（形式検査で先に弾かれる）
      const csrfCalls = (getSpy.mock.calls as unknown[][]).filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).startsWith('csrf:'),
      );
      expect(csrfCalls).toHaveLength(0);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('512 バイト超のトークンは KV 例外で 500 にならず、403（csrf token invalid）を返す', async () => {
    // Cloudflare KV はキー長 512 バイト超で例外を投げる。形式検査が先に働かないと、
    // `csrf:${sessionToken}:${csrfToken}` が 512 バイトを超え、未処理の KV 例外 → 500 に落ちる。
    const oversized = 'a'.repeat(600);
    const res = await putManifest({ 'X-CSRF-Token': oversized });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('csrf token invalid');
  });

  it('セッションなしは 401', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ _branch: 'main' }),
    });
    expect(res.status).toBe(401);
  });

  it('state-changing リクエストで session KV の二重読み込みが発生しない', async () => {
    mockManifestWrite('manifest-sha');
    const getSpy = vi.spyOn(env.SESSIONS, 'get');

    try {
      const res = await putManifest({ 'X-CSRF-Token': csrfToken });
      expect(res.status).toBe(200);

      // session lookup は requireSession の 1 回のみ（validateCSRFToken では再読みしない）
      const getCalls = getSpy.mock.calls as unknown[][];
      const sessionCalls = getCalls.filter(call => call[0] === `session:${sessionToken}`);
      expect(sessionCalls).toHaveLength(1);
      // CSRF lookup は 1 回
      const csrfCalls = getCalls.filter(call => call[0] === `csrf:${sessionToken}:${csrfToken}`);
      expect(csrfCalls).toHaveLength(1);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('同じCSRFトークンを2回使用しても TTL 内であれば通過する', async () => {
    // 低エントロピーの固定 UUID を使う（ランダムな UUID リテラルは secret scan の
    // generic-api-key に誤検出され、public tree の strict pass〔project allowlist を
    // 持たない〕を落とす）。テストが必要とするのは UUID 形式であることだけ。
    const reusableToken = '00000000-0000-4000-8000-000000000225';
    await seedCSRF(sessionToken, reusableToken);
    mockManifestWrite('manifest-sha');

    // 1回目
    const res1 = await putManifest({ 'X-CSRF-Token': reusableToken });
    expect(res1.status).toBe(200);

    // 2回目: TTL 内であれば同じトークンで通過する（KV eventual consistency のため即時削除しない）
    const res2 = await putManifest({ 'X-CSRF-Token': reusableToken });
    expect(res2.status).toBe(200);
  });
});

// --- PUT /sync/file/:id (CSRF保護 + ID バリデーション) ---
// missing/invalid/valid の3挙動は上の /sync/manifest ブロック + ルート網羅テストで担保済み。
// ここでは file 固有の ID フォーマット検証のみを対象にする。

describe('PUT /sync/file/:id — ID バリデーション', () => {
  const sessionToken = 'sess-file';
  const csrfToken = 'e8e73cc6-f02b-4cf3-b5a2-b2ad4d0a4ee1';

  beforeEach(async () => {
    await seedSession(sessionToken);
    await seedCSRF(sessionToken, csrfToken);
  });

  it('パストラバーサル文字を含むIDは 400', async () => {
    const res = await appFetch(
      '/sync/file/..%2Fmanifest',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ _branch: 'main' }),
      },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });

  // entity write は世代拘束（#609 A-2）により manifest.json を先に読む。ID バリデーションの
  // 焦点を保つため、manifest は空（create-only）・entity は不在として mock する。
  function mockManifestAndAbsentEntity(handler: (input: RequestInfo | URL, init?: RequestInit) => Response) {
    return mockFetch((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
      const path = new URL(url).pathname;
      if (method === 'GET' && path.endsWith('/contents/manifest.json')) {
        return jsonResponse({ content: encodeGitHubContent({ version: 2, files: {} }), sha: 'manifest-sha' });
      }
      if (method === 'GET') return jsonResponse({}, { status: 404 });
      return handler(input, init);
    });
  }

  it('数字のみのID（既存の初期ファイルID）は通過', async () => {
    mockManifestAndAbsentEntity(() => jsonResponse({ content: { sha: 'file-sha' } }));

    const res = await appFetch(
      '/sync/file/1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ _branch: 'main', _manifestSha: 'manifest-sha' }),
      },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(200);
  });

  it('UUID形式のIDは通過', async () => {
    mockManifestAndAbsentEntity(() => jsonResponse({ content: { sha: 'file-sha' } }));

    const res = await appFetch(
      '/sync/file/550e8400-e29b-41d4-a716-446655440000',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ _branch: 'main', _manifestSha: 'manifest-sha' }),
      },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(200);
  });
});

// --- POST /sync/init (repo 作成フローの happy path) ---
// missing/invalid は route 網羅テストで担保済み。init 特有の分岐（repo 不在→作成、
// manifest 初期化）は他のルートのモックでは再現できないためここに残す。

describe('POST /sync/init — 有効な CSRF token での repo 作成フロー', () => {
  const sessionToken = 'sess-init';
  const csrfToken = 'f3633b1b-1b86-4e1d-b559-58854a854db9';

  beforeEach(async () => {
    await seedSession(sessionToken);
    await seedCSRF(sessionToken, csrfToken);
  });

  it('有効なCSRFトークンで通過', async () => {
    // init は repo の存在確認に加えて manifest / entity の状態も見る（#608 の
    // workspace 不整合ガード）。全 path へ同じ body を返すと contents 応答として不正になり
    // upstream corrupt に落ちるため、path ごとに現実的な応答を返す。
    mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.startsWith('/repos/testuser/.novel-ide/contents/')) {
        return jsonResponse({ message: 'Not Found' }, { status: 404 });
      }
      return jsonResponse({ default_branch: 'main' });
    });

    const res = await appFetch(
      '/sync/init',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(200);
  });
});

// --- GET /sync/file/:id (IDバリデーション、CSRF不要) ---

describe('GET /sync/file/:id — IDバリデーション', () => {
  const sessionToken = 'sess-get-file';

  beforeEach(async () => {
    await seedSession(sessionToken);
  });

  it('パストラバーサル文字を含むIDは 400', async () => {
    const res = await appFetch(
      '/sync/file/..%2Fmanifest',
      { method: 'GET' },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid id');
  });

  it('UUID形式のIDはバリデーション通過', async () => {
    mockFetch(() => jsonResponse({
      content: 'eyJuYW1lIjoi44OG44K544OIIn0=',
      sha: 'file-sha',
    }));

    const res = await appFetch(
      '/sync/file/550e8400-e29b-41d4-a716-446655440000',
      { method: 'GET' },
      { 'novel-ide-session': sessionToken },
    );
    expect(res.status).toBe(200);
  });
});
