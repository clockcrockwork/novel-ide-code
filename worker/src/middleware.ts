import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

// GitHub token 失効時に KV セッションを破棄する（#288）。
// 401 のみを失効とみなす。403 はレート制限・権限不足など非失効の理由が多く、
// セッション破棄対象にしない（誤った強制再ログインを防ぐ）。
// 失効を検出してセッションを破棄した場合 true を返す。
export async function revokeSessionIfTokenInvalid(
  c: Context<AppEnv>,
  status: number,
): Promise<boolean> {
  if (status !== 401) return false;
  const sessionToken = c.get('sessionToken');
  if (sessionToken) await c.env.SESSIONS.delete(`session:${sessionToken}`);
  return true;
}

export const requireJsonBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ct = (c.req.header('Content-Type') ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  return next();
};

export function bodySize(maxBytes: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }) as MiddlewareHandler<AppEnv>;
}

type Session = {
  githubToken: string;
  login: string;
  expiresAt: number;
  authorizedRepos?: string[];
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sessionToken = getCookie(c, 'novel-ide-session');
  if (!sessionToken) return c.json({ error: 'unauthorized' }, 401);

  const raw = await c.env.SESSIONS.get(`session:${sessionToken}`);
  if (!raw) return c.json({ error: 'unauthorized' }, 401);

  const session = JSON.parse(raw) as Session;
  if (session.expiresAt < Date.now()) {
    await c.env.SESSIONS.delete(`session:${sessionToken}`);
    return c.json({ error: 'session expired' }, 401);
  }

  c.set('githubToken', session.githubToken);
  c.set('login', session.login);
  c.set('sessionToken', sessionToken);
  c.set('authorizedRepos', Array.isArray(session.authorizedRepos) ? session.authorizedRepos : []);
  c.set('sessionRaw', raw);
  return next();
};

// safe method（GET/HEAD）は状態変更を伴わないため CSRF 検証の対象外。
// ここで内包することで、呼び出し側（index.ts）はメソッド判定を書かずに
// `app.use('/github/*', validateCSRFToken)` の1行で /sync/* と対称な適用ができる。
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD']);

// auth.ts の /auth/csrf-token が発行する形式（crypto.randomUUID()）に一致する正規表現。
// KV 参照前にここで形式検査する（F-5）: Cloudflare KV のキーは 512 バイト超で例外を投げる。
// 形式検査なしで `csrf:${sessionToken}:${csrfToken}` を直接 KV get に渡すと、攻撃者が
// 512 バイト超のヘッダー値を送るだけで KV 例外 → 未処理エラー → 500 に落ちうる
// （本来 403 で済むはずの「無効な token」が 500 として観測される）。
// crypto.randomUUID() は常に小文字 hex を返すため大文字は受理しない（大文字許容にすると
// 形式検査は通るが KV キーは大文字小文字を区別するため必ず invalid になり、紛らわしい）。
export const CSRF_TOKEN_FORMAT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// CSRF トークンは削除せず TTL で失効させる（KV の eventual consistency により即時削除は信頼できない）。
export const validateCSRFToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (CSRF_SAFE_METHODS.has(c.req.method)) return next();

  const sessionToken = c.get('sessionToken');
  if (!sessionToken) return c.json({ error: 'unauthorized' }, 401);

  const csrfToken = c.req.header('X-CSRF-Token');
  if (!csrfToken) return c.json({ error: 'csrf token missing' }, 403);
  if (!CSRF_TOKEN_FORMAT_RE.test(csrfToken)) return c.json({ error: 'csrf token invalid' }, 403);

  const kvKey = `csrf:${sessionToken}:${csrfToken}`;
  const stored = await c.env.SESSIONS.get(kvKey);
  if (!stored) return c.json({ error: 'csrf token invalid' }, 403);

  return next();
};
