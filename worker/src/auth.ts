import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { requireSession, validateCSRFToken, requireJsonBody } from './middleware';
import { validateOwnerRepo } from './validation';
import { rateLimitMiddleware, clientIp } from './rateLimit';
import type { AppEnv } from './types';

export const SESSION_TTL = 30 * 24 * 60 * 60;
export const CSRF_TOKEN_TTL = 60 * 60;

type GitHubUser = {
  login: string;
  avatar_url: string;
  id: number;
};

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

const ipRateLimitStart = rateLimitMiddleware({
  limit: 10,
  windowMs: 60_000,
  keyFn: c => `ip:${clientIp(c)}:auth-start`,
});

const ipRateLimitCallback = rateLimitMiddleware({
  limit: 10,
  windowMs: 60_000,
  keyFn: c => `ip:${clientIp(c)}:auth-callback`,
});

// 純 IP ベース。KV lookup なしで DoS リスクを排除。NAT 配下を考慮して 60/min に設定。
const ipRateLimitLoose = rateLimitMiddleware({
  limit: 60,
  windowMs: 60_000,
  keyFn: c => `ip:${clientIp(c)}:auth-loose`,
});

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/github/start', ipRateLimitStart, async (c) => {
  const state = crypto.randomUUID();
  await c.env.SESSIONS.put(`state:${state}`, '1', { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    scope: 'repo',
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

authRoutes.get('/github/callback', ipRateLimitCallback, async (c) => {
  const { code, state } = c.req.query();
  const origin = c.env.ALLOWED_ORIGIN;

  if (!code || !state) return c.redirect(`${origin}?auth=error`);

  const stored = await c.env.SESSIONS.get(`state:${state}`);
  if (!stored) return c.redirect(`${origin}?auth=error`);
  await c.env.SESSIONS.delete(`state:${state}`);

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as TokenResponse;
  if (!tokenData.access_token) return c.redirect(`${origin}?auth=error`);

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!userRes.ok) return c.redirect(`${origin}?auth=error`);
  const user = (await userRes.json()) as GitHubUser;

  const sessionToken = crypto.randomUUID();
  await c.env.SESSIONS.put(
    `session:${sessionToken}`,
    JSON.stringify({
      githubToken: tokenData.access_token,
      login: user.login,
      avatarUrl: user.avatar_url,
      expiresAt: Date.now() + SESSION_TTL * 1000,
    }),
    { expirationTtl: SESSION_TTL }
  );

  const isLocalhost = origin.startsWith('http://localhost');
  setCookie(c, 'novel-ide-session', sessionToken, {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: 'Lax',
    maxAge: SESSION_TTL,
    path: '/',
  });

  return c.redirect(`${origin}?auth=success`);
});

authRoutes.post('/refresh', ipRateLimitLoose, async (c) => {
  const sessionToken = getCookie(c, 'novel-ide-session');
  if (!sessionToken) return c.json({ error: 'no session' }, 401);

  const raw = await c.env.SESSIONS.get(`session:${sessionToken}`);
  if (!raw) return c.json({ error: 'session expired' }, 401);

  const session = JSON.parse(raw) as { login: string; avatarUrl: string; expiresAt: number };
  if (session.expiresAt < Date.now()) {
    await c.env.SESSIONS.delete(`session:${sessionToken}`);
    return c.json({ error: 'session expired' }, 401);
  }

  return c.json({ login: session.login, avatar_url: session.avatarUrl });
});

authRoutes.get('/csrf-token', requireSession, async (c) => {
  const sessionToken = c.get('sessionToken');
  const csrfToken = crypto.randomUUID();

  await c.env.SESSIONS.put(`csrf:${sessionToken}:${csrfToken}`, '1', {
    expirationTtl: CSRF_TOKEN_TTL,
  });

  return c.json({ csrfToken, expiresIn: CSRF_TOKEN_TTL }, 200, { 'Cache-Control': 'no-store' });
});

// POST /auth/authorize-repo — ユーザーが明示選択した repo を認可リストに追加する。
// worker セッション（KV）の authorizedRepos が repo 境界照合の唯一の正（#283）。
authRoutes.post('/authorize-repo', requireSession, requireJsonBody, validateCSRFToken, async (c) => {
  const sessionToken = c.get('sessionToken');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON' }, 400);
  const { owner, repo } = body as Record<string, unknown>;
  if (validateOwnerRepo(owner, repo) !== null) return c.json({ error: 'invalid repository' }, 400);

  // requireSession が検証済みのセッション JSON を再利用し KV の二重読み込みを回避する（#283）。
  const session = JSON.parse(c.get('sessionRaw')) as {
    expiresAt: number;
    authorizedRepos?: string[];
  } & Record<string, unknown>;

  // requireSession 後の処理遅延でセッションが期限切れになった場合を防ぐ（#283）。
  if (session.expiresAt <= Date.now()) return c.json({ error: 'session expired' }, 401);

  const slug = `${(owner as string).toLowerCase()}/${(repo as string).toLowerCase()}`;

  // 並行 authorize リクエストによる Lost Update を緩和するため書き込み直前に最新セッションを再取得する。
  // KV に CAS がないため完全な排他は不可だが、ウィンドウを大幅に縮小できる（#283）。
  // latestRaw が null = 並行ログアウトでセッションが削除済み → 復活させず 401 を返す（#283）。
  const latestRaw = await c.env.SESSIONS.get(`session:${sessionToken}`);
  if (!latestRaw) return c.json({ error: 'session expired' }, 401);

  const latestSession = JSON.parse(latestRaw) as typeof session;
  if (latestSession.expiresAt <= Date.now()) return c.json({ error: 'session expired' }, 401);

  const current = Array.isArray(latestSession.authorizedRepos) ? latestSession.authorizedRepos : [];
  if (!current.includes(slug)) {
    const ttl = Math.max(60, Math.floor((latestSession.expiresAt - Date.now()) / 1000));
    await c.env.SESSIONS.put(
      `session:${sessionToken}`,
      JSON.stringify({ ...latestSession, authorizedRepos: [...current, slug] }),
      { expirationTtl: ttl }
    );
  }
  return c.json({ ok: true });
});

authRoutes.post('/logout', ipRateLimitLoose, async (c) => {
  const sessionToken = getCookie(c, 'novel-ide-session');
  if (sessionToken) await c.env.SESSIONS.delete(`session:${sessionToken}`);
  deleteCookie(c, 'novel-ide-session', { path: '/' });
  return c.json({ ok: true });
});
