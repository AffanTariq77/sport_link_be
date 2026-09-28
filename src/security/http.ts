// The parts of Express's request and response these middlewares use.
type Req = { ip?: string; path: string };
type Res = { setHeader(name: string, value: string): void; status(code: number): { json(body: unknown): void } };
type Next = () => void;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Security headers for a JSON API (spec 16). No CORS headers: browsers never call the API directly (the web apps
 * call it from their servers, the mobile app is not a browser), so cross-origin requests stay blocked.
 */
export function securityHeaders(production: boolean) {
  return (_req: Req, res: Res, next: Next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // The API serves JSON and images only. The docs UI needs scripts, but it only exists outside production.
    if (production) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  };
}

/**
 * Fixed-window rate limit per client IP (spec 16: rate limiting per IP). Sign-in code requests get a tighter limit
 * on top of the per-phone limits in AuthService.
 * ponytail: in memory, so each API instance counts separately; move to Redis when running more than one instance.
 */
export function rateLimit(opts: { windowMs: number; general: number; auth: number }, now = () => Date.now()) {
  const hits = new Map<string, { start: number; general: number; auth: number }>();
  let lastSweep = now();
  return (req: Req, res: Res, next: Next) => {
    const t = now();
    if (t - lastSweep > opts.windowMs) {
      for (const [key, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(key);
      lastSweep = t;
    }
    const key = req.ip ?? 'unknown';
    // Our own web and admin servers call from this machine on behalf of many users; one shared budget would lock
    // everyone out. ponytail: have them forward the client IP (X-Forwarded-For) and count that instead.
    if (LOOPBACK.has(key)) return next();
    const entry = hits.get(key);
    const window = entry && t - entry.start < opts.windowMs ? entry : { start: t, general: 0, auth: 0 };
    window.general++;
    const isAuth = req.path.startsWith('/auth/otp') || req.path === '/admin/auth/login';
    if (isAuth) window.auth++;
    hits.set(key, window);
    if (window.general > opts.general || (isAuth && window.auth > opts.auth)) {
      res.setHeader('Retry-After', String(Math.ceil((window.start + opts.windowMs - t) / 1000)));
      res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' });
      return;
    }
    next();
  };
}
