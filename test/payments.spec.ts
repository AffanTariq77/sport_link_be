import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { branches, paymentAccounts, reports, users, vendorStaff, venuePolicies } from '../src/db/schema.js';
import { PaymentError, PaymentsService } from '../src/payments/payments.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { VenuesService } from '../src/venues/venues.service.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const payments = new PaymentsService(db, crypto);
const bookings = new BookingsService(db);
const venues = new VenuesService(db);
afterAll(() => pool.end());

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof PaymentError ? e.code : Promise.reject(e)),
  );
// Fake numbers and references only.
const fakeRef = () => `TEST${randomInt(0, 1e9)}`;
async function player(name = 'Test Player') {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name })
    .returning({ id: users.id });
  return u!.id;
}

let v: Awaited<ReturnType<typeof createVenue>>; // v.userId owns the vendor
let vendorId: string;
let hour = 6;
// Each test holds its own slot on the fixture court (Monday 7 January 2030, from 06:00).
async function hold(userId: string) {
  const start = at(`2030-01-07T${String(hour++).padStart(2, '0')}:00`);
  return bookings.createHold({
    courtId: v.courtId,
    userId,
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    now: NOW,
  });
}

beforeAll(async () => {
  v = await createVenue(db);
  [{ vendorId }] = (await db
    .select({ vendorId: branches.vendorId })
    .from(branches)
    .where(eq(branches.id, v.branchId))) as [{ vendorId: string }];
  await db.insert(paymentAccounts).values([
    {
      vendorId,
      method: 'jazzcash',
      accountTitle: 'Test Venue',
      accountNumberEncrypted: crypto.encryptAccount('0300 0000000'),
      status: 'approved',
    },
    {
      vendorId,
      method: 'easypaisa',
      accountTitle: 'Not approved yet',
      accountNumberEncrypted: crypto.encryptAccount('0345 0000000'),
    },
  ]);
});

describe('paying the advance', () => {
  it('shows only approved accounts, with the number readable', async () => {
    const me = await player();
    const b = await hold(me);
    const info = await payments.payInfo(b.id, me, NOW);
    expect(info).toMatchObject({ status: 'held', advanceDue: b.advanceDue, payAtVenueAllowed: false });
    expect(info.accounts).toEqual([
      { method: 'jazzcash', accountTitle: 'Test Venue', accountNumber: '0300 0000000', bankName: null },
    ]);
  });

  it('keeps other players out of a booking', async () => {
    const b = await hold(await player());
    expect(await code(payments.payInfo(b.id, await player(), NOW))).toBe('NOT_FOUND');
    expect(await code(payments.submit(b.id, await player(), { method: 'jazzcash', txnReference: fakeRef() }))).toBe(
      'NOT_FOUND',
    );
  });

  it('submitted payment waits for the vendor, whose confirmation confirms the booking', async () => {
    const me = await player('Ayesha Test');
    const b = await hold(me);
    const result = await payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, later(5));
    expect(result).toEqual({ status: 'pending_payment', paymentDeadlineAt: later(65) });
    expect(await code(payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, later(6)))).toBe(
      'ALREADY_SUBMITTED',
    );

    const queue = await payments.queue(v.userId, later(10));
    const item = queue.find((q) => q.booking.id === b.id)!;
    expect(item).toMatchObject({ playerName: 'Ayesha Test', method: 'jazzcash', advanceAmount: b.advanceDue });
    expect(JSON.stringify(item)).not.toMatch(/phone|\+92/);

    await payments.confirm(item.id, v.userId, later(10));
    expect((await payments.payInfo(b.id, me, later(11))).status).toBe('confirmed');
    const { slots } = await venues.slots(v.courtId, '2030-01-07', later(11));
    expect(slots.find((s) => s.startAt.getTime() === b.startAt.getTime())?.available).toBe(false);
  });

  it('only accepts approved methods and real-looking references', async () => {
    const me = await player();
    const b = await hold(me);
    expect(await code(payments.submit(b.id, me, { method: 'easypaisa', txnReference: fakeRef() }, NOW))).toBe(
      'METHOD_NOT_ACCEPTED',
    );
    expect(await code(payments.submit(b.id, me, { method: 'jazzcash', txnReference: 'x' }, NOW))).toBe(
      'INVALID_REFERENCE',
    );
  });

  it('rejects a transaction ID already used for another booking and flags it', async () => {
    const reference = fakeRef();
    const [a, c] = [await player(), await player()];
    await payments.submit((await hold(a)).id, a, { method: 'jazzcash', txnReference: reference }, NOW);
    const second = await hold(c);
    expect(await code(payments.submit(second.id, c, { method: 'jazzcash', txnReference: reference }, NOW))).toBe(
      'DUPLICATE_TRANSACTION',
    );
    const flags = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, second.id), eq(reports.reason, 'duplicate_transaction_reference')));
    expect(flags).toHaveLength(1);
  });

  it('pay at the venue only when the venue allows unpaid bookings, then confirmed straight away', async () => {
    const me = await player();
    const strict = await hold(me);
    expect(await code(payments.submit(strict.id, me, { method: 'cash' }, NOW))).toBe('CASH_NOT_ALLOWED');

    await db.update(venuePolicies).set({ allowUnpaidCash: true }).where(eq(venuePolicies.branchId, v.branchId));
    const relaxed = await hold(me); // policy is snapshotted when the slot is held
    await db.update(venuePolicies).set({ allowUnpaidCash: false }).where(eq(venuePolicies.branchId, v.branchId));
    expect(await payments.submit(relaxed.id, me, { method: 'cash' }, NOW)).toMatchObject({ status: 'confirmed' });
  });

  it('an expired hold cannot be paid, and an unchecked payment expires at its deadline', async () => {
    const me = await player();
    const lapsed = await hold(me);
    expect(await code(payments.submit(lapsed.id, me, { method: 'jazzcash', txnReference: fakeRef() }, later(16)))).toBe(
      'NOT_PAYABLE',
    );
    const b = await hold(me);
    await payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, later(1));
    const item = (await payments.queue(v.userId, later(2))).find((q) => q.booking.id === b.id)!;
    expect(await code(payments.confirm(item.id, v.userId, later(62)))).toBe('BOOKING_EXPIRED');
  });
});

