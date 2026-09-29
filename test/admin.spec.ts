import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { AdminAuthError, AdminAuthService } from '../src/admin/admin-auth.service.js';
import { AdminError, AdminService } from '../src/admin/admin.service.js';
import { hashPassword, verifyPassword } from '../src/admin/password.js';
import { base32Encode, newTotpSecret, totp, verifyTotp } from '../src/admin/totp.js';
import { AuthService } from '../src/auth/auth.service.js';
import {
  adminUsers,
  auditLog,
  branches,
  paymentAccounts,
  sports,
  users,
  vendors,
  verifications,
} from '../src/db/schema.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import type { FileStorage } from '../src/verification/storage.js';
import { VerificationService } from '../src/verification/verification.service.js';
import { VendorsService } from '../src/vendors/vendors.service.js';
import { VenuesService } from '../src/venues/venues.service.js';
import { ProfileService } from '../src/users/profile.service.js';
import { ensurePakistan, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const files = new Map<string, Buffer>();
const storage: FileStorage = {
  put: async (k, d) => void files.set(k, d),
  get: async (k) => files.get(k)!,
  delete: async (k) => void files.delete(k),
};
const auth = new AdminAuthService(db, crypto);
const admin = new AdminService(db, storage, crypto);
afterAll(() => pool.end());
beforeAll(async () => {
  await ensurePakistan(db);
  await db
    .insert(sports)
    .values({ slug: 'padel', name: 'Padel', teamSizeMin: 2, teamSizeMax: 2 })
    .onConflictDoNothing();
});

const NOW = new Date('2030-03-01T09:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof AdminAuthError || e instanceof AdminError ? e.code : Promise.reject(e)),
  );
const fakePhone = () => `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`;

async function newAdmin(role: 'owner' | 'operations' | 'finance' | 'moderation' = 'owner') {
  const secret = newTotpSecret();
  const email = `admin${randomInt(0, 1e9)}@sportslink.test`;
  const [a] = await db
    .insert(adminUsers)
    .values({
      email,
      name: 'Test Admin',
      role,
      passwordHash: await hashPassword('correct horse'),
      totpSecretEncrypted: crypto.encryptTotp(secret),
    })
    .returning({ id: adminUsers.id });
  return { id: a!.id, email, secret, actor: { adminId: a!.id, ip: '127.0.0.1' } };
}
const jpeg = () => {
  const buffer = Buffer.alloc(1000, 3);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return { buffer, size: buffer.length };
};
async function playerWithId() {
  const [u] = await db.insert(users).values({ phone: fakePhone(), countryCode: 'PK' }).returning({ id: users.id });
  await new ProfileService(db).update(u!.id, { name: 'Test Owner', dob: '1990-01-01', gender: 'male', city: 'Lahore' });
  await new VerificationService(db, storage, crypto).submit(u!.id, {
    docNumber: `99999${String(randomInt(0, 1e8)).padStart(8, '0')}`,
    front: jpeg(),
    back: jpeg(),
  });
  const [v] = await db.select({ id: verifications.id }).from(verifications).where(eq(verifications.userId, u!.id));
  return { userId: u!.id, verificationId: v!.id };
}

describe('passwords and two-factor codes', () => {
  it('hashes passwords with scrypt and checks them', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong horse', stored)).toBe(false);
  });

  it('matches the RFC 6238 test vectors and allows one step of clock drift', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, new Date(59_000), 8)).toBe('94287082');
    expect(totp(secret, new Date(1_111_111_109_000), 8)).toBe('07081804');
    const code = totp(secret, NOW);
    expect(verifyTotp(secret, code, new Date(NOW.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(secret, code, new Date(NOW.getTime() + 95_000))).toBe(false);
  });
});

describe('admin sign-in', () => {
  it('needs the password and the current code, then gives a session with the role permissions', async () => {
    const a = await newAdmin('finance');
    expect(
      await errorCode(auth.login({ email: a.email, password: 'wrong', code: totp(a.secret, NOW), now: NOW })),
    ).toBe('INVALID_LOGIN');
    expect(await errorCode(auth.login({ email: a.email, password: 'correct horse', code: '000000', now: NOW }))).toBe(
      'INVALID_LOGIN',
    );
    expect(
      await errorCode(auth.login({ email: 'nobody@sportslink.test', password: 'x', code: '000000', now: NOW })),
    ).toBe('INVALID_LOGIN');
    const s = await auth.login({
      email: a.email.toUpperCase(),
      password: 'correct horse',
      code: totp(a.secret, NOW),
      now: NOW,
    });
    const ctx = await auth.authenticate(s.token, later(1));
    expect(ctx?.admin.role).toBe('finance');
    expect(ctx?.permissions).toContain('billing.manage');
    expect(ctx?.permissions).not.toContain('verification.review');
    expect(await auth.authenticate(s.token, later(9 * 60))).toBeNull(); // 8 hour session
  });

  it('locks the account after five failures, even with the right details afterwards', async () => {
    const a = await newAdmin();
    for (let i = 0; i < 5; i++)
      await errorCode(auth.login({ email: a.email, password: 'wrong', code: '000000', now: NOW }));
    expect(
      await errorCode(
        auth.login({ email: a.email, password: 'correct horse', code: totp(a.secret, later(1)), now: later(1) }),
      ),
    ).toBe('LOCKED');
    expect(
      await errorCode(
        auth.login({ email: a.email, password: 'correct horse', code: totp(a.secret, later(16)), now: later(16) }),
      ),
    ).toBe('OK');
  });
});

