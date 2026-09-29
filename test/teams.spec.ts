import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ChatError, ChatService } from '../src/chat/chat.service.js';
import { auditLog, reports, teamRatings, users } from '../src/db/schema.js';
import { MatchError, MatchesService } from '../src/matches/matches.service.js';
import { ResultError, ResultsService } from '../src/ratings/results.service.js';
import { TeamError, TeamsService } from '../src/teams/teams.service.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const teams = new TeamsService(db);
const matches = new MatchesService(db, new DocumentCrypto(randomBytes(32).toString('base64')));
const results = new ResultsService(db);
const chat = new ChatService(db);
const admin = { adminId: '00000000-0000-4000-8000-000000000001', ip: null };
afterAll(() => pool.end());
beforeAll(() => createVenue(db)); // makes sure the padel sport exists

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) =>
      e instanceof TeamError || e instanceof MatchError || e instanceof ResultError || e instanceof ChatError
        ? e.code
        : Promise.reject(e),
  );
// Fake people only. Returns the id and the local phone number used to invite them.
async function person(name = 'Team Player') {
  const digits = String(randomInt(0, 1e7)).padStart(7, '0');
  const [u] = await db
    .insert(users)
    .values({ phone: `+92305${digits}`, countryCode: 'PK', name, status: 'active' })
    .returning({ id: users.id });
  return { id: u!.id, phone: `0305 ${digits}` };
}
/** A team with a captain and `n` accepted members. */
async function team(name: string, n = 1) {
  const captain = await person(`${name} Captain`);
  const { id } = await teams.create(captain.id, { sport: 'padel', name });
  const members = [];
  for (let i = 0; i < n; i++) {
    const m = await person(`${name} Member ${i + 1}`);
    await teams.invite(captain.id, id, m.phone);
    await teams.respond(m.id, id, true);
    members.push(m);
  }
  return { id, captain, members };
}

describe('roster and roles', () => {
  it('the captain invites by phone, the player accepts; roles and handover follow the rules', async () => {
    const captain = await person('Captain');
    const { id } = await teams.create(captain.id, { sport: 'padel', name: 'Lahore Lions', city: 'Lahore' });
    expect(await code(teams.invite(captain.id, id, '0305 0000000'))).toBe('NOT_FOUND');
    const ali = await person('Ali');
    await teams.invite(captain.id, id, ali.phone);
    expect(await code(teams.invite(captain.id, id, ali.phone))).toBe('ALREADY_MEMBER');
    expect((await teams.get(ali.id, id)).invited).toBe(true);
    expect(await code(teams.invite(ali.id, id, (await person()).phone))).toBe('NOT_CAPTAIN'); // not a member yet
    await teams.respond(ali.id, id, true);
    expect(await code(teams.respond(ali.id, id, true))).toBe('NOT_INVITED');

    const page = await teams.get(ali.id, id);
    expect(page.members.map((m) => [m.name, m.role])).toEqual([
      ['Captain', 'captain'],
      ['Ali', 'member'],
    ]);
    expect(JSON.stringify(page)).not.toContain(ali.phone.replace(' ', ''));

    expect(await code(teams.leave(captain.id, id))).toBe('CAPTAIN_LEAVING');
    await teams.setRole(captain.id, id, ali.id, 'captain');
    expect((await teams.get(captain.id, id)).myRole).toBe('vice_captain');
    expect(await code(teams.remove(captain.id, id, ali.id))).toBe('NOT_CAPTAIN'); // cannot remove the captain
    await teams.leave(captain.id, id);
    await teams.leave(ali.id, id); // last member: the team is disbanded
    expect(await code(teams.get(ali.id, id))).toBe('NOT_FOUND');
  });

  it('a banned captain is replaced by the vice captain; without one an admin assigns, logged', async () => {
    const withVice = await team('Vice Ready', 1);
    await teams.setRole(withVice.captain.id, withVice.id, withVice.members[0]!.id, 'vice_captain');
    const noVice = await team('No Vice', 1);
    await db.update(users).set({ status: 'banned' }).where(eq(users.id, withVice.captain.id));
    await db.update(users).set({ status: 'banned' }).where(eq(users.id, noVice.captain.id));

    await teams.replaceBannedCaptains();
    expect((await teams.get(withVice.members[0]!.id, withVice.id)).myRole).toBe('captain');
    const flagged = await db
      .select()
      .from(reports)
      .where(and(eq(reports.targetId, noVice.id), eq(reports.reason, 'team_without_captain')));
    expect(flagged).toHaveLength(1);
    await teams.replaceBannedCaptains(); // no duplicate report
    expect(
      await db
        .select()
        .from(reports)
        .where(and(eq(reports.targetId, noVice.id), eq(reports.reason, 'team_without_captain'))),
    ).toHaveLength(1);

    await teams.assignCaptain(noVice.id, noVice.members[0]!.id, admin);
    expect((await teams.get(noVice.members[0]!.id, noVice.id)).myRole).toBe('captain');
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'team.assign_captain'), eq(auditLog.targetId, noVice.id)));
    expect(logged).toHaveLength(1);
  });

  it('team chat is for active members only', async () => {
    const t = await team('Chatters', 1);
    const { id } = await chat.openTeam(t.captain.id, t.id);
    await chat.send(t.members[0]!.id, id, { body: 'Training at six' });
    expect(await code(chat.openTeam((await person()).id, t.id))).toBe('NOT_FOUND');
    expect((await chat.list(t.captain.id)).find((c) => c.id === id)?.title).toBe('Team · Chatters');
  });
});

