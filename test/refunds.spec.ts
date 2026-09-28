import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { bookings, bookingShares, branches, matches, paymentAccounts, reports, users } from '../src/db/schema.js';
import { MatchesService } from '../src/matches/matches.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { RefundError, RefundsService, refundableByPolicy } from '../src/refunds/refunds.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { VenuesService } from '../src/venues/venues.service.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const engine = new BookingsService(db);
const payments = new PaymentsService(db, crypto);
const refunds = new RefundsService(db);
const matchesService = new MatchesService(db, crypto);
afterAll(() => pool.end());

const hours = (n: number) => n * 3_600_000;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof RefundError ? e.code : Promise.reject(e)),
  );
async function person() {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name: 'Refund Test' })
    .returning({ id: users.id });
  return u!.id;
}

let v: Awaited<ReturnType<typeof createVenue>>; // v.userId owns the venue; policy: refund up to 24 h before, 20% advance
let hour = 6;
/** A booking the player has paid the advance for and the vendor has confirmed. Slots on 7 January 2030. */
async function paidBooking(playerId: string) {
  const start = at(`2030-01-07T${String(hour++).padStart(2, '0')}:00`);
  const b = await engine.createHold({
    courtId: v.courtId,
    userId: playerId,
    startAt: start,
    endAt: new Date(start.getTime() + hours(1)),
    now: NOW,
  });
  await payments.submit(b.id, playerId, { method: 'jazzcash', txnReference: `TEST${randomInt(0, 1e9)}` }, NOW);
  const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === b.id)!;
  await payments.confirm(item.id, v.userId, NOW);
  return b;
}

beforeAll(async () => {
  v = await createVenue(db);
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
});

describe('refund policy', () => {
  it('refunds only when allowed and cancelled at least the window before the start', () => {
    const start = new Date('2030-01-07T12:00:00Z');
    expect(
      refundableByPolicy({ cancelRefund: true, cancelWindowHours: 24 }, start, new Date(start.getTime() - hours(24))),
    ).toBe(true);
    expect(
      refundableByPolicy({ cancelRefund: true, cancelWindowHours: 24 }, start, new Date(start.getTime() - hours(23))),
    ).toBe(false);
    expect(
      refundableByPolicy({ cancelRefund: false, cancelWindowHours: 0 }, start, new Date(start.getTime() - hours(100))),
    ).toBe(false);
  });
});

describe('cancelling a booking', () => {
  it('cancelling a hold frees the slot with nothing to refund', async () => {
    const me = await person();
    const b = await engine.createHold({
      courtId: v.courtId,
      userId: me,
      startAt: at('2030-01-08T09:00'),
      endAt: at('2030-01-08T10:00'),
      now: NOW,
    });
    expect(await refunds.cancelByPlayer(me, b.id, NOW)).toEqual({ id: b.id, status: 'cancelled', refunds: 0 });
    const { slots } = await new VenuesService(db).slots(v.courtId, '2030-01-08', NOW);
    expect(slots.find((s) => s.startAt.getTime() === b.startAt.getTime())?.available).toBe(true);
  });

  it('a paid booking cancelled in time is refunded; inside the window it is not', async () => {
    const early = await paidBooking(await person());
    expect((await refunds.cancelByPlayer(early.createdBy!, early.id, NOW)).refunds).toBe(1);
    const [r] = await refunds.forPlayer(early.createdBy!);
    expect(r).toMatchObject({ amount: early.advanceDue, status: 'due', reason: 'player_cancelled' });

    const late = await paidBooking(await person());
    expect(
      (await refunds.cancelByPlayer(late.createdBy!, late.id, new Date(late.startAt.getTime() - hours(2)))).refunds,
    ).toBe(0);
  });

  it('a vendor cancelling refunds in full even at the last minute', async () => {
    const b = await paidBooking(await person());
    const result = await refunds.cancelByVendor(
      v.userId,
      b.id,
      'Floodlights failed',
      new Date(b.startAt.getTime() - hours(1)),
    );
    expect(result.refunds).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect([row!.status, row!.cancelledBy, row!.cancelReason]).toEqual(['cancelled', 'vendor', 'Floodlights failed']);
  });

  it('the venue can remove its own block, which frees the slot', async () => {
    const block = await engine.createBlock({
      courtId: v.courtId,
      startAt: at('2030-01-09T10:00'),
      endAt: at('2030-01-09T11:00'),
      staffUserId: v.userId,
      reason: 'Repairs',
      now: NOW,
    });
    expect(await refunds.cancelByVendor(v.userId, block.id, 'Repairs done early', NOW)).toMatchObject({
      status: 'cancelled',
      refunds: 0,
    });
    const { slots } = await new VenuesService(db).slots(v.courtId, '2030-01-09', NOW);
    expect(slots.find((s) => s.startAt.getTime() === block.startAt.getTime())?.available).toBe(true);
  });

  it('only the booker or the venue can cancel, and only before it starts', async () => {
    const b = await paidBooking(await person());
    expect(await code(refunds.cancelByPlayer(await person(), b.id, NOW))).toBe('NOT_FOUND');
    expect(await code(refunds.cancelByVendor(await person(), b.id, 'Not mine', NOW))).toBe('NOT_FOUND');
    expect(await code(refunds.cancelByPlayer(b.createdBy!, b.id, new Date(b.startAt.getTime() + 60_000)))).toBe(
      'NOT_CANCELLABLE',
    );
  });
});

