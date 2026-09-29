import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AnalyticsError, AnalyticsService } from '../src/analytics/analytics.service.js';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { bookings, users } from '../src/db/schema.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const analytics = new AnalyticsService(db);
const engine = new BookingsService(db);
afterAll(() => pool.end());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof AnalyticsError ? e.code : Promise.reject(e)),
  );
let v: Awaited<ReturnType<typeof createVenue>>;
let player: string;
const booking = async (start: string, status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', by = player) => {
  const b = await engine.createHold({
    courtId: v.courtId,
    userId: by,
    startAt: at(start),
    endAt: new Date(at(start).getTime() + 3_600_000),
    now: NOW,
  });
  await db
    .update(bookings)
    .set({ status, cancelledBy: status === 'cancelled' ? 'player' : null })
    .where(eq(bookings.id, b.id));
  return b;
};

beforeAll(async () => {
  v = await createVenue(db);
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name: 'Ayesha Khan' })
    .returning({ id: users.id });
  player = u!.id;
});

describe('vendor analytics', () => {
  it('counts bookings, revenue by court and source, cancellations and the occupancy heatmap', async () => {
    await booking('2030-01-07T08:00', 'completed'); // Monday 08:00, weekday day rate Rs 3,000
    await booking('2030-01-07T19:00', 'no_show'); // Monday evening Rs 5,000
    await booking('2030-01-08T08:00', 'cancelled');
    await engine.createManual({
      courtId: v.courtId,
      startAt: at('2030-01-09T10:00'),
      endAt: at('2030-01-09T11:00'),
      staffUserId: v.userId,
      customerName: 'Walk-in',
      now: NOW,
    });
    const r = await analytics.vendor(v.userId, { from: at('2030-01-06T00:00'), to: at('2030-01-13T00:00') });
    expect(r.bookings).toMatchObject({ total: 4, app: 3, manual: 1, completed: 1, noShows: 1 });
    expect(r.revenue).toMatchObject({ total: 300_000 + 500_000 + 300_000, app: 800_000, manual: 300_000 });
    expect(r.revenue.byCourt[0]).toMatchObject({ bookings: 3, revenue: 1_100_000 });
    expect(r.cancellations).toEqual({ total: 1, byPlayer: 1, byVenue: 0 });
    expect(r.occupancy.heatmap[1]![8]).toBe(1); // Monday 08:00 local
    expect(r.occupancy.heatmap[1]![19]).toBe(1);
    expect(r.occupancy.percent).toBeGreaterThan(0);
    // 3 booked hours out of 20 open hours a day for 7 days
    expect(r.occupancy.percent).toBeCloseTo((3 / 140) * 100, 0);
    expect(await code(analytics.vendor(player, { from: at('2030-01-06T00:00'), to: at('2030-01-13T00:00') }))).toBe(
      'NOT_FOUND',
    );
  });

  it('projects revenue from price rules at a chosen occupancy', async () => {
    const full = await analytics.calculator(v.userId, 100, at('2030-01-07T00:00'));
    const half = await analytics.calculator(v.userId, 50, at('2030-01-07T00:00'));
    expect(full.fullMonth).toBeGreaterThan(0);
    expect(full.projected).toBe(full.fullMonth);
    expect(half.projected).toBe(Math.round(full.fullMonth / 2));
  });
});

describe('venue reviews', () => {
  it('the booker reviews once after playing; the venue replies; the page shows the average', async () => {
    const played = await booking('2030-01-10T08:00', 'completed');
    const later = new Date(played.endAt.getTime() + 3_600_000);
    expect(
      await code(analytics.reviewVenue(player, played.id, { stars: 4 }, new Date(played.endAt.getTime() - 1))),
    ).toBe('REVIEW_CLOSED');
    expect(await code(analytics.reviewVenue(v.userId, played.id, { stars: 5 }, later))).toBe('NOT_FOUND');
    await analytics.reviewVenue(player, played.id, { stars: 4, comment: 'Good lights' }, later);
    expect(await code(analytics.reviewVenue(player, played.id, { stars: 5 }, later))).toBe('ALREADY_REVIEWED');
    expect(
      await code(analytics.reviewVenue(player, played.id, { stars: 5 }, new Date(later.getTime() + 15 * 86_400_000))),
    ).toBe('REVIEW_CLOSED');

    const page = await analytics.venueReviews(v.branchId);
    expect(page).toMatchObject({ average: 4, count: 1 });
    expect(page.reviews[0]).toMatchObject({ author: 'Ayesha', comment: 'Good lights', reply: null });
    await analytics.reply(v.userId, page.reviews[0]!.id, 'Thanks for coming!');
    expect(await code(analytics.reply(player, page.reviews[0]!.id, 'Hi'))).toBe('NOT_FOUND');
    expect((await analytics.venueReviews(v.branchId)).reviews[0]!.reply).toBe('Thanks for coming!');
  });
});

describe('platform analytics', () => {
  it('reports booking value, commission, active users and breakdowns', async () => {
    const r = await analytics.platform({ from: at('2030-01-06T00:00'), to: at('2030-01-13T00:00') });
    expect(r.bookingValue.reduce((s, x) => s + x.count, 0)).toBeGreaterThanOrEqual(4);
    expect(r.topVenues.some((t) => t.branchId === v.branchId)).toBe(true);
    expect(r.cities.length).toBeGreaterThan(0);
    expect(r.sports.some((s) => s.sport === 'Padel')).toBe(true);
    expect(typeof r.commission.due).toBe('number');
    expect(await code(analytics.platform({ from: at('2030-01-13T00:00'), to: at('2030-01-06T00:00') }))).toBe(
      'INVALID_RANGE',
    );
  });
});
