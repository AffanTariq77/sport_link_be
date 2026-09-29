import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, matches as matchesTable, ratings, reports, sports, users } from '../src/db/schema.js';
import { MatchesService } from '../src/matches/matches.service.js';
import { rate } from '../src/ratings/glicko.js';
import { PlayersService, tierFor } from '../src/ratings/players.service.js';
import { ResultError, ResultsService } from '../src/ratings/results.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const matches = new MatchesService(db, new DocumentCrypto(randomBytes(32).toString('base64')));
const results = new ResultsService(db);
const players = new PlayersService(db);
const admin = { adminId: '00000000-0000-4000-8000-000000000001', ip: null };
afterAll(() => pool.end());
beforeAll(() => createVenue(db)); // also makes sure the padel sport exists

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof ResultError ? e.code : Promise.reject(e)),
  );
// Fake people only.
async function person(name = 'Rated Player') {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`,
      countryCode: 'PK',
      name,
      city: 'Ratingpur',
      status: 'active',
    })
    .returning({ id: users.id });
  return u!.id;
}

let day = 10;
/** A finished 2 v 2 padel match at an unlisted ground: host plus three confirmed players. */
async function playedMatch(people?: string[]) {
  const [host, a, b, c] = people ?? [await person('Host'), await person('A'), await person('B'), await person('C')];
  const start = at(`2030-01-${String(day++).padStart(2, '0')}T17:00`);
  const end = new Date(start.getTime() + 3_600_000);
  const unlisted = { name: 'Park', address: 'Test Park', latitude: 31.5, longitude: 74.3, startAt: start, endAt: end };
  const { id } = await matches.create(
    host!,
    { sport: 'padel', unlisted, acceptedUnlistedWarning: true, slotsTotal: 4, hostBrings: 1, filters: {} },
    NOW,
  );
  for (const p of [a, b, c]) {
    await matches.join(p!, id, { acceptedUnlistedWarning: true }, NOW);
    await matches.decide(host!, id, p!, true, NOW);
  }
  return { id, host: host!, a: a!, b: b!, c: c!, end, after: new Date(end.getTime() + 60_000) };
}
async function rating(userId: string) {
  const [padel] = await db.select({ id: sports.id }).from(sports).where(eq(sports.slug, 'padel'));
  const [r] = await db
    .select()
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.sportId, padel!.id)));
  return r;
}

describe('results', () => {
  it('one side submits, the other confirms, and ratings move by Glicko-2', async () => {
    const m = await playedMatch();
    const input = { sideA: [m.host, m.a], sideB: [m.b, m.c], outcome: 'a' as const, score: '6-4 6-3' };
    expect(await code(results.submit(m.host, m.id, input, new Date(m.end.getTime() - 60_000)))).toBe('NOT_FINISHED');
    expect(await code(results.submit(m.host, m.id, { ...input, sideB: [m.b] }, m.after))).toBe('INVALID_SIDES');
    expect(await code(results.submit(await person(), m.id, input, m.after))).toBe('NOT_FOUND');

    await results.submit(m.host, m.id, input, m.after);
    expect(await code(results.submit(m.b, m.id, input, m.after))).toBe('ALREADY_SUBMITTED');
    expect(await code(results.respond(m.a, m.id, { agree: true }, m.after))).toBe('NOT_OTHER_SIDE');
    expect(await rating(m.host)).toBeUndefined(); // held until confirmed (spec 11.4)

    const state = await results.state(m.b, m.id, m.after);
    expect(state).toMatchObject({ canRespond: true, canSubmit: false, result: { status: 'pending', outcome: 'a' } });
    expect(state.participants.map((p) => p.id).sort()).toEqual([m.host, m.a, m.b, m.c].sort());

    expect(await results.respond(m.b, m.id, { agree: true }, m.after)).toEqual({ status: 'confirmed' });
    const [winner, loser] = [await rating(m.host), await rating(m.b)];
    expect(winner!.rating).toBeGreaterThan(1500);
    expect(loser!.rating).toBeLessThan(1500);
    expect(winner!.rating - 1500).toBeCloseTo(1500 - loser!.rating, 6); // equal composites: symmetric
    expect(winner!.deviation).toBeLessThan(350);
    expect(winner!.games).toBe(1);
    const [row] = await db.select({ status: matchesTable.status }).from(matchesTable).where(eq(matchesTable.id, m.id));
    expect(row!.status).toBe('completed');
  });

  it('silence confirms after the window (setting); a dispute goes to an admin whose decision is logged', async () => {
    const quiet = await playedMatch();
    const input = { sideA: [quiet.host, quiet.a], sideB: [quiet.b, quiet.c], outcome: 'draw' as const };
    const { confirmBy } = await results.submit(quiet.a, quiet.id, input, quiet.after);
    await results.finaliseExpired(new Date(confirmBy.getTime() - 1));
    expect(await rating(quiet.a)).toBeUndefined();
    await results.finaliseExpired(new Date(confirmBy.getTime() + 1));
    expect((await rating(quiet.a))!.games).toBe(1);

    const m = await playedMatch();
    await results.submit(m.host, m.id, { sideA: [m.host, m.a], sideB: [m.b, m.c], outcome: 'a' }, m.after);
    expect(await code(results.respond(m.c, m.id, { agree: false }, m.after))).toBe('NOTE_REQUIRED');
    await results.respond(m.c, m.id, { agree: false, note: 'We won the second set 6-2' }, m.after);
    const flagged = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, m.id), eq(reports.reason, 'result_dispute')));
    expect(flagged).toHaveLength(1);
    expect((await results.listDisputed()).some((d) => d.matchId === m.id)).toBe(true);

    const resultId = (await results.state(m.host, m.id, m.after)).result!.id;
    await results.decide(resultId, { outcome: 'b', note: 'Side B won on the evidence.' }, admin);
    expect((await rating(m.c))!.rating).toBeGreaterThan(1500);
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'result.decide'), eq(auditLog.targetId, resultId)));
    expect(logged).toHaveLength(1);
  });

  it('voiding a rated result puts the ratings back', async () => {
    const m = await playedMatch();
    await results.submit(m.host, m.id, { sideA: [m.host, m.a], sideB: [m.b, m.c], outcome: 'a' }, m.after);
    await results.respond(m.b, m.id, { agree: true }, m.after);
    const id = (await results.state(m.host, m.id, m.after)).result!.id;
    await results.decide(id, { outcome: 'void', note: 'Players colluded.' }, admin);
    expect(await rating(m.host)).toMatchObject({ rating: 1500, deviation: 350, games: 0 });
  });

  it('repeat games against the same opponents change ratings less (anti-abuse setting)', async () => {
    const group = [await person(), await person(), await person(), await person()];
    for (let i = 0; i < 3; i++) {
      // rating.repeat_opponent_games (3) games against the same opponents
      const m = await playedMatch(group);
      await results.submit(m.host, m.id, { sideA: [m.host, m.a], sideB: [m.b, m.c], outcome: 'draw' }, m.after);
      await results.respond(m.b, m.id, { agree: true }, m.after);
    }
    const m = await playedMatch(group);
    const before = (await rating(m.host))!;
    await results.submit(m.host, m.id, { sideA: [m.host, m.a], sideB: [m.b, m.c], outcome: 'a' }, m.after);
    await results.respond(m.b, m.id, { agree: true }, m.after);
    const damped = (await rating(m.host))!.rating - before.rating;
    expect(damped).toBeGreaterThan(0);
    // Undamped, the same win from the same position would move the rating twice as far (factor 0.5).
    const full = rate(before, before, 1, 0.5).rating - before.rating;
    expect(damped).toBeCloseTo(full * 0.5, 6);
  });
});

describe('reviews, profiles and leaderboards', () => {
  it('confirmed participants review each other once within the window; profiles show the average', async () => {
    const m = await playedMatch();
    const review = { toUserId: m.b, stars: 5, tags: ['on_time', 'fair_play'] };
    expect(await code(results.review(m.host, m.id, review, new Date(m.end.getTime() - 60_000)))).toBe('REVIEW_CLOSED');
    expect(await code(results.review(m.host, m.id, { ...review, toUserId: m.host }, m.after))).toBe('INVALID_REVIEW');
    expect(await code(results.review(m.host, m.id, { ...review, tags: ['rude'] }, m.after))).toBe('INVALID_REVIEW');
    await results.review(m.host, m.id, review, m.after);
    expect(await code(results.review(m.host, m.id, review, m.after))).toBe('ALREADY_REVIEWED');
    await results.review(m.a, m.id, { toUserId: m.b, stars: 4, tags: ['on_time'] }, m.after);
    expect(await code(results.review(m.c, m.id, review, new Date(m.end.getTime() + 49 * 3_600_000)))).toBe(
      'REVIEW_CLOSED',
    );

    const profile = await players.profile(m.b);
    expect(profile.behaviour).toEqual({
      average: 4.5,
      count: 2,
      topTags: [
        { tag: 'on_time', count: 2 },
        { tag: 'fair_play', count: 1 },
      ],
    });
    expect(profile).not.toHaveProperty('phone');
    expect((await results.state(m.host, m.id, m.after)).reviewable.find((p) => p.id === m.b)?.reviewed).toBe(true);
  });

  it('tiers come from rating bands; provisional players stay off the leaderboard', async () => {
    const tiers = [
      { name: 'Bronze', min: 0 },
      { name: 'Silver', min: 1400 },
      { name: 'Gold', min: 1600 },
    ];
    expect([tierFor(1399, tiers), tierFor(1400, tiers), tierFor(2500, tiers)]).toEqual(['Bronze', 'Silver', 'Gold']);

    const [padel] = await db.select({ id: sports.id }).from(sports).where(eq(sports.slug, 'padel'));
    const settled = await person('Settled Star');
    const fresh = await person('Fresh Face');
    await db.insert(ratings).values([
      { userId: settled, sportId: padel!.id, rating: 1850, deviation: 60, volatility: 0.06, games: 40 },
      { userId: fresh, sportId: padel!.id, rating: 1900, deviation: 300, volatility: 0.06, games: 1 },
    ]);
    const board = await players.leaderboard('padel', 'Ratingpur');
    expect(board.some((r) => r.id === fresh)).toBe(false);
    expect(board.find((r) => r.id === settled)).toMatchObject({ rating: 1850, tier: 'Platinum' });
    expect((await players.profile(fresh)).ratings[0]).toMatchObject({ provisional: true, tier: null });
    expect(await code(players.leaderboard('no-such-sport'))).toBe('NOT_FOUND');
  });

  it('a skill rating range on a match hides it from players outside the range (unrated counts as 1500)', async () => {
    const [padel] = await db.select({ id: sports.id }).from(sports).where(eq(sports.slug, 'padel'));
    const host = await person();
    const strong = await person();
    await db
      .insert(ratings)
      .values({ userId: strong, sportId: padel!.id, rating: 1800, deviation: 80, volatility: 0.06, games: 20 });
    const start = at('2030-02-20T17:00');
    const unlisted = {
      name: 'Park',
      address: 'Test Park',
      latitude: 31.5,
      longitude: 74.3,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
    };
    const { id } = await matches.create(
      host,
      {
        sport: 'padel',
        unlisted,
        acceptedUnlistedWarning: true,
        slotsTotal: 4,
        hostBrings: 1,
        filters: { minRating: 1700 },
      },
      NOW,
    );
    expect((await matches.list(await person(), {}, NOW)).some((m) => m.id === id)).toBe(false);
    expect((await matches.list(strong, {}, NOW)).some((m) => m.id === id)).toBe(true);
  });
});
