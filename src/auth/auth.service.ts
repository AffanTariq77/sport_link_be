import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { otpChallenges, sessions, users } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { normalisePhone } from './phone.js';
import { DEV_OTP, SMS, type SmsSender } from './sms.js';

export class AuthError extends Error {
  constructor(
    public readonly code:
      'INVALID_PHONE' | 'RATE_LIMITED' | 'LOCKED' | 'INVALID_CODE' | 'ACCOUNT_BLOCKED' | 'INVALID_TOKEN',
    message: string,
  ) {
    super(message);
  }
}

export interface AuthContext {
  sessionId: string;
  user: { id: string; name: string | null; status: string; isMinor: boolean; countryCode: string };
}

const BLOCKED = new Set(['suspended', 'banned', 'deleted']);
// A client that fires parallel requests can present the same refresh token twice. Within this window the
// stale token is rejected but the session is kept; after it, reuse is treated as theft and revokes it.
const REUSE_GRACE_MS = 5_000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// Returned to clients. Never includes the phone number (CLAUDE.md non-negotiable rule).
const userColumns = {
  id: users.id,
  name: users.name,
  status: users.status,
  isMinor: users.isMinor,
  countryCode: users.countryCode,
};

// ponytail: rate limits are per phone only. Per IP and per device limits (spec 5, 16) belong in a
// global throttler once Redis is added.
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SMS) private readonly sms: SmsSender,
    @Optional() @Inject(DEV_OTP) private readonly devCode?: string,
  ) {}

  /** Sends a 6-digit code. Same response whether or not the number has an account. */
  async requestOtp(input: { phone: string; now?: Date }) {
    const now = input.now ?? new Date();
    const { phone, countryCode } = this.parsePhone(input.phone);
    const [ttl, resend, perHour] = await Promise.all([
      getSetting(this.db, 'auth.otp_ttl_seconds', countryCode),
      getSetting(this.db, 'auth.otp_resend_seconds', countryCode),
      getSetting(this.db, 'auth.otp_requests_per_hour', countryCode),
    ]);

    await this.assertNotLocked(phone, now);
    const recent = await this.db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), gt(otpChallenges.createdAt, new Date(now.getTime() - 3_600_000))))
      .orderBy(desc(otpChallenges.createdAt));
    const last = recent[0];
    if (last && now.getTime() - last.createdAt.getTime() < resend * 1000) {
      throw new AuthError('RATE_LIMITED', `Please wait ${resend} seconds before asking for a new code.`);
    }
    if (recent.length >= perHour) {
      throw new AuthError('RATE_LIMITED', 'Too many codes requested. Please try again later.');
    }

    const id = randomUUID();
    const code = this.devCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.db.insert(otpChallenges).values({
      id,
      phone,
      codeHash: hash(`${id}:${code}`),
      expiresAt: new Date(now.getTime() + ttl * 1000),
      createdAt: now,
    });
    await this.sms.send(
      phone,
      `Your SportsLink code is ${code}. It expires in ${Math.round(ttl / 60)} minutes. Never share it with anyone.`,
    );
    return { resendInSeconds: resend };
  }

  /** Checks the code, creates the account on first sign-in, and starts a session. */
  async verifyOtp(input: { phone: string; code: string; now?: Date }) {
    const now = input.now ?? new Date();
    const { phone, countryCode } = this.parsePhone(input.phone);
    await this.assertNotLocked(phone, now);

    const [challenge] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phone, phone),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.lockedUntil),
          gt(otpChallenges.expiresAt, now),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    if (!challenge) throw new AuthError('INVALID_CODE', 'That code is wrong or has expired.');

    // Count the attempt before comparing, atomically, so parallel guesses cannot exceed the limit.
    const maxAttempts = await getSetting(this.db, 'auth.otp_max_attempts', countryCode);
    const [counted] = await this.db
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(and(eq(otpChallenges.id, challenge.id), sql`${otpChallenges.attempts} < ${maxAttempts}`))
      .returning({ attempts: otpChallenges.attempts });
    if (!counted) throw new AuthError('INVALID_CODE', 'That code is wrong or has expired.');

    if (!/^\d{6}$/.test(input.code) || !sameHash(hash(`${challenge.id}:${input.code}`), challenge.codeHash)) {
      if (counted.attempts >= maxAttempts) {
        const minutes = await getSetting(this.db, 'auth.otp_lockout_minutes', countryCode);
        await this.db
          .update(otpChallenges)
          .set({ lockedUntil: new Date(now.getTime() + minutes * 60_000) })
          .where(eq(otpChallenges.id, challenge.id));
        throw new AuthError('LOCKED', `Too many wrong codes. Please try again in ${minutes} minutes.`);
      }
      throw new AuthError('INVALID_CODE', 'That code is wrong or has expired.');
    }

    const [consumed] = await this.db
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    if (!consumed) throw new AuthError('INVALID_CODE', 'That code is wrong or has expired.');

    const inserted = await this.db
      .insert(users)
      .values({ phone, countryCode })
      .onConflictDoNothing()
      .returning(userColumns);
    const user = inserted[0] ?? (await this.db.select(userColumns).from(users).where(eq(users.phone, phone)))[0]!;
    if (BLOCKED.has(user.status)) throw new AuthError('ACCOUNT_BLOCKED', 'This account cannot sign in.');

    return { ...(await this.startSession(user.id, user.countryCode, now)), isNewUser: inserted.length > 0, user };
  }

  /** Rotates both tokens. Reusing an already-rotated refresh token revokes the session. */
  async refresh(input: { refreshToken: string; now?: Date }) {
    const now = input.now ?? new Date();
    const oldHash = hash(input.refreshToken);
    const [current] = await this.db
      .select({ sessionId: sessions.id, status: users.status, countryCode: users.countryCode })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.refreshTokenHash, oldHash));

    if (current && !BLOCKED.has(current.status)) {
      const tokens = await this.issueTokens(current.countryCode, now);
      const [rotated] = await this.db
        .update(sessions)
        .set({
          accessTokenHash: hash(tokens.accessToken),
          accessExpiresAt: tokens.accessExpiresAt,
          refreshTokenHash: hash(tokens.refreshToken),
          previousRefreshHash: oldHash,
          refreshExpiresAt: tokens.refreshExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(sessions.id, current.sessionId),
            eq(sessions.refreshTokenHash, oldHash),
            isNull(sessions.revokedAt),
            gt(sessions.refreshExpiresAt, now),
          ),
        )
        .returning({ id: sessions.id });
      if (rotated) return tokens;
    } else if (!current) {
      await this.db
        .update(sessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(sessions.previousRefreshHash, oldHash),
            isNull(sessions.revokedAt),
            lt(sessions.updatedAt, new Date(now.getTime() - REUSE_GRACE_MS)),
          ),
        );
    }
    throw new AuthError('INVALID_TOKEN', 'Please sign in again.');
  }

  /** Resolves a bearer access token. Null if unknown, expired, revoked or the user is blocked. */
  async authenticate(accessToken: string, now = new Date()): Promise<AuthContext | null> {
    const [row] = await this.db
      .select({ sessionId: sessions.id, user: userColumns })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.accessTokenHash, hash(accessToken)),
          isNull(sessions.revokedAt),
          gt(sessions.accessExpiresAt, now),
        ),
      );
    return row && !BLOCKED.has(row.user.status) ? row : null;
  }

  async logout(sessionId: string, now = new Date()) {
    await this.db.update(sessions).set({ revokedAt: now, updatedAt: now }).where(eq(sessions.id, sessionId));
  }

  private parsePhone(input: string) {
    const parsed = normalisePhone(input);
    if (!parsed) throw new AuthError('INVALID_PHONE', 'Enter a Pakistani mobile number, for example 0300 1234567.');
    return parsed;
  }

  private async assertNotLocked(phone: string, now: Date) {
    const [locked] = await this.db
      .select({ until: otpChallenges.lockedUntil })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), gt(otpChallenges.lockedUntil, now)))
      .limit(1);
    if (locked) throw new AuthError('LOCKED', 'Too many wrong codes. Please try again later.');
  }

  private async issueTokens(countryCode: string, now: Date) {
    const [accessMinutes, refreshDays] = await Promise.all([
      getSetting(this.db, 'auth.access_token_minutes', countryCode),
      getSetting(this.db, 'auth.refresh_token_days', countryCode),
    ]);
    return {
      accessToken: newToken(),
      accessExpiresAt: new Date(now.getTime() + accessMinutes * 60_000),
      refreshToken: newToken(),
      refreshExpiresAt: new Date(now.getTime() + refreshDays * 86_400_000),
    };
  }

  private async startSession(userId: string, countryCode: string, now: Date) {
    const tokens = await this.issueTokens(countryCode, now);
    await this.db.insert(sessions).values({
      userId,
      accessTokenHash: hash(tokens.accessToken),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshTokenHash: hash(tokens.refreshToken),
      refreshExpiresAt: tokens.refreshExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return tokens;
  }
}
