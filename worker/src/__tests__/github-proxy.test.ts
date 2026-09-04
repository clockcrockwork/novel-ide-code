import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appFetch, env, jsonResponse, mockFetch, seedSession, seedCSRF, makeSession } from './test-utils';

const sessionToken = 'sess-github-proxy';
const cookies = { 'novel-ide-session': sessionToken };
const csrfToken = 'ab149f36-6fe0-4936-ad6c-79da66d9856a';
const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };

beforeEach(async () => {
  await seedSession(sessionToken);
  await seedCSRF(sessionToken, csrfToken);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CORS', () => {
  it('preflight は認証なしで 204 と CORS ヘッダーを返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-CSRF-Token');
    // #609 A-2 の capability ヘッダー。preflight の許可一覧に無いとクロスオリジン構成で
    // workerFetchWithCSRF を使う全変更系リクエストが実リクエストへ進めない（Codex 指摘）。
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Novel-Ide-Format-Version');
  });
});

describe('/github proxy', () => {
  it('未認証リクエストは GitHub に転送せず 401', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/user');

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('許可済み GET /user を Authorization 付きで転送する', async () => {
    const fetchMock = mockFetch(() => jsonResponse(
      { login: 'testuser' },
      { headers: { 'X-RateLimit-Remaining': '42' } },
    ));

    const res = await appFetch('/github/user', {}, cookies);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-remaining')).toBe('42');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe('https://api.github.com/user');
    expect(init?.method).toBe('GET');
    expect(headers.get('authorization')).toBe('Bearer gh_test_token');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('許可済み contents PUT は body をそのまま転送する', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));
    const body = JSON.stringify({ message: 'sync', content: 'abc', branch: 'main' });

    const res = await appFetch('/github/repos/testuser/.novel-ide/contents/files/1.json', {
      method: 'PUT',
      headers: csrfHeaders,
      body,
    }, cookies);

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/testuser/.novel-ide/contents/files/1.json');
    expect(init?.method).toBe('PUT');
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
  });

  it('許可外の GitHub endpoint は 403 で止める', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/repos/testuser/.novel-ide/issues', {}, cookies);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'GitHub endpoint not allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('想定外 method は許可済み path でも 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/user/repos', { method: 'POST', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /repos/{owner}/{repo}/branches は許可', async () => {
    const fetchMock = mockFetch(() => jsonResponse([{ name: 'main' }]));

    const res = await appFetch('/github/repos/testuser/myrepo/branches', {}, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/testuser/myrepo/branches');
  });

  it('GET /repos/{owner}/{repo}/pulls は許可', async () => {
    const fetchMock = mockFetch(() => jsonResponse([]));

    const res = await appFetch('/github/repos/testuser/myrepo/pulls?state=open', {}, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('POST /repos/{owner}/{repo}/pulls は許可', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ number: 1, html_url: 'https://github.com/testuser/myrepo/pull/1' }));
    const body = JSON.stringify({ title: 'test', head: 'feature', base: 'main' });

    const res = await appFetch('/github/repos/testuser/myrepo/pulls', {
      method: 'POST',
      headers: csrfHeaders,
      body,
    }, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/testuser/myrepo/pulls');
    expect(init?.method).toBe('POST');
  });

  it('PUT /repos/{owner}/{repo}/pulls/{number}/merge は許可', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ merged: true }));

    const res = await appFetch('/github/repos/testuser/myrepo/pulls/42/merge', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({}),
    }, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/testuser/myrepo/pulls/42/merge');
  });

  it('POST /repos/{owner}/{repo}/issues はブロック', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/repos/testuser/myrepo/issues', { method: 'POST', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DELETE /repos/{owner}/{repo}/pulls/42 はブロック', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/repos/testuser/myrepo/pulls/42', { method: 'DELETE', headers: csrfHeaders }, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUT /repos/{owner}/{repo}/pulls/42（merge なし）はブロック', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/repos/testuser/myrepo/pulls/42', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({}),
    }, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /repos/{owner}/{repo}/pulls/42/reviews はブロック', async () => {
    const fetchMock = mockFetch(() => jsonResponse([]));

    const res = await appFetch('/github/repos/testuser/myrepo/pulls/42/reviews', {}, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/github proxy — token 失効時のセッション破棄（#288）', () => {
  it('GitHub API が 401 を返したら KV セッションを破棄し 401 を返す', async () => {
    mockFetch(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));

    expect(await env.SESSIONS.get(`session:${sessionToken}`)).not.toBeNull();

    const res = await appFetch('/github/user', {}, cookies);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'GitHub token revoked, please re-login' });
    expect(await env.SESSIONS.get(`session:${sessionToken}`)).toBeNull();
  });

  it('GitHub API が 403 を返してもセッションを破棄せずそのまま返す（権限不足は失効ではない）', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ message: 'Forbidden' }, { status: 403 }));

    const res = await appFetch('/github/user', {}, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await env.SESSIONS.get(`session:${sessionToken}`)).not.toBeNull();
  });
});

