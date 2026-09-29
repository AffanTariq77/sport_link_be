import { randomInt } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode } from '../db/errors.js';
import {
  countries,
  ratings,
  sports,
  teamMembers,
  teams,
  tournamentEntries,
  tournamentFixtures,
  tournaments,
  users,
  verifications,
} from '../db/schema.js';
import { eligible, type MatchFilters } from '../matches/matches.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { composite, type Glicko, rate } from '../ratings/glicko.js';
import { getSetting } from '../settings.js';
import { nextPowerOfTwo, roundRobin, seedOrder, snake, standings } from './bracket.js';

export class TournamentError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'INVALID_TOURNAMENT'
      | 'CLOSED'
      | 'FULL'
      | 'NOT_ELIGIBLE'
      | 'ALREADY_ENTERED'
      | 'NOT_PENDING'
      | 'DUPLICATE_TRANSACTION'
      | 'NOT_READY'
      | 'INVALID_RESULT',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Actor = { adminId: string; ip?: string | null };
type Format = 'knockout' | 'league' | 'round_robin' | 'groups_knockout';
type Fixture = typeof tournamentFixtures.$inferSelect;
const LIVE_ENTRY = ['pending_payment', 'submitted', 'confirmed'] as const;

/**
 * Tournaments are created and run by admins (spec 12.2): players or team captains enter and pay the fee directly
 * (SportsLink never holds money; the tournament's pay-to text says where), an admin confirms the payment, makes the
 * draw, enters results, walkovers and withdrawals. Only these official results move the tournament rating.
 */