describe('sending and confirming refunds', () => {
  it('vendor marks it sent, the player confirms it arrived, or disputes it', async () => {
    const a = await paidBooking(await person());
    await refunds.cancelByPlayer(a.createdBy!, a.id, NOW);
    const [due] = (await refunds.dueForVendor(v.userId)).filter((r) => r.booking.id === a.id);
    expect(await code(refunds.confirm(a.createdBy!, due!.id, true, undefined))).toBe('NOT_SENT');
    await refunds.markSent(v.userId, due!.id, 'JC-REFUND-1');
    await refunds.confirm(a.createdBy!, due!.id, true, undefined);
    const [share] = await db
      .select({ status: bookingShares.status })
      .from(bookingShares)
      .where(eq(bookingShares.bookingId, a.id));
    expect(share!.status).toBe('refunded');

    const b = await paidBooking(await person());
    await refunds.cancelByVendor(v.userId, b.id, 'Rain', NOW);
    const [bDue] = (await refunds.dueForVendor(v.userId)).filter((r) => r.booking.id === b.id);
    await refunds.markSent(v.userId, bDue!.id, 'JC-REFUND-2');
    expect(await refunds.confirm(b.createdBy!, bDue!.id, false, 'Nothing arrived')).toMatchObject({
      status: 'disputed',
    });
    const flagged = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, b.id), eq(reports.reason, 'refund_dispute')));
    expect(flagged).toHaveLength(1);
  });
});

describe('matches', () => {
  it('a paid joiner who leaves in time is refunded; the host cancelling refunds paid joiners and cancels the match', async () => {
    const host = await person();
    const booking = await paidBooking(host);
    const m = await matchesService.create(
      host,
      { sport: 'padel', bookingId: booking.id, slotsTotal: 4, hostBrings: 1, filters: {} },
      NOW,
    );
    const pay = async (player: string) => {
      await matchesService.join(player, m.id, {}, NOW);
      await matchesService.decide(host, m.id, player, true, NOW);
      await matchesService.payShare(player, m.id, { method: 'jazzcash', txnReference: `TEST${randomInt(0, 1e9)}` });
      const item = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === booking.id)!;
      await payments.confirm(item.id, v.userId, NOW);
    };
    const [leaver, stayer] = [await person(), await person()];
    await pay(leaver);
    await pay(stayer);

    await matchesService.leave(leaver, m.id, NOW);
    expect(await refunds.forPlayer(leaver)).toEqual([
      expect.objectContaining({ reason: 'left_match', amount: Math.ceil(booking.total / 4) }),
    ]);

    await matchesService.cancel(host, m.id, NOW);
    expect(await refunds.forPlayer(stayer)).toEqual([expect.objectContaining({ reason: 'match_cancelled' })]);
    const [row] = await db.select({ status: matches.status }).from(matches).where(eq(matches.id, m.id));
    expect(row!.status).toBe('cancelled');
  });
});
