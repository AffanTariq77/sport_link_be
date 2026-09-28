import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AuthService } from '../src/auth/auth.service.js';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { ChatError, ChatService } from '../src/chat/chat.service.js';
import { auditLog, users, verifications } from '../src/db/schema.js';
import { GuardianError, GuardianService } from '../src/users/guardian.service.js';
import { ProfileError, ProfileService } from '../src/users/profile.service.js';
import { at, createVenue, ensurePakistan, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const guardians = new GuardianService(db);
const profiles = new ProfileService(db);
const auth = new AuthService(db, { send: async () => undefined }, '123456');
afterAll(() => pool.end());
beforeAll(() => ensurePakistan(db));

const TODAY = new Date('2030-06-15T12:00:00Z');
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) =>
      e instanceof GuardianError || e instanceof ProfileError || e instanceof ChatError ? e.code : Promise.reject(e),
  );
/** Signs up through the real OTP flow and fills in the profile. Fake numbers only. */
async function signUp(dob: string) {
  const phone = `0304 ${String(randomInt(0, 1e7)).padStart(7, '0')}`;
  await auth.requestOtp({ phone });
  const s = await auth.verifyOtp({ phone, code: '123456' });
  await profiles.update(s.user.id, { name: 'Test Person', dob, gender: 'male', city: 'Lahore' }, TODAY);
  return { id: s.user.id, phone, token: s.accessToken };
}
async function approveCnic(userId: string) {
  await db.insert(verifications).values({
    userId,
    docType: 'cnic',
    docNumberEncrypted: 'x',
    docNumberHash: randomBytes(16).toString('hex'),
    frontKey: 'f',
    backKey: 'b',
    status: 'approved',
  });
}

describe('age rules', () => {
  it('turns away under-13s at sign-up (setting minors.minimum_age)', async () => {
    const phone = `0304 ${String(randomInt(0, 1e7)).padStart(7, '0')}`;
    await auth.requestOtp({ phone });
    const s = await auth.verifyOtp({ phone, code: '123456' });
    expect(
      await code(
        profiles.update(s.user.id, { name: 'Child', dob: '2018-01-01', gender: 'male', city: 'Lahore' }, TODAY),
      ),
    ).toBe('TOO_YOUNG');
  });
});

describe('guardian consent', () => {
  it('a minor is locked until a CNIC-verified guardian accepts the current consent', async () => {
    const minor = await signUp('2015-03-01');
    const parent = await signUp('1985-03-01');
    expect((await auth.authenticate(minor.token))?.user.locked).toBe(true);
    expect((await guardians.myGuardian(minor.id)).status).toBe('none');

    expect(await code(guardians.requestGuardian(minor.id, '0304 0000000'))).toBe('NOT_FOUND');
    await guardians.requestGuardian(minor.id, parent.phone);
    expect(await guardians.myGuardian(minor.id)).toEqual({ status: 'pending', guardianName: 'Test Person' });
    expect((await guardians.wards(parent.id)).map((w) => w.id)).toEqual([minor.id]);

    const { version } = await guardians.consentText();
    expect(await code(guardians.decide(parent.id, minor.id, { accept: true, version }))).toBe('GUARDIAN_NOT_VERIFIED');
    await approveCnic(parent.id);
    expect(await code(guardians.decide(parent.id, minor.id, { accept: true, version: 'old' }))).toBe('WRONG_VERSION');
    expect(await guardians.decide(parent.id, minor.id, { accept: true, version })).toEqual({ status: 'accepted' });

    expect((await auth.authenticate(minor.token))?.user.locked).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, minor.id));
    expect(row!.guardianConsentVersion).toBe(version);
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'guardian.consent'), eq(auditLog.targetId, minor.id)));
    expect(logged).toHaveLength(1);
  });

  it('only a consenting guardian sees the child’s activity; adults cannot be linked as wards', async () => {
    const minor = await signUp('2014-05-05');
    const parent = await signUp('1980-05-05');
    await guardians.requestGuardian(minor.id, parent.phone);
    expect(await code(guardians.wardActivity(parent.id, minor.id))).toBe('NOT_FOUND');
    await approveCnic(parent.id);
    await guardians.decide(parent.id, minor.id, { accept: true, version: (await guardians.consentText()).version });
    expect((await guardians.wardActivity(parent.id, minor.id)).minor.id).toBe(minor.id);

    const adult = await signUp('1999-01-01');
    expect(await code(guardians.requestGuardian(adult.id, parent.phone))).toBe('NOT_MINOR');
  });

  it('minors do not get private chats with the venue (setting minors.block_private_chat)', async () => {
    const v = await createVenue(db);
    const minor = await signUp('2013-02-02');
    const hold = await new BookingsService(db).createHold({
      courtId: v.courtId,
      userId: minor.id,
      startAt: at('2030-01-07T15:00'),
      endAt: at('2030-01-07T16:00'),
      now: NOW,
    });
    expect(await code(new ChatService(db).openBooking(minor.id, hold.id))).toBe('NOT_FOUND');
  });

  it('turning 18 ends the guardianship and asks for a CNIC', async () => {
    const minor = await signUp('2012-06-16'); // 17 on TODAY, 18 the next day
    await db.insert(verifications).values({
      userId: minor.id,
      docType: 'b_form',
      docNumberEncrypted: 'x',
      docNumberHash: randomBytes(16).toString('hex'),
      frontKey: 'f',
      backKey: 'b',
      status: 'approved',
    });
    expect((await guardians.endGuardianshipAt18(TODAY)).turned18).toBe(0);
    await guardians.endGuardianshipAt18(new Date('2030-06-16T00:00:00Z'));
    const [row] = await db
      .select({ isMinor: users.isMinor, guardian: users.guardianUserId })
      .from(users)
      .where(eq(users.id, minor.id));
    expect(row).toEqual({ isMinor: false, guardian: null });
    const [bform] = await db
      .select({ status: verifications.status })
      .from(verifications)
      .where(eq(verifications.userId, minor.id));
    expect(bform!.status).toBe('rejected');
  });
});