@Injectable()
export class TournamentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  // ---------- admin: setup ----------

  async create(
    input: {
      sport: string;
      name: string;
      format: Format;
      teamEntry: boolean;
      entryFee: number;
      prize?: string;
      venue: string;
      startsAt: Date;
      endsAt: Date;
      registrationDeadline: Date;
      maxEntries: number;
      groupSize?: number;
      eligibility: MatchFilters;
      payTo?: string;
      programme?: string;
      countryCode?: string;
    },
    actor: Actor,
    now = new Date(),
  ) {
    const [sport] = await this.db.select({ id: sports.id }).from(sports).where(eq(sports.slug, input.sport));
    if (!sport) throw new TournamentError('INVALID_TOURNAMENT', 'Choose a sport from the list.');
    if (!(
      input.registrationDeadline > now &&
      input.startsAt >= input.registrationDeadline &&
      input.endsAt > input.startsAt
    ))
      throw new TournamentError(
        'INVALID_TOURNAMENT',
        'Registration must close in the future, before the start, and the end must follow the start.',
      );
    if (input.entryFee > 0 && !input.payTo?.trim())
      throw new TournamentError('INVALID_TOURNAMENT', 'Say where entrants pay the fee.');
    const [country] = await this.db
      .select({ currency: countries.currency })
      .from(countries)
      .where(eq(countries.code, input.countryCode ?? 'PK'));
    return this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tournaments)
        .values({
          sportId: sport.id,
          name: input.name.trim(),
          format: input.format,
          teamEntry: input.teamEntry,
          entryFee: input.entryFee,
          currency: country?.currency ?? 'PKR',
          prize: input.prize?.trim() || null,
          venue: input.venue.trim(),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          registrationDeadline: input.registrationDeadline,
          maxEntries: input.maxEntries,
          groupSize: input.groupSize ?? 4,
          eligibility: input.eligibility,
          payTo: input.payTo?.trim() || null,
          programme: input.programme ?? null,
          createdBy: actor.adminId,
        })
        .returning({ id: tournaments.id });
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.create',
        targetType: 'tournament',
        targetId: t!.id,
        after: { name: input.name, format: input.format, entryFee: input.entryFee },
        ip: actor.ip,
      });
      return { id: t!.id };
    });
  }

  async cancel(tournamentId: string, reason: string, actor: Actor) {
    const t = await this.tournament(tournamentId);
    if (t.status === 'completed' || t.status === 'cancelled')
      throw new TournamentError('CLOSED', 'This tournament is already finished.');
    await this.db.transaction(async (tx) => {
      await tx.update(tournaments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(tournaments.id, t.id));
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.cancel',
        targetType: 'tournament',
        targetId: t.id,
        before: { status: t.status },
        after: { reason },
        ip: actor.ip,
      });
    });
    await this.notes?.notify(await this.entrantUsers(t.id), {
      kind: 'match',
      title: 'Tournament cancelled',
      body: `${t.name} was cancelled: ${reason}. Contact support about any entry fee you paid.`,
      link: `/tournaments/${t.id}`,
      refId: t.id,
    });
    return { ok: true };
  }

  // ---------- players ----------

  list(filter: { sport?: string }) {
    return this.db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        sport: sports.name,
        format: tournaments.format,
        teamEntry: tournaments.teamEntry,
        entryFee: tournaments.entryFee,
        currency: tournaments.currency,
        venue: tournaments.venue,
        startsAt: tournaments.startsAt,
        registrationDeadline: tournaments.registrationDeadline,
        status: tournaments.status,
        programme: tournaments.programme,
      })
      .from(tournaments)
      .innerJoin(sports, eq(sports.id, tournaments.sportId))
      .where(
        and(
          notInArray(tournaments.status, ['draft', 'cancelled']),
          filter.sport ? eq(sports.slug, filter.sport) : undefined,
        ),
      )
      .orderBy(desc(tournaments.startsAt))
      .limit(50);
  }

  /** Tournament page: entrants, fixtures and tables. The viewer's own entries show their payment state. */
  async get(userId: string | null, tournamentId: string, now = new Date()) {
    const t = await this.tournament(tournamentId);
    if (t.status === 'draft' && userId) throw new TournamentError('NOT_FOUND', 'Tournament not found.');
    const entries = await this.entries(tournamentId);
    const fixtures = await this.db
      .select()
      .from(tournamentFixtures)
      .where(eq(tournamentFixtures.tournamentId, tournamentId))
      .orderBy(asc(tournamentFixtures.stage), asc(tournamentFixtures.round), asc(tournamentFixtures.slot));
    const name = (id: string | null) => (id ? (entries.find((e) => e.id === id)?.name ?? 'Entrant') : null);
    const myTeams = userId
      ? (
          await this.db
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .where(and(eq(teamMembers.userId, userId), eq(teamMembers.status, 'active')))
        ).map((m) => m.teamId)
      : [];
    const mine = entries.filter((e) => e.userId === userId || (e.teamId && myTeams.includes(e.teamId)));
    const points = {
      win: await getSetting(this.db, 'tournament.points_win'),
      draw: await getSetting(this.db, 'tournament.points_draw'),
    };
    const confirmed = entries.filter((e) => e.status === 'confirmed');
    const tables =
      t.format === 'knockout'
        ? []
        : [...new Set(fixtures.filter((f) => f.stage !== 'knockout').map((f) => f.groupNo ?? 0))].map((g) => ({
            group: g || null,
            rows: standings(
              confirmed.filter((e) => (t.format === 'groups_knockout' ? e.groupNo === g : true)).map((e) => e.id),
              fixtures.filter((f) => f.stage !== 'knockout' && (f.groupNo ?? 0) === g),
              points,
            ).map((r) => ({ ...r, name: name(r.entryId)! })),
          }));
    return {
      id: t.id,
      name: t.name,
      sport: t.sport,
      format: t.format,
      teamEntry: t.teamEntry,
      entryFee: t.entryFee,
      currency: t.currency,
      prize: t.prize,
      venue: t.venue,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      registrationDeadline: t.registrationDeadline,
      maxEntries: t.maxEntries,
      eligibility: t.eligibility as MatchFilters,
      programme: t.programme,
      status: t.status,
      payTo: mine.length ? t.payTo : null,
      feePayee: await getSetting(this.db, 'tournament.fee_payee'),
      registrationOpen: t.status === 'open' && t.registrationDeadline > now,
      entries: entries
        .filter((e) => e.status === 'confirmed' || mine.includes(e))
        .map((e) => ({ id: e.id, name: e.name, status: e.status, seed: e.seed, groupNo: e.groupNo, teamId: e.teamId })),
      mine: mine
        .filter((e) => (LIVE_ENTRY as readonly string[]).includes(e.status))
        .map((e) => ({ id: e.id, name: e.name, status: e.status, teamId: e.teamId })),
      fixtures: fixtures.map((f) => ({
        id: f.id,
        stage: f.stage,
        round: f.round,
        groupNo: f.groupNo,
        a: name(f.entryA),
        b: name(f.entryB),
        entryA: f.entryA,
        entryB: f.entryB,
        scoreA: f.scoreA,
        scoreB: f.scoreB,
        winner: name(f.winnerEntryId),
        status: f.status,
        scheduledAt: f.scheduledAt,
      })),
      tables,
    };
  }

  /** A player enters, or a captain or vice captain enters their team (spec 12.2). */
  async enter(userId: string, tournamentId: string, input: { teamId?: string }, now = new Date()) {
    const t = await this.tournament(tournamentId);
    if (t.status !== 'open' || t.registrationDeadline <= now)
      throw new TournamentError('CLOSED', 'Registration has closed.');
    const players: string[] = [];
    if (t.teamEntry) {
      if (!input.teamId) throw new TournamentError('NOT_ELIGIBLE', 'This tournament is for teams. Choose your team.');
      const [team] = await this.db
        .select({ id: teams.id, sportId: teams.sportId })
        .from(teams)
        .where(and(eq(teams.id, input.teamId), eq(teams.status, 'active')));
      const members = await this.db
        .select({ userId: teamMembers.userId, role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.status, 'active')));
      const me = members.find((m) => m.userId === userId);
      if (!team || team.sportId !== t.sportId || !me || me.role === 'member')
        throw new TournamentError('NOT_ELIGIBLE', 'Only the captain or vice captain can enter a team of this sport.');
      players.push(...members.map((m) => m.userId));
    } else {
      if (input.teamId) throw new TournamentError('NOT_ELIGIBLE', 'This tournament is for individual players.');
      players.push(userId);
    }
    for (const p of players) {
      if (!eligible(await this.viewer(p, t.sportId), t.eligibility as MatchFilters, t.startsAt, t.sportId))
        throw new TournamentError(
          'NOT_ELIGIBLE',
          t.teamEntry
            ? 'Every team member must meet the tournament rules.'
            : 'You do not meet the rules for this tournament.',
        );
    }
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the tournament row so two last entries cannot both take the final place.
        await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, t.id)).for('update');
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tournamentEntries)
          .where(
            and(eq(tournamentEntries.tournamentId, t.id), inArray(tournamentEntries.status, [...LIVE_ENTRY])),
          )) as [{ n: number }];
        if (Number(n) >= t.maxEntries) throw new TournamentError('FULL', 'This tournament is full.');
        const [e] = await tx
          .insert(tournamentEntries)
          .values({
            tournamentId: t.id,
            userId,
            teamId: input.teamId ?? null,
            status: t.entryFee > 0 ? 'pending_payment' : 'confirmed',
          })
          .returning({ id: tournamentEntries.id, status: tournamentEntries.status });
        return e!;
      });
    } catch (err) {
      if (hasPgCode(err, '23505')) throw new TournamentError('ALREADY_ENTERED', 'You have already entered.');
      throw err;
    }
  }

  /** The entrant says how they paid; an admin checks the money arrived (like booking payments). */
  async pay(
    userId: string,
    tournamentId: string,
    entryId: string,
    input: { method: 'jazzcash' | 'easypaisa' | 'bank_transfer'; txnReference: string },
  ) {
    const [e] = await this.db
      .select()
      .from(tournamentEntries)
      .where(and(eq(tournamentEntries.id, entryId), eq(tournamentEntries.tournamentId, tournamentId)));
    if (!e || e.userId !== userId) throw new TournamentError('NOT_FOUND', 'Entry not found.');
    if (e.status !== 'pending_payment' && e.status !== 'rejected')
      throw new TournamentError('NOT_PENDING', 'This entry is not waiting for payment.');
    try {
      await this.db
        .update(tournamentEntries)
        .set({
          status: 'submitted',
          method: input.method,
          txnReference: input.txnReference.trim(),
          updatedAt: new Date(),
        })
        .where(eq(tournamentEntries.id, entryId));
    } catch (err) {
      if (hasPgCode(err, '23505'))
        throw new TournamentError('DUPLICATE_TRANSACTION', 'This transaction ID was already used for an entry.');
      throw err;
    }
    return { status: 'submitted' as const };
  }

  /** Entrants can withdraw until registration closes; after that, only an admin can (as a walkover). */
  async withdraw(userId: string, tournamentId: string, entryId: string, now = new Date()) {
    const t = await this.tournament(tournamentId);
    const [e] = await this.db
      .select()
      .from(tournamentEntries)
      .where(and(eq(tournamentEntries.id, entryId), eq(tournamentEntries.tournamentId, tournamentId)));
    if (!e || e.userId !== userId || !(LIVE_ENTRY as readonly string[]).includes(e.status))
      throw new TournamentError('NOT_FOUND', 'Entry not found.');
    if (t.registrationDeadline <= now || t.status !== 'open')
      throw new TournamentError('CLOSED', 'Registration has closed. Ask SportsLink support to withdraw.');
    await this.db
      .update(tournamentEntries)
      .set({ status: 'withdrawn', updatedAt: now })
      .where(eq(tournamentEntries.id, entryId));
    return { ok: true };
  }

  // ---------- admin: running it ----------

  async adminEntries(tournamentId: string) {
    return (await this.entries(tournamentId)).map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status,
      method: e.method,
      txnReference: e.txnReference,
      seed: e.seed,
      rosterUnlocked: e.rosterUnlocked,
    }));
  }

  async decideEntry(tournamentId: string, entryId: string, confirm: boolean, actor: Actor) {
    const e = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(tournamentEntries)
        .where(and(eq(tournamentEntries.id, entryId), eq(tournamentEntries.tournamentId, tournamentId)))
        .for('update');
      if (!row || row.status !== 'submitted') throw new TournamentError('NOT_PENDING', 'This entry is not waiting.');
      const status = confirm ? ('confirmed' as const) : ('rejected' as const);
      await tx
        .update(tournamentEntries)
        .set({ status, updatedAt: new Date() })
        .where(eq(tournamentEntries.id, entryId));
      await audit(tx, {
        actorId: actor.adminId,
        action: confirm ? 'tournament.entry_confirm' : 'tournament.entry_reject',
        targetType: 'tournament_entry',
        targetId: entryId,
        before: { status: row.status },
        after: { status, txnReference: row.txnReference },
        ip: actor.ip,
      });
      return row;
    });
    const t = await this.tournament(tournamentId);
    await this.notes?.notify(e.userId, {
      kind: 'payment',
      title: confirm ? 'Entry confirmed' : 'Entry payment not found',
      body: confirm
        ? `You are in ${t.name}.`
        : `We could not find your payment for ${t.name}. Check the transaction ID and send it again.`,
      link: `/tournaments/${tournamentId}`,
      refId: tournamentId,
    });
    return { ok: true };
  }

  /** Admin approves roster changes for a team after registration closed (spec 12.1). */
  async setRosterUnlocked(tournamentId: string, entryId: string, unlocked: boolean, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tournamentEntries)
        .set({ rosterUnlocked: unlocked, updatedAt: new Date() })
        .where(and(eq(tournamentEntries.id, entryId), eq(tournamentEntries.tournamentId, tournamentId)))
        .returning({ id: tournamentEntries.id });
      if (!row) throw new TournamentError('NOT_FOUND', 'Entry not found.');
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.roster_unlock',
        targetType: 'tournament_entry',
        targetId: entryId,
        after: { unlocked },
        ip: actor.ip,
      });
    });
    return { ok: true };
  }

  /**
   * The draw (spec 12.2): seeded by tournament rating, unrated entrants in random order after the rated ones.
   * Knockouts get byes up to a power of two; leagues play everyone twice, round robins once; groups are dealt in a
   * snake and play a round robin, then the top of each group go into a knockout.
   */
  async draw(tournamentId: string, actor: Actor, now = new Date()) {
    const t = await this.tournament(tournamentId);
    if (!['open', 'closed'].includes(t.status) || t.registrationDeadline > now)
      throw new TournamentError('NOT_READY', 'Make the draw after registration closes.');
    const confirmed = (await this.entries(tournamentId)).filter((e) => e.status === 'confirmed');
    if (confirmed.length < 2) throw new TournamentError('NOT_READY', 'At least two confirmed entries are needed.');
    const seeded = await this.seed(t.sportId, confirmed);
    await this.db.transaction(async (tx) => {
      for (const [i, e] of seeded.entries())
        await tx
          .update(tournamentEntries)
          .set({ seed: i + 1 })
          .where(eq(tournamentEntries.id, e.id));
      const ids = seeded.map((e) => e.id);
      if (t.format === 'knockout') await this.knockout(tx, t.id, ids, 1);
      else if (t.format === 'groups_knockout') {
        const groups = snake(ids, Math.max(1, Math.ceil(ids.length / t.groupSize)));
        for (const [g, members] of groups.entries()) {
          await tx
            .update(tournamentEntries)
            .set({ groupNo: g + 1 })
            .where(inArray(tournamentEntries.id, members));
          await this.insertRoundRobin(tx, t.id, members, 'group', g + 1, false);
        }
      } else await this.insertRoundRobin(tx, t.id, ids, 'league', null, t.format === 'league');
      await tx.update(tournaments).set({ status: 'in_progress', updatedAt: now }).where(eq(tournaments.id, t.id));
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.draw',
        targetType: 'tournament',
        targetId: t.id,
        after: { seeds: ids },
        ip: actor.ip,
      });
    });
    await this.notes?.notify(await this.entrantUsers(t.id), {
      kind: 'match',
      title: 'The draw is out',
      body: `Fixtures for ${t.name} are ready.`,
      link: `/tournaments/${t.id}`,
      refId: t.id,
    });
    return { ok: true, entries: seeded.length };
  }

  /** Groups finished: the top of each table go into a knockout, group winners seeded first. */
  async startKnockout(tournamentId: string, actor: Actor) {
    const t = await this.tournament(tournamentId);
    if (t.format !== 'groups_knockout' || t.status !== 'in_progress')
      throw new TournamentError('NOT_READY', 'Only a groups-then-knockout tournament in progress has this step.');
    const fixtures = await this.fixtures(t.id);
    if (fixtures.some((f) => f.stage === 'knockout'))
      throw new TournamentError('NOT_READY', 'The knockout has started.');
    if (fixtures.some((f) => f.status === 'scheduled'))
      throw new TournamentError('NOT_READY', 'Enter every group result first.');
    const confirmed = (await this.entries(t.id)).filter((e) => e.status === 'confirmed');
    const advance = await getSetting(this.db, 'tournament.group_advance');
    const points = {
      win: await getSetting(this.db, 'tournament.points_win'),
      draw: await getSetting(this.db, 'tournament.points_draw'),
    };
    const groups = [...new Set(confirmed.map((e) => e.groupNo!))].sort((a, b) => a - b);
    const tables = groups.map((g) =>
      standings(
        confirmed.filter((e) => e.groupNo === g).map((e) => e.id),
        fixtures.filter((f) => f.groupNo === g),
        points,
      ),
    );
    // Winners in group order, then runners-up in reverse, so teams from one group meet as late as possible.
    const seeds: string[] = [];
    for (let place = 0; place < advance; place++) {
      const row = tables.map((table) => table[place]?.entryId).filter((x): x is string => !!x);
      seeds.push(...(place % 2 ? row.reverse() : row));
    }
    await this.db.transaction(async (tx) => {
      await this.knockout(tx, t.id, seeds, 1);
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.knockout',
        targetType: 'tournament',
        targetId: t.id,
        after: { seeds },
        ip: actor.ip,
      });
    });
    return { ok: true };
  }

  /**
   * Admin enters an official result (spec 12.2). A knockout needs a winner even on a level score (for example on
   * penalties). A walkover names the winner. Only played results move tournament ratings.
   */
  async result(
    tournamentId: string,
    fixtureId: string,
    input: { scoreA?: number; scoreB?: number; winner?: 'a' | 'b'; walkover?: boolean },
    actor: Actor,
    now = new Date(),
  ) {
    const t = await this.tournament(tournamentId);
    if (t.status !== 'in_progress') throw new TournamentError('NOT_READY', 'The tournament is not in progress.');
    await this.db.transaction(async (tx) => {
      const [f] = await tx
        .select()
        .from(tournamentFixtures)
        .where(and(eq(tournamentFixtures.id, fixtureId), eq(tournamentFixtures.tournamentId, tournamentId)))
        .for('update');
      if (!f || !f.entryA || !f.entryB) throw new TournamentError('NOT_FOUND', 'Fixture not found.');
      if (f.status !== 'scheduled') throw new TournamentError('INVALID_RESULT', 'This fixture already has a result.');
      let winner: string | null;
      if (input.walkover) {
        if (!input.winner) throw new TournamentError('INVALID_RESULT', 'Say who gets the walkover.');
        winner = input.winner === 'a' ? f.entryA : f.entryB;
      } else {
        if (input.scoreA === undefined || input.scoreB === undefined)
          throw new TournamentError('INVALID_RESULT', 'Enter both scores.');
        winner =
          input.scoreA > input.scoreB
            ? f.entryA
            : input.scoreB > input.scoreA
              ? f.entryB
              : input.winner
                ? input.winner === 'a'
                  ? f.entryA
                  : f.entryB
                : null;
        if (!winner && f.stage === 'knockout')
          throw new TournamentError('INVALID_RESULT', 'A knockout needs a winner. Say who went through.');
      }
      await tx
        .update(tournamentFixtures)
        .set({
          status: input.walkover ? 'walkover' : 'completed',
          scoreA: input.walkover ? null : input.scoreA!,
          scoreB: input.walkover ? null : input.scoreB!,
          winnerEntryId: winner,
          updatedAt: now,
        })
        .where(eq(tournamentFixtures.id, f.id));
      if (!input.walkover) await this.rate(tx, t.sportId, f, winner, now);
      if (f.stage === 'knockout' && winner) await this.advance(tx, t.id, f, winner);
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.result',
        targetType: 'tournament_fixture',
        targetId: f.id,
        after: input,
        ip: actor.ip,
      });
      await this.finishIfDone(tx, t.id, t.format, now);
    });
    return { ok: true };
  }

  /** Admin withdraws an entry after the draw: its remaining fixtures become walkovers for the opponents. */
  async adminWithdraw(tournamentId: string, entryId: string, reason: string, actor: Actor, now = new Date()) {
    const t = await this.tournament(tournamentId);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tournamentEntries)
        .set({ status: 'withdrawn', updatedAt: now })
        .where(and(eq(tournamentEntries.id, entryId), eq(tournamentEntries.tournamentId, tournamentId)))
        .returning({ id: tournamentEntries.id });
      if (!row) throw new TournamentError('NOT_FOUND', 'Entry not found.');
      const open = (await this.fixtures(t.id, tx)).filter(
        (f) => f.status === 'scheduled' && (f.entryA === entryId || f.entryB === entryId) && f.entryA && f.entryB,
      );
      for (const f of open) {
        const winner = f.entryA === entryId ? f.entryB! : f.entryA!;
        await tx
          .update(tournamentFixtures)
          .set({ status: 'walkover', winnerEntryId: winner, updatedAt: now })
          .where(eq(tournamentFixtures.id, f.id));
        if (f.stage === 'knockout') await this.advance(tx, t.id, f, winner);
      }
      await audit(tx, {
        actorId: actor.adminId,
        action: 'tournament.withdraw',
        targetType: 'tournament_entry',
        targetId: entryId,
        after: { reason, walkovers: open.length },
        ip: actor.ip,
      });
      if (t.status === 'in_progress') await this.finishIfDone(tx, t.id, t.format, now);
    });
    return { ok: true };
  }

  /** Job: registration closes at the deadline. */
  async closeRegistrations(now = new Date()) {
    const closed = await this.db
      .update(tournaments)
      .set({ status: 'closed', updatedAt: now })
      .where(and(eq(tournaments.status, 'open'), lt(tournaments.registrationDeadline, now)))
      .returning({ id: tournaments.id });
    return { tournamentsClosed: closed.length };
  }

  // ---------- helpers ----------

  private async knockout(tx: Tx, tournamentId: string, seeded: string[], round: number) {
    const size = nextPowerOfTwo(seeded.length);
    const order = seedOrder(size);
    const byes: { f: Fixture; winner: string }[] = [];
    // Insert the whole round first, so the round size is known before byes advance.
    for (let slot = 0; slot < size / 2; slot++) {
      const a = seeded[order[slot * 2]! - 1] ?? null;
      const b = seeded[order[slot * 2 + 1]! - 1] ?? null;
      const bye = !a || !b;
      const [f] = await tx
        .insert(tournamentFixtures)
        .values({
          tournamentId,
          stage: 'knockout',
          round,
          slot,
          entryA: a,
          entryB: b,
          status: bye ? 'bye' : 'scheduled',
          winnerEntryId: bye ? (a ?? b) : null,
        })
        .returning();
      if (bye && (a ?? b)) byes.push({ f: f!, winner: (a ?? b)! });
    }
    for (const { f, winner } of byes) await this.advance(tx, tournamentId, f, winner);
  }

  /** Winner goes to the next round: slot k feeds slot k / 2, as side A from an even slot. */
  private async advance(tx: Tx, tournamentId: string, f: Fixture, winner: string) {
    if ((await this.fixturesInRound(tx, tournamentId, f.round)) <= 1) return; // that was the final
    const slot = Math.floor(f.slot / 2);
    const side = f.slot % 2 === 0 ? { entryA: winner } : { entryB: winner };
    const [next] = await tx
      .select()
      .from(tournamentFixtures)
      .where(
        and(
          eq(tournamentFixtures.tournamentId, tournamentId),
          eq(tournamentFixtures.stage, 'knockout'),
          eq(tournamentFixtures.round, f.round + 1),
          eq(tournamentFixtures.slot, slot),
        ),
      );
    if (next) await tx.update(tournamentFixtures).set(side).where(eq(tournamentFixtures.id, next.id));
    else
      await tx
        .insert(tournamentFixtures)
        .values({ tournamentId, stage: 'knockout', round: f.round + 1, slot, ...side });
  }

  /** Knockout rounds halve: round r has (round 1 fixtures) / 2^(r-1), even before later rounds are created. */
  private async fixturesInRound(tx: Pick<Db, 'select'>, tournamentId: string, round: number) {
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tournamentFixtures)
      .where(
        and(
          eq(tournamentFixtures.tournamentId, tournamentId),
          eq(tournamentFixtures.stage, 'knockout'),
          eq(tournamentFixtures.round, 1),
        ),
      )) as [{ n: number }];
    return Number(n) / 2 ** (round - 1);
  }

  private async insertRoundRobin(
    tx: Tx,
    tournamentId: string,
    ids: string[],
    stage: 'league' | 'group',
    groupNo: number | null,
    twice: boolean,
  ) {
    const first = roundRobin(ids);
    const rounds = twice
      ? [...first, ...first.map((r) => r.map(([a, b]) => [b, a] as [string | null, string | null]))]
      : first;
    for (const [r, pairs] of rounds.entries()) {
      let slot = 0;
      for (const [a, b] of pairs) {
        if (!a || !b) continue; // odd count: this entrant rests
        await tx
          .insert(tournamentFixtures)
          .values({ tournamentId, stage, round: r + 1, slot: slot++, groupNo, entryA: a, entryB: b });
      }
    }
  }

  private async finishIfDone(tx: Tx, tournamentId: string, format: Format, now: Date) {
    const all = await this.fixtures(tournamentId, tx);
    if (all.some((f) => f.status === 'scheduled')) return;
    if (format === 'groups_knockout' && !all.some((f) => f.stage === 'knockout')) return; // groups done, knockout next
    const ko = all.filter((f) => f.stage === 'knockout');
    if (ko.length) {
      const last = Math.max(...ko.map((f) => f.round));
      if ((await this.fixturesInRound(tx, tournamentId, last)) !== 1) return; // later rounds not created yet
    }
    await tx.update(tournaments).set({ status: 'completed', updatedAt: now }).where(eq(tournaments.id, tournamentId));
  }

  /** Tournament rating, a separate Glicko-2 `kind` (spec 11): each player against the other side's composite. */
  private async rate(tx: Tx, sportId: string, f: Fixture, winner: string | null, now: Date) {
    const sides = await Promise.all([f.entryA!, f.entryB!].map((id) => this.players(tx, id)));
    const cfg = {
      start: await getSetting(tx, 'rating.start'),
      deviation: await getSetting(tx, 'rating.start_deviation'),
      volatility: await getSetting(tx, 'rating.start_volatility'),
      tau: await getSetting(tx, 'rating.tau'),
    };
    const everyone = sides.flat();
    if (!everyone.length) return;
    await tx
      .insert(ratings)
      .values(
        everyone.map((userId) => ({
          userId,
          sportId,
          kind: 'tournament' as const,
          rating: cfg.start,
          deviation: cfg.deviation,
          volatility: cfg.volatility,
        })),
      )
      .onConflictDoNothing();
    const rows = await tx
      .select()
      .from(ratings)
      .where(and(eq(ratings.sportId, sportId), eq(ratings.kind, 'tournament'), inArray(ratings.userId, everyone)))
      .for('update');
    const g = (id: string): Glicko => rows.find((r) => r.userId === id)!;
    const comp = sides.map((s) => composite(s.map(g)));
    for (const [i, side] of sides.entries()) {
      const score = winner === null ? 0.5 : winner === (i === 0 ? f.entryA : f.entryB) ? 1 : 0;
      for (const userId of side) {
        const next = rate(g(userId), comp[1 - i]!, score, cfg.tau);
        await tx
          .update(ratings)
          .set({ ...next, games: sql`${ratings.games} + 1`, lastPlayedAt: now, updatedAt: now })
          .where(and(eq(ratings.userId, userId), eq(ratings.sportId, sportId), eq(ratings.kind, 'tournament')));
      }
    }
    await tx.update(tournamentFixtures).set({ ratedAt: now }).where(eq(tournamentFixtures.id, f.id));
  }

  /** The players an entry stands for: the player, or the team's active members. */
  private async players(tx: Pick<Db, 'select'>, entryId: string) {
    const [e] = await tx.select().from(tournamentEntries).where(eq(tournamentEntries.id, entryId));
    if (!e?.teamId) return e ? [e.userId] : [];
    const members = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.status, 'active')));
    return members.map((m) => m.userId);
  }

  /** Rated entrants by tournament rating, then unrated in random order (spec 12.2). */
  private async seed<T extends { id: string; userId: string; teamId: string | null }>(sportId: string, entries: T[]) {
    const scored = await Promise.all(
      entries.map(async (e) => {
        const people = await this.players(this.db, e.id);
        const rows = people.length
          ? await this.db
              .select({ rating: ratings.rating })
              .from(ratings)
              .where(and(eq(ratings.sportId, sportId), eq(ratings.kind, 'tournament'), inArray(ratings.userId, people)))
          : [];
        return {
          e,
          rating: rows.length ? rows.reduce((s, r) => s + r.rating, 0) / rows.length : null,
          tie: randomInt(1e9),
        };
      }),
    );
    return scored
      .sort((a, b) =>
        a.rating !== null && b.rating !== null
          ? b.rating - a.rating
          : a.rating !== null
            ? -1
            : b.rating !== null
              ? 1
              : a.tie - b.tie,
      )
      .map((s) => s.e);
  }

  private async viewer(userId: string, sportId: string) {
    const [u] = await this.db.select({ dob: users.dob, gender: users.gender }).from(users).where(eq(users.id, userId));
    const [v] = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.userId, userId), eq(verifications.status, 'approved')))
      .limit(1);
    const [r] = await this.db
      .select({ rating: ratings.rating })
      .from(ratings)
      .where(and(eq(ratings.userId, userId), eq(ratings.sportId, sportId), eq(ratings.kind, 'skill')));
    return {
      id: userId,
      dob: u?.dob ?? null,
      gender: u?.gender ?? null,
      verified: !!v,
      ratings: new Map(r ? [[sportId, r.rating]] : []),
      startRating: await getSetting(this.db, 'rating.start'),
    };
  }

  private async tournament(tournamentId: string) {
    const [t] = await this.db
      .select({ t: tournaments, sport: sports.name })
      .from(tournaments)
      .innerJoin(sports, eq(sports.id, tournaments.sportId))
      .where(eq(tournaments.id, tournamentId));
    if (!t) throw new TournamentError('NOT_FOUND', 'Tournament not found.');
    return { ...t.t, sport: t.sport };
  }

  private async entries(tournamentId: string) {
    const rows = await this.db
      .select({ e: tournamentEntries, player: users.name, team: teams.name })
      .from(tournamentEntries)
      .innerJoin(users, eq(users.id, tournamentEntries.userId))
      .leftJoin(teams, eq(teams.id, tournamentEntries.teamId))
      .where(eq(tournamentEntries.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntries.seed), asc(tournamentEntries.createdAt));
    return rows.map((r) => ({ ...r.e, name: r.team ?? r.player ?? 'Player' }));
  }

  private fixtures(tournamentId: string, tx: Pick<Db, 'select'> = this.db) {
    return tx.select().from(tournamentFixtures).where(eq(tournamentFixtures.tournamentId, tournamentId));
  }

  private async entrantUsers(tournamentId: string) {
    const rows = await this.db
      .select({ userId: tournamentEntries.userId })
      .from(tournamentEntries)
      .where(and(eq(tournamentEntries.tournamentId, tournamentId), ne(tournamentEntries.status, 'withdrawn')));
    return rows.map((r) => r.userId);
  }
}
