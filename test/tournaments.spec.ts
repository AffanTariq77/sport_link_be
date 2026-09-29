import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  ratings,
  sports,
  tournamentFixtures,
  tournaments as tournamentsTable,
  users,
} from '../src/db/schema.js';
import { TeamError, TeamsService } from '../src/teams/teams.service.js';
import { TournamentError, TournamentsService } from '../src/tournaments/tournaments.service.js';
import { createVenue, testDb } from './fixtures.js';

const { db, pool } = testDb();
const tournaments = new TournamentsService(db);
const teams = new TeamsService(db);
const admin = { adminId: '00000000-0000-4000-8000-000000000001', ip: null };
afterAll(() => pool.end());
beforeAll(() => createVenue(db)); // makes sure the padel sport exists

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof TournamentError || e instanceof TeamError ? e.code : Promise.reject(e)),
  );
const day = (n: number) => new Date(Date.UTC(2030, 5, n, 10));
const REG_OPEN = day(1);
const AFTER_DEADLINE = day(11);
// Fake people only.
async function person(extra: Partial<typeof users.$inferInsert> = {}) {
  const digits = String(randomInt(0, 1e7)).padStart(7, '0');
  const [u] = await db
    .insert(users)
    .values({
      phone: `+92306${digits}`,
      countryCode: 'PK',
      name: 'Entrant',
      status: 'active',
      dob: '1995-01-01',
      ...extra,
    })
    .returning({ id: users.id });
  return { id: u!.id, phone: `0306 ${digits}` };
}
const make = (extra: Partial<Parameters<TournamentsService['create']>[0]> = {}) =>
  tournaments.create(
    {
      sport: 'padel',
      name: 'Test Cup',
      format: 'knockout',
      teamEntry: false,
      entryFee: 0,
      venue: 'Test Arena',
      registrationDeadline: day(10),
      startsAt: day(12),
      endsAt: day(14),
      maxEntries: 16,
      eligibility: {},
      ...extra,
    },
    admin,
    REG_OPEN,
  );
async function entrants(tournamentId: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = await person({ name: `Player ${i + 1}` });
    out.push({ user: p.id, entry: (await tournaments.enter(p.id, tournamentId, {}, REG_OPEN)).id });
  }
  return out;
}
const fixtures = (tournamentId: string) =>
  db.select().from(tournamentFixtures).where(eq(tournamentFixtures.tournamentId, tournamentId));

describe('setup and entry', () => {
  it('validates dates and fees; fees are paid directly and confirmed by an admin', async () => {
    expect(await code(make({ registrationDeadline: day(13) }))).toBe('INVALID_TOURNAMENT');
    expect(await code(make({ entryFee: 100_000 }))).toBe('INVALID_TOURNAMENT'); // no pay-to details
    const { id } = await make({ entryFee: 100_000, payTo: 'JazzCash 0300 0000000 (Test Arena)' });
    const p = await person();
    const e = await tournaments.enter(p.id, id, {}, REG_OPEN);
    expect(e.status).toBe('pending_payment');
    expect(await code(tournaments.enter(p.id, id, {}, REG_OPEN))).toBe('ALREADY_ENTERED');
    expect((await tournaments.get(p.id, id, REG_OPEN)).payTo).toContain('JazzCash');
    expect((await tournaments.get((await person()).id, id, REG_OPEN)).payTo).toBeNull(); // entrants only

    await tournaments.pay(p.id, id, e.id, { method: 'jazzcash', txnReference: 'TOURN1234' });
    const q = await person();
    const e2 = await tournaments.enter(q.id, id, {}, REG_OPEN);
    expect(await code(tournaments.pay(q.id, id, e2.id, { method: 'jazzcash', txnReference: 'TOURN1234' }))).toBe(
      'DUPLICATE_TRANSACTION',
    );
    await tournaments.decideEntry(id, e.id, true, admin);
    expect((await tournaments.get(p.id, id, REG_OPEN)).mine[0]!.status).toBe('confirmed');
    const logged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'tournament.entry_confirm'), eq(auditLog.targetId, e.id)));
    expect(logged).toHaveLength(1);
  });

  it('checks eligibility, the entry limit and the deadline', async () => {
    const { id } = await make({ maxEntries: 2, eligibility: { minAge: 18 } });
    const teen = await person({ dob: '2016-01-01' });
    expect(await code(tournaments.enter(teen.id, id, {}, REG_OPEN))).toBe('NOT_ELIGIBLE');
    await entrants(id, 2);
    expect(await code(tournaments.enter((await person()).id, id, {}, REG_OPEN))).toBe('FULL');
    expect(await code(tournaments.enter((await person()).id, id, {}, AFTER_DEADLINE))).toBe('CLOSED');
  });
});

