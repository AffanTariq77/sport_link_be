import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AuthError, AuthService } from '../src/auth/auth.service.js';
import { BookingsService } from '../src/bookings/bookings.service.js';
import {
  auditLog,
  bookings,
  paymentAccounts,
  reports,
  users,
  venuePolicies,
  verifications,
  branches,
} from '../src/db/schema.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { AccountError, AccountService } from '../src/users/account.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import type { FileStorage } from '../src/verification/storage.js';
import { at, createVenue, ensurePakistan, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const files = new Map<string, Buffer>();
const storage: FileStorage = {
  put: async (k, d) => void files.set(k, d),
  get: async (k) => files.get(k)!,
  delete: async (k) => void files.delete(k),
};
const auth = new AuthService(db, { send: async () => undefined }, '123456');
const account = new AccountService(db, auth, storage);
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const engine = new BookingsService(db);
const payments = new PaymentsService(db, crypto);
const admin = { adminId: '00000000-0000-4000-8000-000000000001', ip: null };
afterAll(() => pool.end());
beforeAll(() => ensurePakistan(db));

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof AccountError || e instanceof AuthError ? e.code : Promise.reject(e)),
  );
const fakePhone = () => `0307 ${String(randomInt(0, 1e7)).padStart(7, '0')}`;
async function signUp() {
  const phone = fakePhone();
  await auth.requestOtp({ phone });
  const s = await auth.verifyOtp({ phone, code: '123456' });
  return { id: s.user.id, phone, token: s.accessToken };
}

describe('phone number change', () => {
  it('needs a code from both the old and the new number', async () => {
    const me = await signUp();
    const next = fakePhone();
    expect(await code(account.startPhoneChange(me.id, me.phone))).toBe('SAME_PHONE');
    expect(await code(account.startPhoneChange(me.id, (await signUp()).phone))).toBe('PHONE_TAKEN');
    await account.startPhoneChange(me.id, next, new Date(Date.now() + 61_000)); // the sign-up code's resend timer
    expect(
      await code(account.confirmPhoneChange(me.id, { newPhone: next, oldCode: '000000', newCode: '123456' })),
    ).toBe('INVALID_CODE');
    await auth.requestOtp({ phone: me.phone, now: new Date(Date.now() + 122_000) });
    await account.confirmPhoneChange(me.id, { newPhone: next, oldCode: '123456', newCode: '123456' });
    const [row] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, me.id));
    expect(row!.phone).toBe(`+92${next.replace(/\D/g, '').slice(1)}`);
  });

  it('a lost old number goes to review; an admin changes it and ends the sessions', async () => {
    const me = await signUp();
    const next = fakePhone();
    await account.requestPhoneReview(me.id, { newPhone: next, reason: 'My old SIM was stolen last week.' });
    const [r] = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, me.id), eq(reports.reason, 'phone_change_review')));
    expect(r).toBeDefined();
    await account.adminChangePhone(me.id, next, admin);
    expect(await auth.authenticate(me.token)).toBeNull();
    const logged = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'user.phone_change'), eq(auditLog.targetId, me.id), eq(auditLog.actorType, 'admin')),
      );
    expect(logged).toHaveLength(1);
  });
});

describe('account deletion', () => {
  it('is blocked by upcoming bookings, then removes personal data and ID images but keeps records', async () => {
    const v = await createVenue(db);
    const me = await signUp();
    await db.update(users).set({ name: 'Real Name', dob: '1990-01-01', city: 'Lahore' }).where(eq(users.id, me.id));
    const b = await engine.createHold({
      courtId: v.courtId,
      userId: me.id,
      startAt: at('2030-01-07T09:00'),
      endAt: at('2030-01-07T10:00'),
      now: NOW,
    });
    await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, b.id));
    expect(await code(account.deleteAccount(me.id, NOW))).toBe('HAS_COMMITMENTS');
    await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, b.id));

    files.set('ids/front', Buffer.from('front'));
    files.set('ids/back', Buffer.from('back'));
    await db.insert(verifications).values({
      userId: me.id,
      docType: 'cnic',
      docNumberEncrypted: 'secret',
      docNumberHash: randomBytes(16).toString('hex'),
      frontKey: 'ids/front',
      backKey: 'ids/back',
      status: 'approved',
    });
    await account.deleteAccount(me.id, NOW);
    const [u] = await db.select().from(users).where(eq(users.id, me.id));
    expect(u).toMatchObject({ status: 'deleted', name: 'Deleted player', dob: null, city: null });
    expect(u!.phone).not.toContain('0307');
    expect(await auth.authenticate(me.token)).toBeNull();
    expect(files.has('ids/front') || files.has('ids/back')).toBe(false);
    const [doc] = await db.select().from(verifications).where(eq(verifications.userId, me.id));
    expect(doc).toMatchObject({ docNumberEncrypted: '', frontKey: '', status: 'rejected' });
    expect((await db.select().from(bookings).where(eq(bookings.id, b.id))).length).toBe(1); // records stay
    // The same number can sign up again as a new account.
    await auth.requestOtp({ phone: me.phone, now: new Date(Date.now() + 120_000) });
    const again = await auth.verifyOtp({ phone: me.phone, code: '123456' });
    expect(again.user.id).not.toBe(me.id);
    expect(again.isNewUser).toBe(true);
  });
});