describe('/github proxy — 書き込みパス検証', () => {
  const putBody = JSON.stringify({ message: 'test', content: 'abc', branch: 'main' });
  const putOpts = { method: 'PUT', headers: csrfHeaders, body: putBody };

  it('.github/workflows/ci.yml への PUT は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/.github/workflows/ci.yml',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Write path not allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('.env への PUT は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/.env',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('package.json への PUT は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/package.json',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('パストラバーサル含む PUT は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/works%2F..%2F.github%2Fworkflows%2Fci.yml',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('通常の .md ファイルへの PUT は通過する', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/works/chapter1.md',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('GET .github/workflows/ci.yml は通過する（読み取りはブロックしない）', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ type: 'file', content: '' }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/.github/workflows/ci.yml',
      {},
      cookies,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('空セグメント（//）を含む PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/path//.github/workflows/ci.yml',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Empty path segments are not allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('末尾スラッシュ付き GET は通過する（ディレクトリ一覧取得）', async () => {
    const fetchMock = mockFetch(() => jsonResponse([{ name: 'chapter1.md', type: 'file' }]));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/works/',
      {},
      cookies,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('パスなし PUT（/contents のみ）は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不正なURIエンコーディング（%FF）を含む PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(
      '/github/repos/testuser/myrepo/contents/works%FF',
      putOpts,
      cookies,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid path encoding' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/github proxy — branch 検証（#287）', () => {
  const putWith = (branch?: string) => ({
    method: 'PUT',
    headers: csrfHeaders,
    body: JSON.stringify(branch === undefined
      ? { message: 'test', content: 'abc' }
      : { message: 'test', content: 'abc', branch }),
  });
  const path = '/github/repos/testuser/myrepo/contents/works/chapter1.md';

  it('無効 branch（../evil）の PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(path, putWith('../evil'), cookies);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid branch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('無効 branch（a@{0}）の PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(path, putWith('a@{0}'), cookies);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('有効 branch（feature/add-x）の PUT は通過する', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));

    const res = await appFetch(path, putWith('feature/add-x'), cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('branch 省略の PUT は通過する（デフォルトブランチ）', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));

    const res = await appFetch(path, putWith(undefined), cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('非文字列 branch（null）の PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(path, {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ message: 'test', content: 'abc', branch: null }),
    }, cookies);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid branch' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非文字列 branch（数値）の PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(path, {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ message: 'test', content: 'abc', branch: 123 }),
    }, cookies);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不正な JSON body の contents PUT は 400', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(path, {
      method: 'PUT',
      headers: csrfHeaders,
      body: 'not-json',
    }, cookies);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/github proxy — repo 境界照合（#283）', () => {
  const putBody = JSON.stringify({ message: 'test', content: 'abc', branch: 'main' });
  const putOpts = { method: 'PUT', headers: csrfHeaders, body: putBody };

  it('認可済み repo への PUT は通過する', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));

    const res = await appFetch('/github/repos/testuser/myrepo/contents/works/a.md', putOpts, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('認可外 repo への GET（fetch）は 403 で GitHub に転送しない', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));

    const res = await appFetch('/github/repos/attacker/secret/contents/works/a.md', {}, cookies);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Repository not authorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認可外 repo への PUT（commit）は 403 で GitHub に転送しない', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch('/github/repos/attacker/secret/contents/works/a.md', putOpts, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認可外 repo への POST /pulls は 403 で GitHub に転送しない', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ number: 1 }));

    const res = await appFetch('/github/repos/attacker/secret/pulls', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ title: 't', head: 'f', base: 'main' }),
    }, cookies);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('{login}/.novel-ide は authorizedRepos に無くても常に許可', async () => {
    const noAuthToken = 'sess-no-auth-repos';
    await seedSession(noAuthToken, makeSession({ authorizedRepos: [] }));
    await seedCSRF(noAuthToken, csrfToken);
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new-sha' } }));

    const res = await appFetch(
      '/github/repos/testuser/.novel-ide/contents/manifest.json',
      putOpts,
      { 'novel-ide-session': noAuthToken },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('repo 照合は case-insensitive', async () => {
    const fetchMock = mockFetch(() => jsonResponse([{ name: 'main' }]));

    const res = await appFetch('/github/repos/TestUser/MyRepo/branches', {}, cookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// token 無し → 403 csrf token missing の網羅は csrf-route-coverage.test.ts が担う
// （S2/N7。/github/* への POST/PUT/DELETE/PATCH を対象に機械検査済み）。ここでは
// 不正 token（形式は正しいが KV に無い）のみを対象にする。正しい token での成功系は
// 上の '/github proxy' describe（許可済み contents PUT・POST /pulls・PUT merge 等）が担う。
describe('/github proxy — CSRF token 検証（Finding M1）', () => {
  const putBody = JSON.stringify({ message: 'test', content: 'abc', branch: 'main' });
  const contentsPath = '/github/repos/testuser/myrepo/contents/works/chapter1.md';

  it('不正な CSRF token の contents PUT は 403', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ content: { sha: 'new' } }));

    const res = await appFetch(contentsPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong-token' },
      body: putBody,
    }, cookies);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'csrf token invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/auth/authorize-repo（#283）', () => {
  const sessToken = 'sess-authorize';
  const csrfToken = '2c6be2c6-9801-4474-9b29-6b4b519dfd9c';
  const authCookies = { 'novel-ide-session': sessToken };

  beforeEach(async () => {
    await seedSession(sessToken, makeSession({ authorizedRepos: [] }));
    await seedCSRF(sessToken, csrfToken);
  });

  const post = (body: unknown, withCsrf = true) =>
    appFetch('/auth/authorize-repo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(withCsrf ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }, authCookies);

  it('repo 登録後、その repo への proxy アクセスが通る', async () => {
    const authRes = await post({ owner: 'newowner', repo: 'newrepo' });
    expect(authRes.status).toBe(200);

    const fetchMock = mockFetch(() => jsonResponse([{ name: 'main' }]));
    const res = await appFetch('/github/repos/newowner/newrepo/branches', {}, authCookies);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('CSRF トークン無しは 403', async () => {
    const res = await post({ owner: 'newowner', repo: 'newrepo' }, false);
    expect(res.status).toBe(403);
  });

  it('不正な owner（../）は 400', async () => {
    const res = await post({ owner: '../evil', repo: 'r' });
    expect(res.status).toBe(400);
  });

  it('空の repo は 400', async () => {
    const res = await post({ owner: 'o', repo: '' });
    expect(res.status).toBe(400);
  });

  it('未認証は 401', async () => {
    const res = await appFetch('/auth/authorize-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'o', repo: 'r' }),
    });
    expect(res.status).toBe(401);
  });
});
