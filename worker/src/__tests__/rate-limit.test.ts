import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appFetch, seedSession, seedCSRF } from './test-utils';

// Each test uses a unique IP to avoid KV state leaking between cases.
// KV persists within a test file (Miniflare in-memory), so isolation is by IP scope.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth エンドポイントの IP rate limit（10回/分）', () => {
  it('上限内は 302 リダイレクトを返す', async () => {
    const res = await appFetch('/auth/github/start', {
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
    });
    expect(res.status).toBe(302);
  });

  it('10回超過で 429 を返し Retry-After ヘッダーが付く', async () => {
    const ip = '10.0.0.2';
    // 10回まで通過
    for (let i = 0; i < 10; i++) {
      await appFetch('/auth/github/start', { headers: { 'CF-Connecting-IP': ip } });
    }
    // 11回目は 429
    const res = await appFetch('/auth/github/start', { headers: { 'CF-Connecting-IP': ip } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('rate limit exceeded');
  });

  it('異なる IP は独立したカウンターを持つ', async () => {
    const ip1 = '10.0.0.3';
    const ip2 = '10.0.0.4';
    // ip1 を 10 回消費
    for (let i = 0; i < 10; i++) {
      await appFetch('/auth/github/start', { headers: { 'CF-Connecting-IP': ip1 } });
    }
    // ip2 は影響を受けない
    const res = await appFetch('/auth/github/start', { headers: { 'CF-Connecting-IP': ip2 } });
    expect(res.status).toBe(302);
  });

  it('/auth/github/callback は独立した rate limit を持つ（start 消費後も通過）', async () => {
    const ip = '10.0.0.5';
    // start を 10 回消費して上限に到達させる
    for (let i = 0; i < 10; i++) {
      await appFetch('/auth/github/start', { headers: { 'CF-Connecting-IP': ip } });
    }
    // start は 429 になるが callback は別カウンターなので通過（302 or non-429）
    const res = await appFetch('/auth/github/callback', {
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(res.status).not.toBe(429);
  });

  it('/auth/github/callback 自身が 10 回超過で 429 を返す', async () => {
    const ip = '10.0.0.6';
    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    await env.SESSIONS.put(`ratelimit:ip:${ip}:auth-callback:${windowIndex}`, '10', { expirationTtl: 61 });
    const res = await appFetch('/auth/github/callback', {
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(res.status).toBe(429);
  });
});

describe('sync エンドポイントのセッション rate limit（600回/分）', () => {
  const sessionToken = 'sess-rl-sync';
  const csrfToken = '15579789-6d94-4eb7-8cc7-aba14e4f2369';
  const cookies = { 'novel-ide-session': sessionToken };

  beforeEach(async () => {
    await seedSession(sessionToken);
    await seedCSRF(sessionToken, csrfToken);
  });

  it('セッション rate limit 超過で 429 を返す', async () => {
    vi.stubGlobal('fetch', () => new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));

    // 600回まで通過（コストが高いので 601 回目だけ確認するため KV に直接書き込む）
    // セッショントークン固有の rate limit キーを直接設定
    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    await env.SESSIONS.put(
      `ratelimit:sess:${sessionToken}:sync:${windowIndex}`,
      '600',
      { expirationTtl: 61 },
    );

    const res = await appFetch('/sync/manifest', {}, cookies);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('別セッションは独立したカウンターを持つ', async () => {
    const sessionToken2 = 'sess-rl-sync-2';
    await seedSession(sessionToken2);
    const cookies2 = { 'novel-ide-session': sessionToken2 };

    vi.stubGlobal('fetch', () => new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));

    // sessionToken のカウンターを上限に設定
    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    await env.SESSIONS.put(
      `ratelimit:sess:${sessionToken}:sync:${windowIndex}`,
      '600',
      { expirationTtl: 61 },
    );

    // sessionToken2 は影響を受けない
    const res = await appFetch('/sync/manifest', {}, cookies2);
    expect(res.status).not.toBe(429);
  });
});

describe('refresh/logout の IP rate limit（60回/分）', () => {
  it('IP rate limit 超過で 429 を返す', async () => {
    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    const ip = '10.1.0.1';
    // IP バジェットを上限に設定
    await env.SESSIONS.put(`ratelimit:ip:${ip}:auth-loose:${windowIndex}`, '60', { expirationTtl: 61 });

    const resA = await appFetch('/auth/refresh', { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    expect(resA.status).toBe(429);
  });

  it('異なる IP は独立したバジェットを持つ', async () => {
    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    const ipA = '10.1.0.2';
    const ipB = '10.1.0.3';

    await env.SESSIONS.put(`ratelimit:ip:${ipA}:auth-loose:${windowIndex}`, '60', { expirationTtl: 61 });

    // ipB は独立しているので通過
    const resB = await appFetch('/auth/refresh', { method: 'POST', headers: { 'CF-Connecting-IP': ipB } });
    expect(resB.status).not.toBe(429);
  });
});

describe('github proxy のセッション rate limit（60回/分）', () => {
  const sessionToken = 'sess-rl-gh';
  const cookies = { 'novel-ide-session': sessionToken };

  beforeEach(async () => {
    await seedSession(sessionToken);
  });

  it('github rate limit 超過で 429 を返す', async () => {
    vi.stubGlobal('fetch', () => new Response(JSON.stringify({ login: 'user' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { env } = await import('./test-utils');
    const windowIndex = Math.floor(Date.now() / 60_000);
    await env.SESSIONS.put(
      `ratelimit:sess:${sessionToken}:github:${windowIndex}`,
      '60',
      { expirationTtl: 61 },
    );

    const res = await appFetch('/github/user', {}, cookies);
    expect(res.status).toBe(429);
  });
});
