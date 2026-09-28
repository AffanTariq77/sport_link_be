import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { blocks, bookings, bookingShares, branches, paymentAccounts, users, verifications } from '../src/db/schema.js';
import { MatchError, MatchesService } from '../src/matches/matches.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const matches = new MatchesService(db, crypto);
const engine = new BookingsService(db);
const payments = new PaymentsService(db, crypto);
afterAll(() => pool.end());

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof MatchError ? e.code : Promise.reject(e)),
  );
// Fake people only.
async function person(opts: { gender?: 'male' | 'female'; dob?: string; verified?: boolean } = {}) {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`,
      countryCode: 'PK',
      name: `Player ${randomInt(0, 1e4)}`,
      gender: opts.gender ?? 'male',
      dob: opts.dob ?? '1998-01-01',
    })
    .returning({ id: users.id });
  if (opts.verified) {
    await db.insert(verifications).values({
      userId: u!.id,
      docType: 'cnic',
      docNumberEncrypted: 'x',
      docNumberHash: randomBytes(16).toString('hex'),
      frontKey: 'f',
      backKey: 'b',
      status: 'approved',
    });
  }
  return u!.id;
}

let v: Awaited<ReturnType<typeof createVenue>>; // v.userId owns the venue
let hour = 6;
/** A confirmed booking for the host on the fixture court (the host has paid the advance). */
async function securedBooking(hostId: string) {
  const start = at(`2030-01-07T${String(hour++).padStart(2, '0')}:00`);
  const b = await engine.createHold({
    courtId: v.courtId,
    userId: hostId,
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    now: NOW,
  });
  await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, b.id));
  return b;
}
const listedMatch = async (hostId: string, extra: Partial<Parameters<MatchesService['create']>[1]> = {}) => {
  const b = await securedBooking(hostId);
  const m = await matches.create(
    hostId,
    { sport: 'padel', bookingId: b.id, slotsTotal: 4, hostBrings: 2, filters: {}, ...extra },
    NOW,
  );
  return { ...m, booking: b };
};

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

describe('creating a match', () => {
  it('needs the host’s secured booking, once per booking, with at least one open place', async () => {
    const host = await person();
    const start = at('2030-01-08T09:00');
    const held = await engine.createHold({
      courtId: v.courtId,
      userId: host,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
      now: NOW,
    });
    expect(
      await code(
        matches.create(host, { sport: 'padel', bookingId: held.id, slotsTotal: 4, hostBrings: 1, filters: {} }, NOW),
      ),
    ).toBe('BOOKING_NOT_READY');
    const b = await securedBooking(host);
    expect(
      await code(
        matches.create(host, { sport: 'padel', bookingId: b.id, slotsTotal: 4, hostBrings: 4, filters: {} }, NOW),
      ),
    ).toBe('INVALID_MATCH');
    expect(
      await code(
        matches.create(host, { sport: 'padel', bookingId: b.id, slotsTotal: 4, hostBrings: 1, filters: {} }, NOW),
      ),
    ).toBe('OK');
    expect(
      await code(
        matches.create(host, { sport: 'padel', bookingId: b.id, slotsTotal: 4, hostBrings: 1, filters: {} }, NOW),
      ),
    ).toBe('ALREADY_A_MATCH');
  });

  it('an unlisted venue needs the warning accepted, by the host and by every joiner', async () => {
    const host = await person();
    const unlisted = {
      name: 'Park ground',
      address: 'Test Park',
      latitude: 31.5,
      longitude: 74.3,
      startAt: at('2030-01-09T17:00'),
      endAt: at('2030-01-09T19:00'),
    };
    const input = { sport: 'padel', unlisted, slotsTotal: 10, hostBrings: 5, filters: {} };
    expect(await code(matches.create(host, input, NOW))).toBe('UNLISTED_WARNING_REQUIRED');
    const { id } = await matches.create(host, { ...input, acceptedUnlistedWarning: true }, NOW);
    const joiner = await person();
    expect(await code(matches.join(joiner, id, {}, NOW))).toBe('UNLISTED_WARNING_REQUIRED');
    await matches.join(joiner, id, { acceptedUnlistedWarning: true }, NOW);
    expect(await matches.decide(host, id, joiner, true, NOW)).toEqual({ status: 'confirmed' }); // nothing to pay
    expect((await matches.get(joiner, id, NOW)).pricePerPlayer).toBeNull();
  });
});

describe('who can see and join', () => {
  it('filters hide the match from players outside them', async () => {
    const host = await person({ gender: 'female' });
    const { id } = await listedMatch(host, { filters: { gender: 'female', minAge: 18, verifiedOnly: true } });
    const man = await person({ gender: 'male', verified: true });
    const unverified = await person({ gender: 'female' });
    const teen = await person({ gender: 'female', dob: '2015-01-01', verified: true });
    const fits = await person({ gender: 'female', verified: true });

    for (const p of [man, unverified, teen]) {
      expect((await matches.list(p, {}, NOW)).some((m) => m.id === id)).toBe(false);
      expect(await code(matches.get(p, id, NOW))).toBe('NOT_FOUND');
      expect(await code(matches.join(p, id, {}, NOW))).toBe('NOT_ELIGIBLE');
    }
    expect((await matches.list(fits, {}, NOW)).some((m) => m.id === id)).toBe(true);
    expect(await code(matches.join(fits, id, {}, NOW))).toBe('OK');
  });

  it('a player the host has blocked cannot see or join their matches', async () => {
    const host = await person();
    const { id } = await listedMatch(host);
    const blocked = await person();
    await db.insert(blocks).values({ blockerId: host, blockedId: blocked });
    expect((await matches.list(blocked, {}, NOW)).some((m) => m.id === id)).toBe(false);
    expect(await code(matches.join(blocked, id, {}, NOW))).toBe('NOT_ELIGIBLE');
  });

  it('joining closes at the cut-off before the start, and overlapping matches are blocked', async () => {
    const host = await person();
    const m = await listedMatch(host);
    expect(
      await code(matches.join(await person(), m.id, {}, new Date(m.booking.startAt.getTime() - 60 * 60_000))),
    ).toBe('CLOSED');

    const player = await person();
    await matches.join(player, m.id, {}, NOW);
    const other = await matches.create(
      await person(),
      {
        sport: 'padel',
        unlisted: {
          name: 'Other',
          address: 'Other road',
          latitude: 31.5,
          longitude: 74.3,
          startAt: m.booking.startAt,
          endAt: m.booking.endAt,
        },
        acceptedUnlistedWarning: true,
        slotsTotal: 4,
        hostBrings: 1,
        filters: {},
      },
      NOW,
    );
    expect(await code(matches.join(player, other.id, { acceptedUnlistedWarning: true }, NOW))).toBe('OVERLAPPING');
  });
});

describe('approval and shares', () => {
  it('approval creates the joiner’s share; the vendor confirming it confirms their place', async () => {
    const host = await person();
    const m = await listedMatch(host); // 4 places, host brings 2
    const joiner = await person();
    await matches.join(joiner, m.id, {}, NOW);
    expect(await code(matches.payShare(joiner, m.id, { method: 'jazzcash', txnReference: 'TEST0001' }))).toBe(
      'NOT_APPROVED',
    );
    expect(await matches.decide(host, m.id, joiner, true, NOW)).toEqual({ status: 'approved' });

    const info = await matches.payInfo(joiner, m.id);
    expect(info).toMatchObject({ amount: Math.ceil(m.booking.total / 4), shareStatus: 'pending' });
    expect(info.accounts).toEqual([expect.objectContaining({ method: 'jazzcash', accountNumber: '0300 0000000' })]);
    await matches.payShare(joiner, m.id, { method: 'jazzcash', txnReference: `TEST${randomInt(0, 1e9)}` });

    const queued = (await payments.queue(v.userId, NOW)).find((q) => q.booking.id === m.booking.id)!;
    await payments.confirm(queued.id, v.userId, NOW);
    const detail = await matches.get(joiner, m.id, NOW);
    expect(detail.me).toMatchObject({ status: 'confirmed', shareStatus: 'confirmed' });
    expect(detail.slotsFilled).toBe(3);
  });

  it('once full, further approvals go to the waitlist; a player leaving frees the place', async () => {
    const host = await person();
    const m = await listedMatch(host, { slotsTotal: 3, hostBrings: 2 });
    const [a, b] = [await person(), await person()];
    await matches.join(a, m.id, {}, NOW);
    await matches.join(b, m.id, {}, NOW);
    expect(await matches.decide(host, m.id, a, true, NOW)).toEqual({ status: 'approved' });
    expect((await matches.get(host, m.id, NOW)).status).toBe('full');
    expect(await matches.decide(host, m.id, b, true, NOW)).toEqual({ status: 'waitlisted' });

    await matches.leave(a, m.id, NOW);
    const [share] = await db
      .select({ status: bookingShares.status })
      .from(bookingShares)
      .where(eq(bookingShares.userId, a));
    expect(share!.status).toBe('void');
    expect((await matches.get(host, m.id, NOW)).status).toBe('open');
    expect(await matches.decide(host, m.id, b, true, NOW)).toEqual({ status: 'approved' });
  });

  it('only the host approves, removes or cancels', async () => {
    const host = await person();
    const m = await listedMatch(host);
    const player = await person();
    await matches.join(player, m.id, {}, NOW);
    expect(await code(matches.decide(player, m.id, player, true, NOW))).toBe('NOT_HOST');
    expect(await code(matches.cancel(player, m.id, NOW))).toBe('NOT_HOST');
    await matches.decide(host, m.id, player, true, NOW);
    expect(await matches.remove(host, m.id, player, later(10))).toEqual({ status: 'removed' });
    expect(await matches.cancel(host, m.id, NOW)).toEqual({ status: 'cancelled' });
  });
});