describe('team matches', () => {
  it('home challenges away; only the two teams play; the result moves team ratings, and a void undoes it', async () => {
    const home = await team('Home Side', 1);
    const away = await team('Away Side', 1);
    const other = await team('Other Side', 1);
    const start = at('2030-03-05T17:00');
    const end = new Date(start.getTime() + 3_600_000);
    const unlisted = {
      name: 'Park',
      address: 'Test Park',
      latitude: 31.5,
      longitude: 74.3,
      startAt: start,
      endAt: end,
    };
    const base = { sport: 'padel', unlisted, acceptedUnlistedWarning: true, slotsTotal: 4, hostBrings: 1, filters: {} };
    expect(await code(matches.create(home.members[0]!.id, { ...base, teamId: home.id }, NOW))).toBe('INVALID_MATCH');
    const { id } = await matches.create(home.captain.id, { ...base, teamId: home.id, opponentTeamId: away.id }, NOW);

    expect(await code(matches.acceptChallenge(other.captain.id, id, other.id, NOW))).toBe('NOT_ELIGIBLE');
    expect(await code(matches.acceptChallenge(away.members[0]!.id, id, away.id, NOW))).toBe('NOT_ELIGIBLE');
    await matches.acceptChallenge(away.captain.id, id, away.id, NOW);
    expect(await code(matches.acceptChallenge(away.captain.id, id, away.id, NOW))).toBe('CLOSED');
    expect((await matches.get(home.captain.id, id, NOW)).teams).toMatchObject({
      home: { name: 'Home Side' },
      away: { name: 'Away Side' },
    });

    expect(await code(matches.join((await person()).id, id, { acceptedUnlistedWarning: true }, NOW))).toBe(
      'NOT_ELIGIBLE',
    );
    for (const p of [home.members[0]!, away.captain, away.members[0]!]) {
      await matches.join(p.id, id, { acceptedUnlistedWarning: true }, NOW);
      await matches.decide(home.captain.id, id, p.id, true, NOW);
    }

    const after = new Date(end.getTime() + 60_000);
    const wrong = { sideA: [home.captain.id, away.captain.id], sideB: [home.members[0]!.id, away.members[0]!.id] };
    expect(await code(results.submit(home.captain.id, id, { ...wrong, outcome: 'a' }, after))).toBe('INVALID_SIDES');
    const sides = { sideA: [home.captain.id, home.members[0]!.id], sideB: [away.captain.id, away.members[0]!.id] };
    await results.submit(home.captain.id, id, { ...sides, outcome: 'a' }, after);
    await results.respond(away.captain.id, id, { agree: true }, after);

    const rating = async (teamId: string) =>
      (await db.select().from(teamRatings).where(eq(teamRatings.teamId, teamId)))[0];
    expect((await rating(home.id))!.rating).toBeGreaterThan(1500);
    expect((await rating(away.id))!.rating).toBeLessThan(1500);
    const page = await teams.get(home.captain.id, home.id);
    expect(page.rating).toMatchObject({ games: 1, provisional: true });
    expect(page.matches[0]).toMatchObject({ id, opponent: 'Away Side', result: 'won' });

    const resultId = (await results.state(home.captain.id, id, after)).result!.id;
    await results.decide(resultId, { outcome: 'void', note: 'Wrong teams played.' }, admin);
    expect(await rating(home.id)).toMatchObject({ rating: 1500, deviation: 350, games: 0 });
  });

  it('an open team match can be taken by any team of the sport', async () => {
    const home = await team('Open Home', 0);
    const taker = await team('Taker', 0);
    const start = at('2030-03-09T17:00');
    const unlisted = {
      name: 'Park',
      address: 'Test Park',
      latitude: 31.5,
      longitude: 74.3,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
    };
    const { id } = await matches.create(
      home.captain.id,
      {
        sport: 'padel',
        unlisted,
        acceptedUnlistedWarning: true,
        slotsTotal: 4,
        hostBrings: 1,
        filters: {},
        teamId: home.id,
      },
      NOW,
    );
    expect(await matches.acceptChallenge(taker.captain.id, id, taker.id, NOW)).toEqual({ id, awayTeamId: taker.id });
  });
});
