import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, arrayOverlaps, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode } from '../db/errors.js';
import {
  matches,
  matchPlayers,
  matchResults,
  ratingChanges,
  ratings,
  reports,
  reviews,
  teamMembers,
  teamRatings,
  users,
} from '../db/schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { getSetting } from '../settings.js';
import { composite, type Glicko, idle, rate } from './glicko.js';

export class ResultError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_FINISHED'
      | 'INVALID_SIDES'
      | 'ALREADY_SUBMITTED'
      | 'NOT_PENDING'
      | 'NOT_OTHER_SIDE'
      | 'NOTE_REQUIRED'
      | 'REVIEW_CLOSED'
      | 'ALREADY_REVIEWED'
      | 'INVALID_REVIEW',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Outcome = 'a' | 'b' | 'draw';
type Actor = { adminId: string; ip?: string | null };
type Snapshot = Glicko & { games: number; lastPlayedAt: string | null };

/**
 * Results, Glicko-2 ratings and behaviour reviews (spec 11). A result is submitted by one side, confirmed or disputed
 * by the other within `result.confirm_hours`; ratings change only once it is confirmed (by the other side, by
 * silence if `result.silence_confirms`, or by an admin deciding a dispute).
 */
@Injectable()
export class ResultsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  /** Everything the match page needs: who played, the live result and whom the user can still review. */
  async state(userId: string, matchId: string, now = new Date()) {
    const m = await this.match(matchId);
    const players = await this.participants(matchId, m.hostId);
    if (!players.some((p) => p.id === userId)) throw new ResultError('NOT_FOUND', 'Match not found.');
    const [r] = await this.db
      .select()
      .from(matchResults)
      .where(and(eq(matchResults.matchId, matchId), ne(matchResults.status, 'voided')));
    const given = await this.db
      .select({ to: reviews.toUserId })
      .from(reviews)
      .where(and(eq(reviews.matchId, matchId), eq(reviews.fromUserId, userId)));
    const reviewWindow = await getSetting(this.db, 'review.window_hours');
    const reviewOpen = m.endAt <= now && now.getTime() <= m.endAt.getTime() + reviewWindow * 3_600_000;
    const mySide = r ? (r.sideA.includes(userId) ? 'a' : 'b') : null;
    const submitterSide = r ? (r.sideA.includes(r.submittedBy) ? 'a' : 'b') : null;
    return {
      finished: m.endAt <= now,
      participants: players,
      result: r
        ? {
            id: r.id,
            sideA: r.sideA,
            sideB: r.sideB,
            outcome: r.outcome,
            score: r.score,
            status: r.status,
            confirmBy: r.confirmBy,
            submittedBy: r.submittedBy,
          }
        : null,
      canSubmit: !r && m.endAt <= now && m.status !== 'cancelled' && players.length >= 2,
      canRespond: !!r && r.status === 'pending' && mySide !== submitterSide && now <= r.confirmBy,
      reviewTags: await getSetting(this.db, 'review.tags'),
      reviewable:
        reviewOpen && m.status !== 'cancelled'
          ? players.filter((p) => p.id !== userId).map((p) => ({ ...p, reviewed: given.some((g) => g.to === p.id) }))
          : [],
    };
  }

  async submit(
    userId: string,
    matchId: string,
    input: { sideA: string[]; sideB: string[]; outcome: Outcome; score?: string },
    now = new Date(),
  ) {
    const m = await this.match(matchId);
    const players = (await this.participants(matchId, m.hostId)).map((p) => p.id);
    if (!players.includes(userId)) throw new ResultError('NOT_FOUND', 'Match not found.');
    if (m.status === 'cancelled' || m.endAt > now) {
      throw new ResultError('NOT_FINISHED', 'You can add the result once the match has finished.');
    }
    const all = [...input.sideA, ...input.sideB];
    if (
      !input.sideA.length ||
      !input.sideB.length ||
      new Set(all).size !== all.length ||
      all.length !== players.length ||
      !all.every((id) => players.includes(id))
    ) {
      throw new ResultError('INVALID_SIDES', 'Put every player on one side, with at least one player on each side.');
    }
    if (m.homeTeamId) {
      // Team match: side A is the home team, side B the away team (spec 12.1).
      if (!m.awayTeamId) throw new ResultError('NOT_FINISHED', 'No team accepted this challenge.');
      const members = await this.db
        .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(inArray(teamMembers.teamId, [m.homeTeamId, m.awayTeamId]), eq(teamMembers.status, 'active')));
      const on = (teamId: string) => (id: string) => members.some((x) => x.userId === id && x.teamId === teamId);
      if (!input.sideA.every(on(m.homeTeamId)) || !input.sideB.every(on(m.awayTeamId)))
        throw new ResultError('INVALID_SIDES', 'Side A is the home team and side B the away team.');
    }
    const hours = await getSetting(this.db, 'result.confirm_hours');
    const confirmBy = new Date(now.getTime() + hours * 3_600_000);
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(matchResults).values({
          matchId,
          submittedBy: userId,
          sideA: input.sideA,
          sideB: input.sideB,
          outcome: input.outcome,
          score: input.score?.trim() || null,
          confirmBy,
        });
        await tx.update(matches).set({ status: 'result_pending', updatedAt: now }).where(eq(matches.id, matchId));
      });
    } catch (err) {
      if (hasPgCode(err, '23505')) throw new ResultError('ALREADY_SUBMITTED', 'The result has already been added.');
      throw err;
    }
    const other = input.sideA.includes(userId) ? input.sideB : input.sideA;
    await this.notes?.notify(other, {
      kind: 'match',
      title: 'Confirm the result',
      body: 'A result was added for your match. Confirm it or dispute it.',
      link: `/matches/${matchId}`,
      refId: matchId,
    });
    return { status: 'pending' as const, confirmBy };
  }

  /** The other side agrees (ratings update) or disputes with a note (admin decides, spec 11.1). */
  async respond(userId: string, matchId: string, input: { agree: boolean; note?: string }, now = new Date()) {
    const r = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(matchResults)
        .where(and(eq(matchResults.matchId, matchId), ne(matchResults.status, 'voided')))
        .for('update');
      if (!row || ![...row.sideA, ...row.sideB].includes(userId))
        throw new ResultError('NOT_FOUND', 'Result not found.');
      if (row.status !== 'pending' || now > row.confirmBy)
        throw new ResultError('NOT_PENDING', 'This result is no longer waiting for you.');
      const submitterSide = row.sideA.includes(row.submittedBy) ? row.sideA : row.sideB;
      if (submitterSide.includes(userId))
        throw new ResultError('NOT_OTHER_SIDE', 'The other side confirms the result.');
      if (input.agree) {
        await tx
          .update(matchResults)
          .set({ status: 'confirmed', respondedBy: userId, updatedAt: now })
          .where(eq(matchResults.id, row.id));
        await this.applyRatings(tx, row.id, now);
        return { ...row, status: 'confirmed' as const };
      }
      const note = input.note?.trim();
      if (!note) throw new ResultError('NOTE_REQUIRED', 'Say what the result should be.');
      await tx
        .update(matchResults)
        .set({ status: 'disputed', respondedBy: userId, disputeNote: note, updatedAt: now })
        .where(eq(matchResults.id, row.id));
      await tx.update(matches).set({ status: 'disputed', updatedAt: now }).where(eq(matches.id, matchId));
      await tx.insert(reports).values({
        reporterId: userId,
        targetType: 'match',
        targetId: matchId,
        reason: 'result_dispute',
        details: note,
        evidence: { resultId: row.id, outcome: row.outcome, score: row.score },
      });
      return { ...row, status: 'disputed' as const };
    });
    await this.notes?.notify([...r.sideA, ...r.sideB], {
      kind: 'match',
      title: r.status === 'confirmed' ? 'Result confirmed' : 'Result disputed',
      body:
        r.status === 'confirmed'
          ? 'The result is confirmed and ratings are updated.'
          : 'The result was disputed. SportsLink will review it and decide.',
      link: `/matches/${matchId}`,
      refId: matchId,
    });
    return { status: r.status };
  }

  /** Job: results nobody answered in time are confirmed (or dropped, per the OPEN setting). */
  async finaliseExpired(now = new Date()) {
    const due = await this.db
      .select({ id: matchResults.id, matchId: matchResults.matchId })
      .from(matchResults)
      .where(and(eq(matchResults.status, 'pending'), lt(matchResults.confirmBy, now)));
    const confirm = await getSetting(this.db, 'result.silence_confirms');
    for (const r of due) {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: matchResults.status })
          .from(matchResults)
          .where(eq(matchResults.id, r.id))
          .for('update');
        if (row?.status !== 'pending') return;
        await tx
          .update(matchResults)
          .set({ status: confirm ? 'confirmed' : 'voided', updatedAt: now })
          .where(eq(matchResults.id, r.id));
        if (confirm) await this.applyRatings(tx, r.id, now);
        else await tx.update(matches).set({ status: 'completed', updatedAt: now }).where(eq(matches.id, r.matchId));
      });
    }
    return { finalised: due.length };
  }

  // ---------- admin ----------

  async listDisputed() {
    const rows = await this.db
      .select({
        id: matchResults.id,
        matchId: matchResults.matchId,
        sideA: matchResults.sideA,
        sideB: matchResults.sideB,
        outcome: matchResults.outcome,
        score: matchResults.score,
        disputeNote: matchResults.disputeNote,
        submittedBy: matchResults.submittedBy,
        startAt: matches.startAt,
        createdAt: matchResults.createdAt,
      })
      .from(matchResults)
      .innerJoin(matches, eq(matches.id, matchResults.matchId))
      .where(eq(matchResults.status, 'disputed'))
      .orderBy(matchResults.createdAt)
      .limit(100);
    const ids = [...new Set(rows.flatMap((r) => [...r.sideA, ...r.sideB]))];
    const names = ids.length
      ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? 'Player';
    return rows.map((r) => ({ ...r, sideANames: r.sideA.map(name), sideBNames: r.sideB.map(name) }));
  }

  /** Decide a dispute (final, logged) or void a result; voiding a rated result puts the ratings back. */
  async decide(resultId: string, input: { outcome: Outcome | 'void'; note: string }, actor: Actor, now = new Date()) {
    const r = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(matchResults).where(eq(matchResults.id, resultId)).for('update');
      if (!row) throw new ResultError('NOT_FOUND', 'Result not found.');
      if (row.status === 'voided') throw new ResultError('NOT_PENDING', 'This result is already void.');
      if (input.outcome !== 'void' && row.status !== 'disputed')
        throw new ResultError('NOT_PENDING', 'Only disputed results can be decided.');
      if (input.outcome === 'void') {
        if (row.ratedAt) await this.revertRatings(tx, row.id);
        await tx
          .update(matchResults)
          .set({ status: 'voided', decidedBy: actor.adminId, updatedAt: now })
          .where(eq(matchResults.id, row.id));
        await tx.update(matches).set({ status: 'completed', updatedAt: now }).where(eq(matches.id, row.matchId));
      } else {
        await tx
          .update(matchResults)
          .set({ status: 'confirmed', outcome: input.outcome, decidedBy: actor.adminId, updatedAt: now })
          .where(eq(matchResults.id, row.id));
        await this.applyRatings(tx, row.id, now);
      }
      await audit(tx, {
        actorId: actor.adminId,
        action: input.outcome === 'void' ? 'result.void' : 'result.decide',
        targetType: 'match_result',
        targetId: row.id,
        before: { status: row.status, outcome: row.outcome },
        after: { outcome: input.outcome, note: input.note },
        ip: actor.ip,
      });
      return row;
    });
    await this.notes?.notify([...r.sideA, ...r.sideB], {
      kind: 'match',
      title: input.outcome === 'void' ? 'Result voided' : 'Dispute decided',
      body: `${input.note} This decision is final.`,
      link: `/matches/${r.matchId}`,
      refId: r.matchId,
    });
    return { id: resultId, status: input.outcome === 'void' ? ('voided' as const) : ('confirmed' as const) };
  }

  // ---------- reviews ----------

  async review(
    userId: string,
    matchId: string,
    input: { toUserId: string; stars: number; tags: string[]; comment?: string },
    now = new Date(),
  ) {
    const m = await this.match(matchId);
    const players = (await this.participants(matchId, m.hostId)).map((p) => p.id);
    if (!players.includes(userId)) throw new ResultError('NOT_FOUND', 'Match not found.');
    if (input.toUserId === userId || !players.includes(input.toUserId))
      throw new ResultError('INVALID_REVIEW', 'You can only review players from this match.');
    const hours = await getSetting(this.db, 'review.window_hours');
    if (m.status === 'cancelled' || m.endAt > now || now.getTime() > m.endAt.getTime() + hours * 3_600_000)
      throw new ResultError('REVIEW_CLOSED', `Reviews are open for ${hours} hours after the match.`);
    const allowed = await getSetting(this.db, 'review.tags');
    if (!input.tags.every((t) => allowed.includes(t))) throw new ResultError('INVALID_REVIEW', 'Unknown tag.');
    try {
      await this.db.insert(reviews).values({
        matchId,
        fromUserId: userId,
        toUserId: input.toUserId,
        stars: input.stars,
        tags: [...new Set(input.tags)],
        comment: input.comment?.trim() || null,
      });
    } catch (err) {
      if (hasPgCode(err, '23505')) throw new ResultError('ALREADY_REVIEWED', 'You have already reviewed this player.');
      throw err;
    }
    return { ok: true };
  }

  // ---------- ratings ----------

  /** Glicko-2, one game per rating period, each player against the other side's composite (spec 11.2, 11.3). */
  private async applyRatings(tx: Tx, resultId: string, now: Date) {
    const [r] = await tx
      .select({
        result: matchResults,
        sportId: matches.sportId,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
      })
      .from(matchResults)
      .innerJoin(matches, eq(matches.id, matchResults.matchId))
      .where(eq(matchResults.id, resultId));
    if (!r || r.result.ratedAt) return;
    const { sideA, sideB, outcome, matchId } = r.result;
    const cfg = {
      start: await getSetting(tx, 'rating.start'),
      deviation: await getSetting(tx, 'rating.start_deviation'),
      volatility: await getSetting(tx, 'rating.start_volatility'),
      tau: await getSetting(tx, 'rating.tau'),
      periodDays: await getSetting(tx, 'rating.inactivity_period_days'),
      repeatGames: await getSetting(tx, 'rating.repeat_opponent_games'),
      repeatDays: await getSetting(tx, 'rating.repeat_opponent_days'),
      repeatFactor: await getSetting(tx, 'rating.repeat_opponent_factor'),
    };
    const everyone = [...sideA, ...sideB];
    await tx
      .insert(ratings)
      .values(
        everyone.map((userId) => ({
          userId,
          sportId: r.sportId,
          rating: cfg.start,
          deviation: cfg.deviation,
          volatility: cfg.volatility,
        })),
      )
      .onConflictDoNothing();
    const rows = await tx
      .select()
      .from(ratings)
      .where(and(eq(ratings.sportId, r.sportId), eq(ratings.kind, 'skill'), inArray(ratings.userId, everyone)))
      .for('update');
    const periodMs = cfg.periodDays * 86_400_000;
    const current = new Map(
      rows.map((row) => {
        const idlePeriods = row.lastPlayedAt ? Math.floor((now.getTime() - row.lastPlayedAt.getTime()) / periodMs) : 0;
        return [row.userId, { row, pre: idle(row, idlePeriods, cfg.deviation) }];
      }),
    );
    const side = (ids: string[]) => composite(ids.map((id) => current.get(id)!.pre));
    const [compA, compB] = [side(sideA), side(sideB)];
    const since = new Date(now.getTime() - cfg.repeatDays * 86_400_000);

    for (const userId of everyone) {
      const onA = sideA.includes(userId);
      const opponents = onA ? sideB : sideA;
      const score = outcome === 'draw' ? 0.5 : (outcome === 'a') === onA ? 1 : 0;
      // Anti-abuse (spec 11.4): rated games in the window with any of these opponents on the other side.
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(matchResults)
        .where(
          and(
            ne(matchResults.id, resultId),
            eq(matchResults.status, 'confirmed'),
            gte(matchResults.ratedAt, since),
            or(
              and(sql`${userId} = any(${matchResults.sideA})`, arrayOverlaps(matchResults.sideB, opponents)),
              and(sql`${userId} = any(${matchResults.sideB})`, arrayOverlaps(matchResults.sideA, opponents)),
            ),
          ),
        )) as [{ n: number }];
      const damp = Number(n) >= cfg.repeatGames ? cfg.repeatFactor : 1;
      const { row, pre } = current.get(userId)!;
      const next = rate(pre, onA ? compB : compA, score, cfg.tau, damp);
      const before: Snapshot = {
        rating: row.rating,
        deviation: row.deviation,
        volatility: row.volatility,
        games: row.games,
        lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
      };
      const after: Snapshot = { ...next, games: row.games + 1, lastPlayedAt: now.toISOString() };
      await tx
        .update(ratings)
        .set({ ...next, games: after.games, lastPlayedAt: now, updatedAt: now })
        .where(eq(ratings.id, row.id));
      await tx.insert(ratingChanges).values({ resultId, userId, sportId: r.sportId, before, after });
    }
    let teamChanges: { teamId: string; before: Snapshot; after: Snapshot }[] | null = null;
    if (r.homeTeamId && r.awayTeamId)
      teamChanges = await this.rateTeams(tx, r.homeTeamId, r.awayTeamId, outcome, cfg, now);
    await tx.update(matchResults).set({ ratedAt: now, teamChanges }).where(eq(matchResults.id, resultId));
    await tx.update(matches).set({ status: 'completed', updatedAt: now }).where(eq(matches.id, matchId));
  }

  /** Team entities get their own rating, updated the normal way: home against away (spec 11.3). */
  private async rateTeams(
    tx: Tx,
    homeId: string,
    awayId: string,
    outcome: Outcome,
    cfg: { start: number; deviation: number; volatility: number; tau: number; periodDays: number },
    now: Date,
  ) {
    await tx
      .insert(teamRatings)
      .values(
        [homeId, awayId].map((teamId) => ({
          teamId,
          rating: cfg.start,
          deviation: cfg.deviation,
          volatility: cfg.volatility,
        })),
      )
      .onConflictDoNothing();
    const rows = await tx
      .select()
      .from(teamRatings)
      .where(inArray(teamRatings.teamId, [homeId, awayId]))
      .for('update');
    const periodMs = cfg.periodDays * 86_400_000;
    const pre = (teamId: string) => {
      const row = rows.find((x) => x.teamId === teamId)!;
      const periods = row.lastPlayedAt ? Math.floor((now.getTime() - row.lastPlayedAt.getTime()) / periodMs) : 0;
      return { row, g: idle(row, periods, cfg.deviation) };
    };
    const [home, away] = [pre(homeId), pre(awayId)];
    const out = [];
    for (const [me, them, score] of [
      [home, away, outcome === 'draw' ? 0.5 : outcome === 'a' ? 1 : 0],
      [away, home, outcome === 'draw' ? 0.5 : outcome === 'b' ? 1 : 0],
    ] as const) {
      const next = rate(me.g, them.g, score, cfg.tau);
      const before: Snapshot = {
        rating: me.row.rating,
        deviation: me.row.deviation,
        volatility: me.row.volatility,
        games: me.row.games,
        lastPlayedAt: me.row.lastPlayedAt?.toISOString() ?? null,
      };
      const after: Snapshot = { ...next, games: me.row.games + 1, lastPlayedAt: now.toISOString() };
      await tx
        .update(teamRatings)
        .set({ ...next, games: after.games, lastPlayedAt: now, updatedAt: now })
        .where(eq(teamRatings.teamId, me.row.teamId));
      out.push({ teamId: me.row.teamId, before, after });
    }
    return out;
  }

  /**
   * Puts ratings back after a void. A player's latest change is restored exactly; if they have played since, the
   * change is subtracted instead.
   */
  // ponytail: subtracting is an approximation; replay later games in order if exact recalculation is ever needed.
  private async revertRatings(tx: Tx, resultId: string) {
    const changes = await tx
      .select()
      .from(ratingChanges)
      .where(and(eq(ratingChanges.resultId, resultId), isNull(ratingChanges.revertedAt)));
    for (const c of changes) {
      const [latest] = await tx
        .select({ id: ratingChanges.id })
        .from(ratingChanges)
        .where(
          and(
            eq(ratingChanges.userId, c.userId),
            eq(ratingChanges.sportId, c.sportId),
            isNull(ratingChanges.revertedAt),
          ),
        )
        .orderBy(desc(ratingChanges.createdAt))
        .limit(1);
      const before = c.before as Snapshot;
      const after = c.after as Snapshot;
      const where = and(eq(ratings.userId, c.userId), eq(ratings.sportId, c.sportId), eq(ratings.kind, 'skill'));
      if (latest?.id === c.id) {
        await tx
          .update(ratings)
          .set({
            rating: before.rating,
            deviation: before.deviation,
            volatility: before.volatility,
            games: before.games,
            lastPlayedAt: before.lastPlayedAt ? new Date(before.lastPlayedAt) : null,
          })
          .where(where);
      } else {
        await tx
          .update(ratings)
          .set({
            rating: sql`${ratings.rating} - ${after.rating - before.rating}`,
            games: sql`greatest(${ratings.games} - 1, 0)`,
          })
          .where(where);
      }
      await tx.update(ratingChanges).set({ revertedAt: new Date() }).where(eq(ratingChanges.id, c.id));
    }
    const [row] = await tx
      .select({ teamChanges: matchResults.teamChanges })
      .from(matchResults)
      .where(eq(matchResults.id, resultId));
    for (const t of (row?.teamChanges ?? []) as { teamId: string; before: Snapshot; after: Snapshot }[]) {
      const [current] = await tx.select().from(teamRatings).where(eq(teamRatings.teamId, t.teamId));
      const latest = current?.lastPlayedAt?.toISOString() === t.after.lastPlayedAt;
      await tx
        .update(teamRatings)
        .set(
          latest
            ? {
                rating: t.before.rating,
                deviation: t.before.deviation,
                volatility: t.before.volatility,
                games: t.before.games,
                lastPlayedAt: t.before.lastPlayedAt ? new Date(t.before.lastPlayedAt) : null,
              }
            : {
                rating: sql`${teamRatings.rating} - ${t.after.rating - t.before.rating}`,
                games: sql`greatest(${teamRatings.games} - 1, 0)`,
              },
        )
        .where(eq(teamRatings.teamId, t.teamId));
    }
  }

  // ---------- helpers ----------

  private async match(matchId: string) {
    const [m] = await this.db
      .select({
        id: matches.id,
        hostId: matches.hostId,
        endAt: matches.endAt,
        status: matches.status,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
      })
      .from(matches)
      .where(eq(matches.id, matchId));
    if (!m) throw new ResultError('NOT_FOUND', 'Match not found.');
    return m;
  }

  /** Confirmed participants: the host plus confirmed players (spec 11.1). Names only, never phone numbers. */
  private async participants(matchId: string, hostId: string) {
    const confirmed = await this.db
      .select({ id: matchPlayers.userId })
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.status, 'confirmed')));
    const ids = [hostId, ...confirmed.map((c) => c.id).filter((id) => id !== hostId)];
    const names = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    return ids.map((id) => ({ id, name: names.find((n) => n.id === id)?.name ?? 'Player' }));
  }
}
