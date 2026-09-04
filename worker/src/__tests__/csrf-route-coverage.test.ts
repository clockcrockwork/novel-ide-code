import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { syncRoutes } from '../sync';
import { authRoutes } from '../auth';
import type { AppEnv } from '../types';
import { appFetch, jsonResponse, mockFetch, seedSession } from './test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SAFE_METHODS = new Set(['GET', 'HEAD']);

// 既知例外: CSRF token 検証なしで許可する非 GET/HEAD ルート（F-4。/auth/* の見直しは保留）。
// - POST /logout: セッションを破棄する状態変更はあるが、被害は「強制ログアウト」のみで
//   攻撃者に利益がない（fail-safe 方向）。SameSite=Lax + セッション cookie 自動送信に依存。
// - POST /refresh: 状態変更なし（既存 session の login/avatar_url を読み取って返すだけ）。
//   POST だが実質 GET 相当の読み取り専用エンドポイント。
const KNOWN_CSRF_EXCEPTIONS = new Set(['POST /logout', 'POST /refresh']);

// path+method でグルーピングし、そのグループに登録された middleware/handler 名の一覧を返す。
// per-route で `app.put('/x', mw1, mw2, handler)` のように明示適用されたルートは、
// サブアプリ自身の `.routes` に mw1/mw2/handler が並んで現れる（Hono 4 の public API）。
function collectRouteGroups(app: Hono<AppEnv>) {
  const groups = new Map<string, string[]>();
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    const names = groups.get(key) ?? [];
    names.push(r.handler.name);
    groups.set(key, names);
  }
  return groups;
}

describe('worker ルート middleware 網羅（S2/N7）: 変更系ルートは CSRF 保護される', () => {
  it('sync.ts の GET/HEAD 以外の全ルートが validateCSRFToken を経由する', () => {
    const groups = collectRouteGroups(syncRoutes);
    const checked: string[] = [];
    for (const [key, names] of groups) {
      const [method] = key.split(' ');
      if (SAFE_METHODS.has(method)) continue;
      checked.push(key);
      expect(names, `${key} の middleware chain に validateCSRFToken が無い: [${names.join(', ')}]`)
        .toContain('validateCSRFToken');
    }
    // 空集合で「何も検査していない」を偽装しない（sync.ts のルート一覧が変わった時に検出する）。
    expect(checked.length).toBeGreaterThan(0);
  });

  it('auth.ts の GET/HEAD 以外のルートは validateCSRFToken を経由するか、既知例外である', () => {
    const groups = collectRouteGroups(authRoutes);
    const checked: string[] = [];
    const uncovered: string[] = [];
    for (const [key, names] of groups) {
      const [method] = key.split(' ');
      if (SAFE_METHODS.has(method)) continue;
      checked.push(key);
      if (names.includes('validateCSRFToken')) continue;
      if (KNOWN_CSRF_EXCEPTIONS.has(key)) continue;
      uncovered.push(key);
    }
    expect(checked.length).toBeGreaterThan(0);
    expect(uncovered, `CSRF 未保護かつ既知例外にも無い auth ルート: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('既知例外（/auth/logout, /auth/refresh）は実際に CSRF token 無しで通過する（allowlist と実装の不一致を検出）', async () => {
    const sessionToken = 'sess-refresh-logout';
    await seedSession(sessionToken);

    const refreshRes = await appFetch('/auth/refresh', { method: 'POST' }, { 'novel-ide-session': sessionToken });
    expect(refreshRes.status).not.toBe(403);

    const logoutRes = await appFetch('/auth/logout', { method: 'POST' }, { 'novel-ide-session': sessionToken });
    expect(logoutRes.status).not.toBe(403);
  });

  // github-proxy.ts は単一の `ALL /*` ルートで、CSRF は index.ts の
  // `app.use('/github/*', validateCSRFToken)` がプレフィックス単位で適用する（サブルーター
  // 自身の routes には現れないため、上記のような introspection では検出できない）。
  // 実際にフルアプリを通した振る舞いで「/github/* の GET/HEAD 以外は例外なく CSRF で
  // 保護される」ことを機械検査する（endpoint allowlist で許可されないパスでも先に CSRF で
  // 止まることを含む）。
  it('/github/* は GET/HEAD 以外のあらゆるメソッドが CSRF で保護される（endpoint allowlist の内容に関わらず）', async () => {
    const sessionToken = 'sess-github-coverage';
    await seedSession(sessionToken);
    mockFetch(() => jsonResponse({ login: 'testuser' }));

    const getRes = await appFetch('/github/user', {}, { 'novel-ide-session': sessionToken });
    // GET は CSRF 層でブロックされない（許可されたエンドポイントなら 200 まで届く）
    expect(getRes.status).not.toBe(403);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await appFetch(
        '/github/repos/testuser/myrepo/contents/works/a.md',
        { method },
        { 'novel-ide-session': sessionToken },
      );
      expect(res.status, `${method} /github/* が CSRF token 無しで通過した`).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('csrf token missing');
    }
  });
});
