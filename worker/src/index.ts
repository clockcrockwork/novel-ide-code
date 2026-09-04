import { Hono } from 'hono';
import { authRoutes } from './auth';
import { requireSession, bodySize, validateCSRFToken } from './middleware';
import { rateLimitMiddleware } from './rateLimit';
import { githubProxy } from './github-proxy';
import { syncRoutes } from './sync';
import { FORMAT_CAPABILITY_HEADER } from './syncErrorCodes';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

// Security headers applied to every response (including OPTIONS and error responses)
app.use('*', async (c, next) => {
  try {
    await next();
  } finally {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'");
    if (c.env.ALLOWED_ORIGIN.startsWith('https://')) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  }
});

// CORS — needed for Vite dev server (different port)
app.use('*', async (c, next) => {
  const origin = c.env.ALLOWED_ORIGIN;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // X-Novel-Ide-Format-Version は #609 A-2 で追加した非 safelist ヘッダー。CORS 許可
  // 一覧に無いと preflight が実リクエストを止め、workerFetchWithCSRF を使う全ての
  // 変更系リクエスト（sync・devices 削除・repo 認可等）がクロスオリジン構成で
  // 通信エラーになる（Codex レビュー指摘・AGENTS.md のクロスオリジン方針参照）。
  c.header(
    'Access-Control-Allow-Headers',
    `Content-Type, Accept, X-GitHub-Api-Version, X-CSRF-Token, ${FORMAT_CAPABILITY_HEADER}`,
  );
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
});

app.route('/auth', authRoutes);

// All /github/* and /sync/* routes require a valid session, then apply per-session rate limit
app.use('/github/*', bodySize(5 * 1024 * 1024));
app.use('/github/*', requireSession);
// rateLimit を CSRF より先に適用する（順序は維持。F-1）。取捨:
// - この順序: CSRF 拒否リクエストも rate limit の予算を消費する。同一サイト内の
//   攻撃者（有効セッションを持つがCSRF token を持たない script 等）が limit（60/分）回
//   空振りさせるだけで、以降の正当な GET まで 429 になる（同一 key を共有するため）。
// - 逆順（CSRF を先に）: 未認証 CSRF 検証（無効 token の毎回の KV 読み取り）が
//   rate limit で絞られず無制限に実行され、KV 読み取りコストが際限なく積み上がる。
// 「正当な GET が偶発的に 429 になりうる」より「無制限 KV 読み取り」の方が悪いため、
// 現在の順序（rateLimit → CSRF）を維持する。
app.use('/github/*', rateLimitMiddleware({
  limit: 60,
  windowMs: 60_000,
  keyFn: c => `sess:${c.get('sessionToken')}:github`,
}));
// 変更系（GET/HEAD 以外）は /sync/* と対称に CSRF token を必須にする（Finding M1）。
// safe method のスキップは validateCSRFToken 内に内包されているため、ここはルート個別
// ではなく一括適用の1行で足り、/github/* の変更系ルート追加時の適用漏れを防ぐ。
app.use('/github/*', validateCSRFToken);
app.route('/github', githubProxy);

app.use('/sync/*', bodySize(2 * 1024 * 1024));
app.use('/sync/*', requireSession);
app.use('/sync/*', rateLimitMiddleware({
  limit: 600,
  windowMs: 60_000,
  keyFn: c => `sess:${c.get('sessionToken')}:sync`,
}));
app.route('/sync', syncRoutes);

export default app;
