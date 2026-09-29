import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ChatError, ChatService } from '../src/chat/chat.service.js';
import { blocks, findResponses, matchPlayers, playerAvailability, users } from '../src/db/schema.js';
import { distanceBand, FindError, FindService, roundCoord } from '../src/find/find.service.js';
import { MatchesService } from '../src/matches/matches.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, testDb } from './fixtures.js';

const { db, pool } = testDb();
const matches = new MatchesService(db, new DocumentCrypto(randomBytes(32).toString('base64')));
const find = new FindService(db, matches);
const chat = new ChatService(db);
afterAll(() => pool.end());
beforeAll(() => createVenue(db)); // makes sure the padel sport exists

// Midday in Pakistan, outside quiet hours.
const T = at('2030-04-10T12:00');
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof FindError || e instanceof ChatError ? e.code : Promise.reject(e)),
  );
// Each test runs in its own area far from the others, so candidates never leak between tests.
let area = 0;
function place() {
  area++;
  return { lat: 24 + area * 0.5, lng: 67 + area * 0.5 };
}
/** A fake player at an offset in km north of the base point, alerts on. */
async function player(
  base: { lat: number; lng: number },
  northKm: number,
  extra: Partial<typeof users.$inferInsert> = {},
) {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`,
      countryCode: 'PK',
      name: 'Find Player',
      status: 'active',
      dob: '1995-01-01',
      gender: 'male',
      ...extra,
    })
    .returning({ id: users.id });
  await find.setLocation(u!.id, base.lat + northKm / 111, base.lng, T);
  await find.setAvailability(u!.id, { alertMode: 'always' });
  return u!.id;
}
const request = (userId: string, extra: Partial<Parameters<FindService['create']>[1]> = {}) =>
  find.create(userId, { sport: 'padel', playersNeeded: 2, radiusKm: 5, window: 'now', filters: {}, ...extra }, T);

describe('location privacy', () => {
  it('stores about 500 m precision and shows only distance bands', async () => {
    expect(roundCoord(31.52047)).toBeCloseTo(31.52, 6);
    expect([distanceBand(1500), distanceBand(3000), distanceBand(7000), distanceBand(20000)]).toEqual([
      'under 2 km',
      '2 to 5 km',
      '5 to 10 km',
      'over 10 km',
    ]);
    const base = place();
    const me = await player(base, 0);
    const [row] = await db
      .select({ lat: sql<number>`st_y(${playerAvailability.location}::geometry)` })
      .from(playerAvailability)
      .where(eq(playerAvailability.userId, me));
    expect(Number(row!.lat) / 0.005).toBeCloseTo(Math.round(Number(row!.lat) / 0.005), 6);
  });
});

describe('requests and alerts', () => {
  it('alerts nearby matching players nearest first; the requester picks; the group chats', async () => {
    const base = place();
    const host = await player(base, 0, { name: 'Requester' });
    const near = await player(base, 1, { name: 'Near' });
    const mid = await player(base, 3, { name: 'Mid' });
    const far = await player(base, 12); // outside 5 km
    const off = await player(base, 1);
    await find.setAvailability(off, { alertMode: 'available', available: false });
    const blocked = await player(base, 1);
    await db.insert(blocks).values({ blockerId: blocked, blockedId: host });
    const tennisOnly = await player(base, 1);
    await find.setAvailability(tennisOnly, { sports: ['tennis'] });

    const { id, notified } = await request(host);
    expect(notified).toBe(2);
    const alerted = await db.select().from(findResponses).where(eq(findResponses.requestId, id));
    expect(alerted.map((a) => a.userId).sort()).toEqual([near, mid].sort());
    expect(alerted.some((a) => [far, off, blocked, tennisOnly].includes(a.userId))).toBe(false);

    const incoming = (await find.mine(near, T)).incoming.find((r) => r.id === id)!;
    expect(incoming).toMatchObject({ distance: 'under 2 km', myStatus: 'notified', requester: 'Requester' });
    expect(JSON.stringify(await find.get(near, id, T))).not.toMatch(/latitude|longitude|POINT/);

    await find.respond(near, id, true, T);
    await find.respond(mid, id, true, T);
    expect(await code(find.respond(mid, id, true, T))).toBe('NOT_FOUND'); // answered already
    const view = await find.get(host, id, T);
    expect(view.players.map((p) => [p.name, p.distance])).toEqual([
      ['Near', 'under 2 km'],
      ['Mid', '2 to 5 km'],
    ]);

    expect(await code(find.select(host, id, [far], T))).toBe('NOT_ACCEPTED');
    await find.select(host, id, [near], T);
    const { id: chatId } = await chat.openFind(host, id);
    await chat.send(near, chatId, { body: 'Where shall we play?' });
    expect(await code(chat.openFind(mid, id))).toBe('NOT_FOUND'); // not picked (yet)

    await find.select(host, id, [mid], T);
    expect((await find.get(host, id, T)).status).toBe('matched');
    await find.remove(host, id, mid, T); // went silent: pick again
    expect((await find.get(host, id, T)).status).toBe('open');
  });

  it('respects the radius cap, rate limit, quiet hours and the daily alert cap', async () => {
    const base = place();
    const host = await player(base, 0);
    expect(await code(request(host, { radiusKm: 26 }))).toBe('INVALID_REQUEST');
    const night = await player(base, 1);
    await request(host);
    await request(host);
    await request(host);
    expect(await code(request(host))).toBe('RATE_LIMITED');

    const other = await player(base, 0.5);
    const late = at('2030-04-10T23:30');
    await find.setLocation(other, base.lat, base.lng, late);
    await find.setLocation(night, base.lat + 1 / 111, base.lng, late);
    const quiet = await find.create(
      other,
      { sport: 'padel', playersNeeded: 1, radiusKm: 5, window: 'now', filters: {} },
      late,
    );
    expect(quiet.notified).toBe(0); // 23:30 in Pakistan
    await find.setAvailability(night, { quietHoursOk: true });
    const allowed = await find.create(
      other,
      { sport: 'padel', playersNeeded: 1, radiusKm: 5, window: 'now', filters: {} },
      late,
    );
    expect(allowed.notified).toBe(1);
  });

  it('keeps minors and adults apart unless the guardian allows it (Foundation 10.2)', async () => {
    const base = place();
    const adult = await player(base, 0);
    const minor = await player(base, 1, { isMinor: true, dob: '2014-01-01' });
    const guardian = await player(base, 40);
    await db.update(users).set({ guardianUserId: guardian }).where(eq(users.id, minor));
    expect((await request(adult)).notified).toBe(0);
    await find.setGuardianAllowsAdults(guardian, minor, true);
    expect(await code(find.setGuardianAllowsAdults(adult, minor, true))).toBe('NOT_FOUND');
    const second = await player(base, 0.2);
    expect((await request(second)).notified).toBe(2); // the minor and the first adult
  });

  it('needs a verified account and a recent location', async () => {
    const base = place();
    const unverified = await player(base, 0, { status: 'pending_verification' });
    expect(await code(request(unverified))).toBe('NOT_ELIGIBLE');
    const stale = await player(base, 0);
    await find.setLocation(stale, base.lat, base.lng, new Date(T.getTime() - 13 * 3_600_000));
    expect(await code(request(stale))).toBe('NO_LOCATION');
  });

  it('converts into a match: picked players are added to the host’s match', async () => {
    const base = place();
    const host = await player(base, 0);
    const p = await player(base, 1);
    const { id } = await request(host, { playersNeeded: 1 });
    await find.respond(p, id, true, T);
    await find.select(host, id, [p], T);
    const start = at('2030-04-12T18:00');
    const unlisted = {
      name: 'Park',
      address: 'Test Park',
      latitude: 31.5,
      longitude: 74.3,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
    };
    const m = await matches.create(
      host,
      { sport: 'padel', unlisted, acceptedUnlistedWarning: true, slotsTotal: 2, hostBrings: 1, filters: {} },
      T,
    );
    expect(await find.convert(host, id, m.id, T)).toEqual({ ok: true, added: 1 });
    const [row] = await db.select({ status: matchPlayers.status }).from(matchPlayers).where(eq(matchPlayers.userId, p));
    expect(row!.status).toBe('confirmed'); // unlisted: nothing to pay
    expect((await find.get(host, id, T)).matchId).toBe(m.id);
  });

  it('expires at the end of the window and sends the next batch when too few accepted', async () => {
    const base = place();
    const host = await player(base, 0);
    const others = [];
    for (let i = 1; i <= 12; i++) others.push(await player(base, i * 0.3));
    const { id, notified } = await request(host, { playersNeeded: 3 });
    expect(notified).toBe(10); // find.batch_size
    await find.runJobs(new Date(T.getTime() + 6 * 60_000));
    expect((await find.get(host, id, T)).notified).toBe(12);
    await find.runJobs(new Date(T.getTime() + 4 * 3_600_000));
    expect((await find.get(host, id, T)).status).toBe('expired');
  });
});