describe('formats', () => {
  it('knockout: seeds by tournament rating with byes, winners advance, the final completes it', async () => {
    const { id } = await make();
    const five = await entrants(id, 5);
    const [padel] = await db.select({ id: sports.id }).from(sports).where(eq(sports.slug, 'padel'));
    await db.insert(ratings).values({
      userId: five[4]!.user,
      sportId: padel!.id,
      kind: 'tournament',
      rating: 1900,
      deviation: 80,
      volatility: 0.06,
    });
    expect(await code(tournaments.draw(id, admin, REG_OPEN))).toBe('NOT_READY'); // registration still open
    await tournaments.draw(id, admin, AFTER_DEADLINE);
    const page = await tournaments.get(null, id);
    expect(page.entries.find((e) => e.seed === 1)?.id).toBe(five[4]!.entry); // top rated is seed 1
    const r1 = (await fixtures(id)).filter((f) => f.round === 1);
    expect(r1).toHaveLength(4);
    expect(r1.filter((f) => f.status === 'bye')).toHaveLength(3); // 5 entrants in a bracket of 8

    const play = async () => {
      for (;;) {
        const next = (await fixtures(id)).find((f) => f.status === 'scheduled' && f.entryA && f.entryB);
        if (!next) return;
        expect(await code(tournaments.result(id, next.id, { scoreA: 1, scoreB: 1 }, admin))).toBe('INVALID_RESULT');
        await tournaments.result(id, next.id, { scoreA: 6, scoreB: 3 }, admin);
      }
    };
    await play();
    const done = await tournaments.get(null, id);
    expect(done.status).toBe('completed');
    const final = done.fixtures.filter((f) => f.stage === 'knockout').sort((a, b) => b.round - a.round)[0]!;
    expect(final.round).toBe(3);
    const rated = await db
      .select()
      .from(ratings)
      .where(and(eq(ratings.userId, five[4]!.user), eq(ratings.kind, 'tournament')));
    expect(rated[0]!.games).toBeGreaterThan(0);
  });

  it('league: everyone plays everyone twice; the table orders by points', async () => {
    const { id } = await make({ format: 'league' });
    const [a, b, c] = await entrants(id, 3);
    await tournaments.draw(id, admin, AFTER_DEADLINE);
    const all = await fixtures(id);
    expect(all).toHaveLength(6);
    for (const f of all) {
      const aWins = f.entryA === a!.entry || (f.entryB !== a!.entry && f.entryA === b!.entry);
      await tournaments.result(id, f.id, aWins ? { scoreA: 2, scoreB: 0 } : { scoreA: 0, scoreB: 2 }, admin);
    }
    const page = await tournaments.get(null, id);
    expect(page.tables[0]!.rows.map((r) => r.entryId)).toEqual([a!.entry, b!.entry, c!.entry]);
    expect(page.tables[0]!.rows[0]).toMatchObject({ played: 4, won: 4, points: 12 });
    expect(page.status).toBe('completed');
  });

  it('groups then knockout; a withdrawal gives walkovers', async () => {
    const { id } = await make({ format: 'groups_knockout', groupSize: 3 });
    const six = await entrants(id, 6);
    await tournaments.draw(id, admin, AFTER_DEADLINE);
    const groupFixtures = (await fixtures(id)).filter((f) => f.stage === 'group');
    expect(groupFixtures).toHaveLength(6); // two groups of three
    expect(await code(tournaments.startKnockout(id, admin))).toBe('NOT_READY');

    await tournaments.adminWithdraw(id, six[5]!.entry, 'Injured', admin);
    for (const f of (await fixtures(id)).filter((x) => x.status === 'scheduled'))
      await tournaments.result(id, f.id, { scoreA: 3, scoreB: 1 }, admin);
    await tournaments.startKnockout(id, admin);
    const ko = (await fixtures(id)).filter((f) => f.stage === 'knockout');
    expect(ko).toHaveLength(2); // two groups x top two = four teams
    for (const f of ko) await tournaments.result(id, f.id, { scoreA: 2, scoreB: 1 }, admin);
    const final = (await fixtures(id)).find((f) => f.stage === 'knockout' && f.round === 2)!;
    await tournaments.result(id, final.id, { scoreA: 1, scoreB: 1, winner: 'b' }, admin);
    expect((await tournaments.get(null, id)).status).toBe('completed');
  });
});

describe('team entries', () => {
  it('a captain enters the team; the roster locks when registration closes unless an admin unlocks it', async () => {
    const captain = await person();
    const { id: teamId } = await teams.create(captain.id, { sport: 'padel', name: 'Cup Team' });
    const member = await person();
    await teams.invite(captain.id, teamId, member.phone);
    await teams.respond(member.id, teamId, true);

    const now = new Date();
    const { id } = await tournaments.create(
      {
        sport: 'padel',
        name: 'Team Cup',
        format: 'knockout',
        teamEntry: true,
        entryFee: 0,
        venue: 'Test Arena',
        registrationDeadline: new Date(now.getTime() + 60_000),
        startsAt: new Date(now.getTime() + 86_400_000),
        endsAt: new Date(now.getTime() + 2 * 86_400_000),
        maxEntries: 8,
        eligibility: {},
      },
      admin,
      now,
    );
    expect(await code(tournaments.enter(member.id, id, { teamId }, now))).toBe('NOT_ELIGIBLE'); // not a leader
    expect(await code(tournaments.enter(captain.id, id, {}, now))).toBe('NOT_ELIGIBLE'); // must name the team
    const entry = await tournaments.enter(captain.id, id, { teamId }, now);

    await teams.leave(member.id, teamId).then(() => teams.invite(captain.id, teamId, member.phone));
    await teams.respond(member.id, teamId, true);
    // Registration closes: from now on the roster is locked.
    await db
      .update(tournamentsTable)
      .set({ registrationDeadline: new Date(now.getTime() - 1000) })
      .where(eq(tournamentsTable.id, id));
    expect(await code(teams.leave(member.id, teamId))).toBe('ROSTER_LOCKED');
    await tournaments.setRosterUnlocked(id, entry.id, true, admin);
    expect(await code(teams.leave(member.id, teamId))).toBe('OK');
  });
});
