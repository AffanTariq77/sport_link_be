import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { localToInstant, slotTimes } from '../src/bookings/pricing.js';
import { branches } from '../src/db/schema.js';
import { VenueError, VenuesService } from '../src/venues/venues.service.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const venues = new VenuesService(db);
const bookings = new BookingsService(db);
afterAll(() => pool.end());

const MONDAY = '2030-01-07';
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('slot times', () => {
  it('converts venue local time to UTC, including past midnight', () => {
    expect(localToInstant(MONDAY, 20 * 60, 'Asia/Karachi')).toEqual(at('2030-01-07T20:00'));
    expect(localToInstant(MONDAY, 25 * 60, 'Asia/Karachi')).toEqual(at('2030-01-08T01:00'));
  });

  it('cuts opening hours into slots, including windows that close after midnight', () => {
    const hours = [{ weekday: 1, opensAt: '22:00', closesAt: '01:30' }];
    expect(slotTimes(1, hours, 60)).toEqual([
      [22 * 60, 23 * 60],
      [23 * 60, 24 * 60],
      [24 * 60, 25 * 60],
    ]);
    expect(slotTimes(2, hours, 60)).toEqual([]);
  });
});

describe('venues', () => {
  let v: Awaited<ReturnType<typeof createVenue>>;
  beforeAll(async () => {
    v = await createVenue(db);
  });

  it('lists live venues with sport, city and lowest price filters', async () => {
    const found = (await venues.list({ sport: 'padel', city: 'lahore' })).find((x) => x.id === v.branchId);
    expect(found).toMatchObject({ sports: ['Padel'], courtCount: 1, currency: 'PKR', fromPricePerHour: 300_000 });
    expect((await venues.list({ city: 'Karachi' })).some((x) => x.id === v.branchId)).toBe(false);
    expect((await venues.list({ sport: 'cricket' })).some((x) => x.id === v.branchId)).toBe(false);
  });

  it('shows the refund policy but never payment account details', async () => {
    const venue = await venues.get(v.branchId);
    expect(venue.policy).toEqual({
      advanceType: 'percentage',
      advanceValue: 2000,
      cancelRefund: true,
      cancelWindowHours: 24,
      noShowRefund: false,
    });
    expect(venue.paymentMethods).toEqual([]);
    expect(JSON.stringify(venue)).not.toMatch(/account/i);
  });

  it('hides venues that are not live', async () => {
    const hidden = await createVenue(db);
    await db.update(branches).set({ status: 'suspended' }).where(eq(branches.id, hidden.branchId));
    expect((await venues.list({})).some((x) => x.id === hidden.branchId)).toBe(false);
    await expect(venues.get(hidden.branchId)).rejects.toBeInstanceOf(VenueError);
    await expect(venues.slots(hidden.courtId, MONDAY, NOW)).rejects.toBeInstanceOf(VenueError);
  });
});

describe('court slots', () => {
  let v: Awaited<ReturnType<typeof createVenue>>;
  beforeAll(async () => {
    v = await createVenue(db);
  });

  it('prices each slot from the price rules, through to closing after midnight', async () => {
    const { currency, slots } = await venues.slots(v.courtId, MONDAY, NOW);
    expect(currency).toBe('PKR');
    expect(slots).toHaveLength(20); // 06:00 to 02:00
    expect(slots[0]).toMatchObject({ startAt: at('2030-01-07T06:00'), price: 300_000, available: true });
    expect(slots.find((s) => s.startAt.getTime() === at('2030-01-07T19:00').getTime())?.price).toBe(500_000);
    expect(slots.at(-1)).toMatchObject({ startAt: at('2030-01-08T01:00'), price: 400_000 });
  });

  it('marks held slots as taken until the hold expires', async () => {
    const hold = await bookings.createHold({
      courtId: v.courtId,
      userId: v.userId,
      startAt: at('2030-01-07T20:00'),
      endAt: at('2030-01-07T21:00'),
      now: NOW,
    });
    const taken = (now: Date) =>
      venues
        .slots(v.courtId, MONDAY, now)
        .then((r) => r.slots.filter((s) => !s.available).map((s) => s.startAt.toISOString()));
    expect(await taken(NOW)).toEqual([at('2030-01-07T20:00').toISOString()]);
    expect(await taken(new Date(hold.holdExpiresAt!.getTime() + 1000))).toEqual([]);

    const [mine] = await bookings.listForUser(v.userId, later(20));
    expect(mine).toMatchObject({ id: hold.id, status: 'expired', total: 500_000, advanceDue: 100_000 });
  });

  it('leaves out slots that have already started, and past dates', async () => {
    const { slots } = await venues.slots(v.courtId, MONDAY, at('2030-01-07T12:30'));
    expect(slots[0]!.startAt).toEqual(at('2030-01-07T13:00'));
    await expect(venues.slots(v.courtId, '2030-01-06', at('2030-01-07T12:30'))).rejects.toMatchObject({
      code: 'INVALID_DATE',
    });
  });
});
