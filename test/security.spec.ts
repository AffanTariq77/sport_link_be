import { describe, expect, it } from 'vitest';
import { rateLimit, securityHeaders } from '../src/security/http.js';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => void (headers[k] = v),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return { res, headers };
}
const req = (ip: string, path: string) => ({ ip, path });

describe('rate limit', () => {
  it('limits each IP per window, sign-in code requests more tightly, and resets', () => {
    let t = 0;
    const limit = rateLimit({ windowMs: 60_000, general: 5, auth: 2 }, () => t);
    const call = (ip: string, path = '/venues') => {
      const { res } = fakeRes();
      let passed = false;
      limit(req(ip, path), res, () => (passed = true));
      return passed ? 200 : res.statusCode;
    };
    expect([1, 2, 3, 4, 5].map(() => call('1.1.1.1'))).toEqual([200, 200, 200, 200, 200]);
    expect(call('1.1.1.1')).toBe(429);
    expect(call('2.2.2.2')).toBe(200); // another client is not affected
    expect([
      call('3.3.3.3', '/auth/otp/request'),
      call('3.3.3.3', '/auth/otp/verify'),
      call('3.3.3.3', '/auth/otp/request'),
    ]).toEqual([200, 200, 429]);
    t = 60_001;
    expect(call('1.1.1.1')).toBe(200);
  });
});

describe('security headers', () => {
  it('sets the basics everywhere and CSP plus HSTS in production', () => {
    const dev = fakeRes();
    securityHeaders(false)(req('x', '/'), dev.res, () => undefined);
    expect(dev.headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    expect(dev.headers['Content-Security-Policy']).toBeUndefined();
    const prod = fakeRes();
    securityHeaders(true)(req('x', '/'), prod.res, () => undefined);
    expect(prod.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(prod.headers['Strict-Transport-Security']).toContain('max-age=');
  });
});
