import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appFetch,
  env,
  jsonResponse,
  mockFetch,
  seedCSRF,
  seedSession,
} from './test-utils';

const sessionToken = 'sess-sec';
const csrfToken = '0fdcafce-de3c-4f4e-bc3c-f077ebaea074';
const cookies = { 'novel-ide-session': sessionToken };
const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };

beforeEach(async () => {
  await seedSession(sessionToken);
  await seedCSRF(sessionToken, csrfToken);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockGitHub404() {
  return mockFetch(() => jsonResponse({ message: 'Not Found' }, { status: 404 }));
}

describe('セキュリティレスポンスヘッダー', () => {
  it('X-Content-Type-Options: nosniff が付与される', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {}, cookies);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('X-Frame-Options: DENY が付与される', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {}, cookies);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('Referrer-Policy: no-referrer が付与される', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {}, cookies);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('CORS — 許可外オリジン', () => {
  it('ALLOWED_ORIGIN 以外のオリジンに Access-Control-Allow-Origin を返さない', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {
      headers: { Origin: 'https://evil.example.com' },
    }, cookies);
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('https://evil.example.com');
  });
});

describe('壊れた JSON の安全な処理', () => {
  it('PUT /sync/manifest に不正 JSON を送ると 400 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: 'not json at all',
    }, cookies);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('SyntaxError');
  });

  it('PUT /sync/file/:id に空ボディを送ると 400 を返す', async () => {
    const res = await appFetch('/sync/file/valid-id-123', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: '',
    }, cookies);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('SyntaxError');
  });
});

describe('エラーレスポンスに GitHub 内部情報が含まれない', () => {
  it('GitHub が詳細エラーを返しても、クライアントレスポンスに GitHub のメッセージが含まれない', async () => {
    mockFetch(() =>
      jsonResponse(
        { message: 'Validation Failed: sha does not match' },
        { status: 422 },
      ),
    );
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: csrfHeaders,
      body: JSON.stringify({ _branch: 'main', _sha: 'old-sha', files: {} }),
    }, cookies);
    // 422 は validation として分類され（#608 A-1）、conflict にも 500 にも潰さない。
    // 分類が変わっても GitHub の message を透過しないことは維持する。
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('Validation Failed');
    expect(JSON.stringify(body)).not.toContain('sha does not match');
  });
});

describe('未サポート HTTP メソッド', () => {
  it('PATCH /sync/manifest は 405 または 404 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PATCH',
      headers: csrfHeaders,
      body: JSON.stringify({}),
    }, cookies);
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /sync/manifest は 405 または 404 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'DELETE',
      headers: csrfHeaders,
    }, cookies);
    expect([404, 405]).toContain(res.status);
  });
});

describe('CORS — Origin スプーフィング追加パターン', () => {
  it("Origin: 'null' に ACAO として null を返さない", async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {
      headers: { Origin: 'null' },
    }, cookies);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('null');
  });

  it('ALLOWED_ORIGIN のサフィックスを含む evil ドメインを許可しない', async () => {
    mockGitHub404();
    const evilOrigin = `${env.ALLOWED_ORIGIN}.evil.example.com`;
    const res = await appFetch('/sync/manifest', {
      headers: { Origin: evilOrigin },
    }, cookies);
    expect(res.headers.get('access-control-allow-origin')).not.toBe(evilOrigin);
  });
});

describe('Content-Type バリデーション', () => {
  it('Content-Type: text/plain で PUT すると 415 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ _branch: 'main', files: {} }),
    }, cookies);
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('SyntaxError');
  });

  it('Content-Type なしで PUT すると 415 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { 'X-CSRF-Token': csrfToken },
      body: 'plain text body',
    }, cookies);
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('SyntaxError');
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('Content-Type: application/json は通過する（バリデーションエラーになる）', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: 'not json at all',
    }, cookies);
    // requireJsonBody は通過し、JSON パース失敗で 400
    expect(res.status).toBe(400);
  });
});

describe('Body size バリデーション', () => {
  it('Content-Length が 2MB 超で 413 を返す', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Content-Length': String(2 * 1024 * 1024 + 1),
      },
      body: '{}',
    }, cookies);
    expect(res.status).toBe(413);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeTruthy();
  });

  it('Content-Length が 2MB 以内は通過する', async () => {
    const res = await appFetch('/sync/manifest', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Content-Length': String(2 * 1024 * 1024),
      },
      body: 'not json at all',
    }, cookies);
    // body size は通過、JSON パース失敗で 400
    expect(res.status).toBe(400);
  });
});

describe('追加セキュリティヘッダー', () => {
  it('Content-Security-Policy: default-src none が付与される', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {}, cookies);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('テスト環境（localhost）では Strict-Transport-Security が付与されない', async () => {
    mockGitHub404();
    const res = await appFetch('/sync/manifest', {}, cookies);
    // ALLOWED_ORIGIN が localhost のため HSTS は付与されない
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});
