import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './types';

export function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

export function rateLimitMiddleware(opts: {
  limit: number;
  windowMs: number;
  keyFn: (c: Context<AppEnv>) => string | Promise<string>;
}): MiddlewareHandler<AppEnv> {
  const windowSec = Math.ceil(opts.windowMs / 1000);
  return async (c, next) => {
    const key = await opts.keyFn(c);
    const windowIndex = Math.floor(Date.now() / opts.windowMs);
    const kvKey = `ratelimit:${key}:${windowIndex}`;

    const raw = await c.env.SESSIONS.get(kvKey);
    const count = raw ? (parseInt(raw, 10) || 0) : 0;

    if (count >= opts.limit) {
      const remainingSec = Math.ceil((opts.windowMs - (Date.now() % opts.windowMs)) / 1000);
      c.header('Retry-After', String(remainingSec));
      return c.json({ error: 'rate limit exceeded' }, 429);
    }

    await c.env.SESSIONS.put(kvKey, String(count + 1), { expirationTtl: Math.max(60, windowSec + 1) });
    return next();
  };
}