describe('weekly bookings and extensions', () => {
  it('checks every week together, skips taken weeks, and is paid once for all weeks', async () => {
    const v = await createVenue(db);
    const [{ vendorId }] = (await db
      .select({ vendorId: branches.vendorId })
      .from(branches)
      .where(eq(branches.id, v.branchId))) as [{ vendorId: string }];
    await db.insert(paymentAccounts).values({
      vendorId,
      method: 'jazzcash',
      accountTitle: 'Test Venue',
      accountNumberEncrypted: crypto.encryptAccount('0300 0000000'),
      status: 'approved',
    });
    const me = await signUp();
    const slot = { courtId: v.courtId, startAt: at('2030-02-04T18:00'), endAt: at('2030-02-04T19:00'), weeks: 4 };
    await expect(engine.checkSeries(slot, NOW)).rejects.toMatchObject({ code: 'RECURRING_NOT_ALLOWED' });
    await db.update(venuePolicies).set({ recurringAllowed: true }).where(eq(venuePolicies.branchId, v.branchId));

    // Someone already has week 3.
    await engine.createManual({
      courtId: v.courtId,
      startAt: at('2030-02-18T18:00'),
      endAt: at('2030-02-18T19:00'),
      staffUserId: v.userId,
      customerName: 'Walk-in',
      now: NOW,
    });
    const weeks = await engine.checkSeries(slot, NOW);
    expect(weeks.map((w) => w.free)).toEqual([true, true, false, true]);
    await expect(engine.createSeries({ ...slot, userId: me.id, now: NOW })).rejects.toMatchObject({
      code: 'SLOT_TAKEN',
    });
    const series = await engine.createSeries({
      ...slot,
      userId: me.id,
      skip: [weeks[2]!.startAt.toISOString()],
      now: NOW,
    });
    expect(series.bookings).toHaveLength(3);

    const paid = await payments.submitSeries(
      series.seriesId,
      me.id,
      { method: 'jazzcash', txnReference: 'WEEKLY123' },
      NOW,
    );
    expect(paid).toMatchObject({ weeks: 3, advanceTotal: series.bookings.reduce((s, b) => s + b.advanceDue, 0) });
    const queue = (await payments.queue(v.userId, NOW)).filter((q) =>
      series.bookings.some((b) => b.id === q.booking.id),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]!.series).toMatchObject({ weeks: 3 });
    await payments.confirm(queue[0]!.id, v.userId, NOW);
    const rows = await db
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.recurringSeriesId, series.seriesId));
    expect(rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  });

  it('extends into the next free slot as a new linked booking', async () => {
    const v = await createVenue(db);
    const me = await signUp();
    const b = await engine.createHold({
      courtId: v.courtId,
      userId: me.id,
      startAt: at('2030-03-04T08:00'),
      endAt: at('2030-03-04T09:00'),
      now: NOW,
    });
    const ext = await engine.extend(me.id, b.id, undefined, NOW);
    expect(ext.startAt.getTime()).toBe(b.endAt.getTime());
    expect(ext.extendsBookingId).toBe(b.id);
    await expect(engine.extend(me.id, b.id, undefined, NOW)).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await expect(engine.extend((await signUp()).id, b.id, undefined, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