describe('vendor decisions', () => {
  it('a rejected payment opens a dispute and the player can submit again', async () => {
    const me = await player();
    const b = await hold(me);
    await payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, NOW);
    const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === b.id)!;
    await payments.reject(item.id, v.userId, 'Nothing arrived in our account.', later(1));

    const disputes = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, b.id), eq(reports.reason, 'payment_rejected')));
    expect(disputes).toHaveLength(1);
    const info = await payments.payInfo(b.id, me, later(2));
    expect(info.payments.map((p) => p.status)).toEqual(['rejected']);
    expect(await code(payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, later(3)))).toBe('OK');
  });

  it('two confirmations of the same payment cannot both succeed', async () => {
    const me = await player();
    const b = await hold(me);
    await payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, NOW);
    const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === b.id)!;
    const results = await Promise.all([1, 2].map(() => code(payments.confirm(item.id, v.userId, later(1)))));
    expect(results.sort()).toEqual(['NOT_SUBMITTED', 'OK']);
  });

  it('staff need the confirm permission and a matching branch; players see nothing', async () => {
    const me = await player();
    const b = await hold(me);
    await payments.submit(b.id, me, { method: 'jazzcash', txnReference: fakeRef() }, NOW);
    const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === b.id)!;

    const outsider = await player();
    expect(await payments.queue(outsider, NOW)).toEqual([]);
    expect(await code(payments.confirm(item.id, outsider, NOW))).toBe('NOT_FOUND');

    const viewer = await player();
    await db.insert(vendorStaff).values({ vendorId, userId: viewer, branchIds: [], permissions: ['view_bookings'] });
    expect(await code(payments.confirm(item.id, viewer, NOW))).toBe('NOT_FOUND');

    const otherBranch = await player();
    const elsewhere = await createVenue(db);
    await db
      .insert(vendorStaff)
      .values({ vendorId, userId: otherBranch, branchIds: [elsewhere.branchId], permissions: ['confirm_payments'] });
    expect(await code(payments.confirm(item.id, otherBranch, NOW))).toBe('NOT_FOUND');

    const cashier = await player();
    await db
      .insert(vendorStaff)
      .values({ vendorId, userId: cashier, branchIds: [v.branchId], permissions: ['confirm_payments'] });
    expect(await code(payments.confirm(item.id, cashier, later(1)))).toBe('OK');
  });
});