describe('identity review', () => {
  it('approving activates the player, and every look at the document is audit-logged', async () => {
    const a = await newAdmin('moderation');
    const p = await playerWithId();
    const detail = await admin.verificationDetail(p.verificationId, a.actor);
    expect(detail.docNumber).toMatch(/^99999\d{8}$/);
    const { image, contentType } = await admin.verificationImage(p.verificationId, 'front', a.actor);
    expect(contentType).toBe('image/jpeg');
    expect(image.equals(jpeg().buffer)).toBe(true);

    await admin.decideVerification(p.verificationId, { approve: true }, a.actor);
    const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, p.userId));
    expect(u!.status).toBe('active');
    expect(await errorCode(admin.decideVerification(p.verificationId, { approve: false, reason: 'x' }, a.actor))).toBe(
      'NOT_PENDING',
    );

    const actions = (
      await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, p.verificationId))
    ).map((r) => r.action);
    expect(actions.sort()).toEqual(['verification.approve', 'verification.view_image', 'verification.view_number']);
  });

  it('the audit log cannot be edited or deleted', async () => {
    await expect(db.execute(sql`update audit_log set action = 'changed'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_log`)).rejects.toThrow();
  });
});

describe('venue approval', () => {
  it('a visit only passes once the owner is verified; then the venue goes live and the vendor is approved', async () => {
    const a = await newAdmin('operations');
    const owner = await playerWithId();
    const vendorsService = new VendorsService(db, crypto);
    const { id: vendorId } = await vendorsService.apply(owner.userId, 'Admin Test Sports');
    const { id: branchId } = await vendorsService.createBranch(owner.userId, {
      name: 'Admin Test Arena',
      address: '3 Test Road',
      city: 'Lahore',
      latitude: 31.5,
      longitude: 74.3,
      facilities: [],
      rules: null,
    });
    const { id: courtId } = await vendorsService.createCourt(owner.userId, branchId, {
      name: 'Court 1',
      surface: null,
      slotMinutes: 60,
      sports: ['padel'],
    });
    await vendorsService.setHours(
      owner.userId,
      courtId,
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: '08:00', closesAt: '22:00' })),
    );
    await vendorsService.setPrices(owner.userId, courtId, [
      { dayType: 'all', startTime: '00:00', endTime: '00:00', pricePerHour: 300_000 },
    ]);
    const account = await vendorsService.addAccount(owner.userId, {
      method: 'jazzcash',
      accountTitle: 'Test Owner',
      accountNumber: '0300 0005555',
    });
    await vendorsService.submit(owner.userId, branchId);

    expect((await admin.listBranches('pending_visit')).find((b) => b.id === branchId)).toMatchObject({
      ownerVerification: 'pending',
    });
    await admin.scheduleVisit(branchId, later(60 * 24), a.actor);
    expect(await errorCode(admin.recordVisit(branchId, { passed: true, notes: 'All good' }, a.actor))).toBe(
      'OWNER_NOT_VERIFIED',
    );

    await admin.decideVerification(owner.verificationId, { approve: true }, (await newAdmin()).actor);
    await admin.recordVisit(branchId, { passed: true, notes: 'Courts as described' }, a.actor);
    const [v] = await db.select({ status: vendors.status }).from(vendors).where(eq(vendors.id, vendorId));
    const [b] = await db.select({ status: branches.status }).from(branches).where(eq(branches.id, branchId));
    expect([v!.status, b!.status]).toEqual(['approved', 'live']);
    expect((await new VenuesService(db).list({})).some((x) => x.id === branchId)).toBe(true);

    // Payment account approval, then a replacement that retires it once approved.
    await admin.decideAccount(account.id, true, a.actor);
    const replacement = await vendorsService.addAccount(owner.userId, {
      method: 'jazzcash',
      accountTitle: 'Test Owner',
      accountNumber: '0300 0006666',
      replacesAccountId: account.id,
    });
    const listed = await admin.listAccounts('pending');
    expect(listed.find((x) => x.id === replacement.id)?.accountNumber).toBe('0300 0006666');
    await admin.decideAccount(replacement.id, true, a.actor);
    const statuses = await db
      .select({ id: paymentAccounts.id, status: paymentAccounts.status })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.vendorId, vendorId)));
    expect(statuses.find((x) => x.id === account.id)?.status).toBe('rejected');
    expect(statuses.find((x) => x.id === replacement.id)?.status).toBe('approved');
  });
});

describe('moderation', () => {
  it('a ban ends the player sessions at once and is recorded', async () => {
    const a = await newAdmin('moderation');
    const players = new AuthService(db, { send: async () => undefined }, '123456');
    const phone = `0302 ${String(randomInt(0, 1e7)).padStart(7, '0')}`;
    await players.requestOtp({ phone });
    const session = await players.verifyOtp({ phone, code: '123456' });
    expect(await players.authenticate(session.accessToken)).not.toBeNull();

    await admin.moderateUser(session.user.id, { action: 'ban', reason: 'Repeated abuse in chat' }, a.actor);
    expect(await players.authenticate(session.accessToken)).toBeNull();
    const found = await admin.searchUsers(phone.replace(/\s/g, '').slice(1));
    expect(found[0]).toMatchObject({ id: session.user.id, status: 'banned' });
  });
});
