import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AuthError, AuthService } from '../src/auth/auth.service.js';
import { normalisePhone } from '../src/auth/phone.js';
import { users } from '../src/db/schema.js';
import { ensurePakistan, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const sent: { phone: string; text: string }[] = [];
const service = new AuthService(db, { send: async (phone, text) => void sent.push({ phone, text }) });
afterAll(() => pool.end());
beforeAll(() => ensurePakistan(db));

// Fake numbers only. Each test uses its own so rate limits do not interact.
let n = 0;
const nextPhone = () => `0301 ${String(10_000_000 + ++n).slice(1)}`;
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const lastCode = () => /\b(\d{6})\b/.exec(sent.at(-1)!.text)![1]!;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof AuthError ? e.code : Promise.reject(e)),
  );

async function signIn(phone = nextPhone()) {
  await service.requestOtp({ phone, now: NOW });
  return service.verifyOtp({ phone, code: lastCode(), now: later(10) });
}

describe('phone numbers', () => {
  it('normalises Pakistani mobile formats to E.164', () => {
    for (const input of ['03001234567', '0300 1234567', '+92 300 1234567', '923001234567', '0092-300-1234567']) {
      expect(normalisePhone(input)).toEqual({ phone: '+923001234567', countryCode: 'PK' });
    }
  });

  it('rejects landlines, short numbers and other countries', () => {
    for (const input of ['0421234567', '0300123456', '+971501234567', 'abc']) expect(normalisePhone(input)).toBeNull();
  });
});

describe('OTP sign-in', () => {
  it('creates the account on first sign-in and signs in again without duplicating it', async () => {
    const phone = nextPhone();
    const first = await signIn(phone);
    expect(first.isNewUser).toBe(true);
    expect(first.user).not.toHaveProperty('phone');

    await service.requestOtp({ phone, now: later(120) });
    const second = await service.verifyOtp({ phone, code: lastCode(), now: later(130) });
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it('a code works once only', async () => {
    const phone = nextPhone();
    await service.requestOtp({ phone, now: NOW });
    const otp = lastCode();
    await service.verifyOtp({ phone, code: otp, now: later(5) });
    expect(await code(service.verifyOtp({ phone, code: otp, now: later(6) }))).toBe('INVALID_CODE');
  });

  it('rejects an expired code', async () => {
    const phone = nextPhone();
    await service.requestOtp({ phone, now: NOW });
    expect(await code(service.verifyOtp({ phone, code: lastCode(), now: later(301) }))).toBe('INVALID_CODE');
  });

  it('locks the number for 30 minutes after 5 wrong codes, even with parallel guesses', async () => {
    const phone = nextPhone();
    await service.requestOtp({ phone, now: NOW });
    const right = lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => code(service.verifyOtp({ phone, code: wrong, now: later(5) }))),
    );
    expect(results.filter((r) => r === 'LOCKED').length).toBeGreaterThanOrEqual(1);
    expect(results).not.toContain('OK');

    expect(await code(service.verifyOtp({ phone, code: right, now: later(10) }))).toBe('LOCKED');
    expect(await code(service.requestOtp({ phone, now: later(29 * 60) }))).toBe('LOCKED');
    expect(await code(service.requestOtp({ phone, now: later(31 * 60) }))).toBe('OK');
  });

  it('enforces the 60 second resend timer and 5 codes per hour', async () => {
    const phone = nextPhone();
    expect(await code(service.requestOtp({ phone, now: NOW }))).toBe('OK');
    expect(await code(service.requestOtp({ phone, now: later(30) }))).toBe('RATE_LIMITED');
    for (let i = 1; i < 5; i++) expect(await code(service.requestOtp({ phone, now: later(i * 61) }))).toBe('OK');
    expect(await code(service.requestOtp({ phone, now: later(5 * 61) }))).toBe('RATE_LIMITED');
    expect(await code(service.requestOtp({ phone, now: later(3700) }))).toBe('OK');
  });

  it('refuses banned accounts', async () => {
    const phone = nextPhone();
    const { user } = await signIn(phone);
    await db.update(users).set({ status: 'banned' }).where(eq(users.id, user.id));
    await service.requestOtp({ phone, now: later(120) });
    expect(await code(service.verifyOtp({ phone, code: lastCode(), now: later(130) }))).toBe('ACCOUNT_BLOCKED');
  });
});

describe('DEV_OTP_CODE', () => {
  it('uses the fixed code instead of a random one', async () => {
    const fixed = new AuthService(db, { send: async () => undefined }, '123456');
    const phone = nextPhone();
    await fixed.requestOtp({ phone, now: NOW });
    expect((await fixed.verifyOtp({ phone, code: '123456', now: later(5) })).isNewUser).toBe(true);
  });
});

describe('sessions', () => {
  it('access token authenticates until it expires', async () => {
    const s = await signIn();
    expect((await service.authenticate(s.accessToken, later(60)))?.user.id).toBe(s.user.id);
    expect(await service.authenticate(s.accessToken, later(16 * 60))).toBeNull();
    expect(await service.authenticate('not-a-token', later(60))).toBeNull();
  });

  it('refresh rotates both tokens and the old access token stops working', async () => {
    const s = await signIn();
    const r = await service.refresh({ refreshToken: s.refreshToken, now: later(60) });
    expect(r.refreshToken).not.toBe(s.refreshToken);
    expect(await service.authenticate(s.accessToken, later(61))).toBeNull();
    expect((await service.authenticate(r.accessToken, later(61)))?.user.id).toBe(s.user.id);
  });

  it('reusing an old refresh token revokes the session', async () => {
    const s = await signIn();
    const r = await service.refresh({ refreshToken: s.refreshToken, now: later(60) });
    expect(await code(service.refresh({ refreshToken: s.refreshToken, now: later(70) }))).toBe('INVALID_TOKEN');
    expect(await service.authenticate(r.accessToken, later(71))).toBeNull();
    expect(await code(service.refresh({ refreshToken: r.refreshToken, now: later(72) }))).toBe('INVALID_TOKEN');
  });

  it('a parallel refresh with the same token fails without signing the user out', async () => {
    const s = await signIn();
    const r = await service.refresh({ refreshToken: s.refreshToken, now: later(60) });
    expect(await code(service.refresh({ refreshToken: s.refreshToken, now: later(62) }))).toBe('INVALID_TOKEN');
    expect((await service.authenticate(r.accessToken, later(63)))?.user.id).toBe(s.user.id);
  });

  it('logout and bans take effect on the next request', async () => {
    const a = await signIn();
    await service.logout((await service.authenticate(a.accessToken, later(20)))!.sessionId, later(20));
    expect(await service.authenticate(a.accessToken, later(21))).toBeNull();

    const b = await signIn();
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, b.user.id));
    expect(await service.authenticate(b.accessToken, later(21))).toBeNull();
    expect(await code(service.refresh({ refreshToken: b.refreshToken, now: later(22) }))).toBe('INVALID_TOKEN');
  });
});
