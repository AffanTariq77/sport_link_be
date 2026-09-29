import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import {
  findRequests,
  findResponses,
  matches,
  matchPlayers,
  playerAvailability,
  ratings,
  reviews,
  sports,
  users,
} from '../db/schema.js';
import { eligible, type MatchFilters, MatchesService } from '../matches/matches.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { getSetting } from '../settings.js';

export class FindError extends Error {
  constructor(
    public readonly code:
      'NOT_FOUND' | 'NO_LOCATION' | 'INVALID_REQUEST' | 'RATE_LIMITED' | 'NOT_ELIGIBLE' | 'CLOSED' | 'NOT_ACCEPTED',
    message: string,
  ) {
    super(message);
  }
}

/** About 500 m (spec 9.2): the only precision ever stored. */
export const roundCoord = (x: number) => Math.round(x / 0.005) * 0.005;
const point = (lat: number, lng: number) => `SRID=4326;POINT(${roundCoord(lng)} ${roundCoord(lat)})`;
/** Other players only ever see a band, never coordinates (spec 9.2). */
export function distanceBand(m: number) {
  if (m < 2000) return 'under 2 km';
  if (m < 5000) return '2 to 5 km';
  if (m < 10000) return '5 to 10 km';
  return 'over 10 km';
}

type Window = { window: 'now' | 'today' | 'custom'; startAt?: Date; endAt?: Date };

/**
 * Find Players live (spec 9): a request alerts nearby players who match, nearest first and in batches; accepting
 * players show up for the requester, who picks who joins. The picked players and the requester then chat and turn
 * it into a match. Clients poll for updates.
 */
// ponytail: polling, like chat; move the accepted list to Socket.IO when realtime lands (spec 9.1 step 4).
@Injectable()
export class FindService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MatchesService) private readonly matches: MatchesService,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  // ---------- the player's own settings ----------

  async setLocation(userId: string, lat: number, lng: number, now = new Date()) {
    await this.db
      .insert(playerAvailability)
      .values({ userId, location: point(lat, lng), locatedAt: now })
      .onConflictDoUpdate({
        target: playerAvailability.userId,
        set: { location: point(lat, lng), locatedAt: now, updatedAt: now },
      });
    return { ok: true };
  }

  async availability(userId: string) {
    const [a] = await this.db.select().from(playerAvailability).where(eq(playerAvailability.userId, userId));
    return {
      alertMode: (a?.alertMode ?? 'available') as 'always' | 'available' | 'off',
      available: a?.available ?? false,
      quietHoursOk: a?.quietHoursOk ?? false,
      sports: a?.sportSlugs ?? [],
      hasLocation: !!a?.location,
    };
  }

  async setAvailability(
    userId: string,
    input: {
      alertMode?: 'always' | 'available' | 'off';
      available?: boolean;
      quietHoursOk?: boolean;
      sports?: string[];
    },
  ) {
    const set = {
      ...(input.alertMode !== undefined && { alertMode: input.alertMode }),
      ...(input.available !== undefined && { available: input.available }),
      ...(input.quietHoursOk !== undefined && { quietHoursOk: input.quietHoursOk }),
      ...(input.sports !== undefined && { sportSlugs: input.sports }),
    };
    await this.db
      .insert(playerAvailability)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: playerAvailability.userId, set: { ...set, updatedAt: new Date() } });
    return this.availability(userId);
  }

  /** The guardian lets their child see and be seen by adults in Find Players (Foundation 10.2). */
  async setGuardianAllowsAdults(guardianId: string, minorId: string, allow: boolean) {
    const [m] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, minorId), eq(users.guardianUserId, guardianId), eq(users.isMinor, true)));
    if (!m) throw new FindError('NOT_FOUND', 'Child not found.');
    await this.db
      .insert(playerAvailability)
      .values({ userId: minorId, guardianAllowsAdults: allow })
      .onConflictDoUpdate({
        target: playerAvailability.userId,
        set: { guardianAllowsAdults: allow, updatedAt: new Date() },
      });
    return { ok: true };
  }

  // ---------- requests ----------

  async create(
    userId: string,
    input: { sport: string; playersNeeded: number; radiusKm: number; filters: MatchFilters } & Window,
    now = new Date(),
  ) {
    const [me] = await this.db
      .select({ status: users.status, loc: playerAvailability.location, at: playerAvailability.locatedAt })
      .from(users)
      .leftJoin(playerAvailability, eq(playerAvailability.userId, users.id))
      .where(eq(users.id, userId));
    if (me?.status !== 'active')
      throw new FindError('NOT_ELIGIBLE', 'Verify your ID before using Find Players. It keeps everyone safe.');
    const maxAge = await getSetting(this.db, 'find.location_max_age_hours');
    if (!me.loc || !me.at || now.getTime() - me.at.getTime() > maxAge * 3_600_000)
      throw new FindError('NO_LOCATION', 'Share your location first so we can find players near you.');
    const [sport] = await this.db.select({ id: sports.id }).from(sports).where(eq(sports.slug, input.sport));
    if (!sport) throw new FindError('INVALID_REQUEST', 'Choose a sport from the list.');
    const maxRadius = await getSetting(this.db, 'find.max_radius_km');
    if (input.radiusKm < 1 || input.radiusKm > maxRadius)
      throw new FindError('INVALID_REQUEST', `Choose a radius from 1 to ${maxRadius} km.`);
    const { start, end } = this.window(input, now);
    const perHour = await getSetting(this.db, 'find.requests_per_hour');
    const [{ n }] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(findRequests)
      .where(
        and(eq(findRequests.requesterId, userId), gt(findRequests.createdAt, new Date(now.getTime() - 3_600_000))),
      )) as [{ n: number }];
    if (Number(n) >= perHour)
      throw new FindError('RATE_LIMITED', `You can send ${perHour} requests an hour. Try again a little later.`);

    const [r] = await this.db
      .insert(findRequests)
      .values({
        requesterId: userId,
        sportId: sport.id,
        playersNeeded: input.playersNeeded,
        radiusKm: input.radiusKm,
        location: sql`${me.loc}::geography`,
        windowStart: start,
        windowEnd: end,
        filters: input.filters,
        createdAt: now,
      })
      .returning({ id: findRequests.id });
    const notified = await this.notifyBatch(r!.id, now);
    return { id: r!.id, notified };
  }

  /** Requester view with who accepted; responder view with the request and their own status. */
  async get(userId: string, requestId: string, now = new Date()) {
    const r = await this.request(requestId);
    const mine = r.requesterId === userId;
    const [me] = await this.db
      .select()
      .from(findResponses)
      .where(and(eq(findResponses.requestId, requestId), eq(findResponses.userId, userId)));
    if (!mine && !me) throw new FindError('NOT_FOUND', 'Request not found.');
    const [requester] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, r.requesterId));
    const base = {
      id: r.id,
      sport: r.sport,
      playersNeeded: r.playersNeeded,
      radiusKm: r.radiusKm,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      status: this.effectiveStatus(r, now),
      matchId: r.matchId,
      requester: { id: r.requesterId, name: requester?.name ?? 'Player' },
      mine,
      myStatus: me?.status ?? null,
      distance: me ? distanceBand(me.distanceM) : null,
    };
    if (!mine) return { ...base, notified: 0, players: [] };
    const rows = await this.db
      .select({
        userId: findResponses.userId,
        status: findResponses.status,
        distanceM: findResponses.distanceM,
        name: users.name,
        rating: ratings.rating,
        deviation: ratings.deviation,
      })
      .from(findResponses)
      .innerJoin(users, eq(users.id, findResponses.userId))
      .leftJoin(
        ratings,
        and(eq(ratings.userId, findResponses.userId), eq(ratings.sportId, r.sportId), eq(ratings.kind, 'skill')),
      )
      .where(eq(findResponses.requestId, requestId))
      .orderBy(findResponses.distanceM);
    const ids = rows.map((x) => x.userId);
    const stars = ids.length
      ? await this.db
          .select({ userId: reviews.toUserId, avg: sql<number>`avg(${reviews.stars})::float` })
          .from(reviews)
          .where(inArray(reviews.toUserId, ids))
          .groupBy(reviews.toUserId)
      : [];
    const provisional = await getSetting(this.db, 'rating.provisional_deviation');
    return {
      ...base,
      notified: rows.length,
      players: rows
        .filter((x) => ['accepted', 'selected', 'not_selected', 'removed'].includes(x.status))
        .map((x) => {
          const avg = stars.find((s) => s.userId === x.userId)?.avg;
          return {
            id: x.userId,
            name: x.name ?? 'Player',
            status: x.status,
            distance: distanceBand(x.distanceM),
            rating: x.rating === null ? null : Math.round(x.rating),
            provisional: x.deviation === null || x.deviation > provisional,
            behaviour: avg === undefined || avg === null ? null : Math.round(avg * 10) / 10,
          };
        }),
    };
  }

  /** Requests the user sent, and open requests they were alerted to. */
  async mine(userId: string, now = new Date()) {
    const sent = await this.db
      .select({
        id: findRequests.id,
        sport: sports.name,
        status: findRequests.status,
        windowEnd: findRequests.windowEnd,
      })
      .from(findRequests)
      .innerJoin(sports, eq(sports.id, findRequests.sportId))
      .where(eq(findRequests.requesterId, userId))
      .orderBy(desc(findRequests.createdAt))
      .limit(20);
    const incoming = await this.db
      .select({
        id: findRequests.id,
        sport: sports.name,
        status: findRequests.status,
        windowStart: findRequests.windowStart,
        windowEnd: findRequests.windowEnd,
        myStatus: findResponses.status,
        distanceM: findResponses.distanceM,
        requester: users.name,
      })
      .from(findResponses)
      .innerJoin(findRequests, eq(findRequests.id, findResponses.requestId))
      .innerJoin(sports, eq(sports.id, findRequests.sportId))
      .innerJoin(users, eq(users.id, findRequests.requesterId))
      .where(and(eq(findResponses.userId, userId), gt(findRequests.windowEnd, now)))
      .orderBy(desc(findResponses.notifiedAt))
      .limit(20);
    return {
      sent: sent.map((s) => ({ ...s, status: this.effectiveStatus(s, now) })),
      incoming: incoming.map(({ distanceM, requester, ...i }) => ({
        ...i,
        status: this.effectiveStatus(i, now),
        requester: requester ?? 'Player',
        distance: distanceBand(distanceM),
      })),
    };
  }

  async respond(userId: string, requestId: string, accept: boolean, now = new Date()) {
    const r = await this.request(requestId);
    if (this.effectiveStatus(r, now) !== 'open') throw new FindError('CLOSED', 'This request is no longer open.');
    const [done] = await this.db
      .update(findResponses)
      .set({ status: accept ? 'accepted' : 'declined', respondedAt: now })
      .where(
        and(
          eq(findResponses.requestId, requestId),
          eq(findResponses.userId, userId),
          eq(findResponses.status, 'notified'),
        ),
      )
      .returning({ userId: findResponses.userId });
    if (!done) throw new FindError('NOT_FOUND', 'Request not found.');
    if (accept)
      await this.notes?.notify(r.requesterId, {
        kind: 'match',
        title: 'A player is in',
        body: `Someone nearby accepted your ${r.sport} request. Pick who joins.`,
        link: `/find-players/${requestId}`,
        refId: requestId,
        collapse: true,
      });
    return { ok: true };
  }

  /** The requester picks players; the rest who accepted are told politely (spec 9.1 step 5). */
  async select(userId: string, requestId: string, picked: string[], now = new Date()) {
    const r = await this.ownOpen(userId, requestId, now);
    const accepted = await this.responses(requestId, ['accepted']);
    if (!picked.length || !picked.every((id) => accepted.includes(id)))
      throw new FindError('NOT_ACCEPTED', 'Pick from the players who accepted.');
    const selected = await this.responses(requestId, ['selected']);
    if (selected.length + picked.length > r.playersNeeded)
      throw new FindError('INVALID_REQUEST', `You asked for ${r.playersNeeded} players.`);
    const full = selected.length + picked.length >= r.playersNeeded;
    const passed = full ? accepted.filter((id) => !picked.includes(id)) : [];
    await this.db.transaction(async (tx) => {
      await tx
        .update(findResponses)
        .set({ status: 'selected' })
        .where(and(eq(findResponses.requestId, requestId), inArray(findResponses.userId, picked)));
      if (passed.length)
        await tx
          .update(findResponses)
          .set({ status: 'not_selected' })
          .where(and(eq(findResponses.requestId, requestId), inArray(findResponses.userId, passed)));
      if (full)
        await tx.update(findRequests).set({ status: 'matched', updatedAt: now }).where(eq(findRequests.id, requestId));
    });
    await this.notes?.notify(picked, {
      kind: 'match',
      title: 'You are in',
      body: `You were picked for a ${r.sport} game. Agree the venue and time in the chat.`,
      link: `/find-players/${requestId}`,
      refId: requestId,
    });
    await this.notes?.notify(passed, {
      kind: 'match',
      title: 'Thanks for offering',
      body: `The ${r.sport} game has its players this time. We will let you know about the next one.`,
      link: '/find-players',
      refId: requestId,
    });
    return { ok: true };
  }

  /** A picked player went silent: remove them so the requester can pick another (spec 9.3). */
  async remove(userId: string, requestId: string, playerId: string, now = new Date()) {
    const r = await this.request(requestId);
    if (r.requesterId !== userId || !['open', 'matched'].includes(this.effectiveStatus(r, now)))
      throw new FindError('NOT_FOUND', 'Request not found.');
    const [done] = await this.db
      .update(findResponses)
      .set({ status: 'removed' })
      .where(
        and(
          eq(findResponses.requestId, requestId),
          eq(findResponses.userId, playerId),
          eq(findResponses.status, 'selected'),
        ),
      )
      .returning({ userId: findResponses.userId });
    if (!done) throw new FindError('NOT_FOUND', 'Player not found.');
    // Those told "not this time" can be picked again.
    await this.db.transaction(async (tx) => {
      await tx
        .update(findResponses)
        .set({ status: 'accepted' })
        .where(and(eq(findResponses.requestId, requestId), eq(findResponses.status, 'not_selected')));
      await tx.update(findRequests).set({ status: 'open', updatedAt: now }).where(eq(findRequests.id, requestId));
    });
    return { ok: true };
  }

  /** The requester closes the request. Picked players are told; the chat stays open for a while (spec 9.3). */
  async close(userId: string, requestId: string, now = new Date()) {
    const r = await this.request(requestId);
    if (r.requesterId !== userId) throw new FindError('NOT_FOUND', 'Request not found.');
    if (r.status === 'closed' || r.status === 'expired') return { ok: true };
    await this.db
      .update(findRequests)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(eq(findRequests.id, requestId));
    if (!r.matchId)
      await this.notes?.notify(await this.responses(requestId, ['selected']), {
        kind: 'match',
        title: 'Game called off',
        body: `The ${r.sport} request was closed by the organiser.`,
        link: `/find-players/${requestId}`,
        refId: requestId,
      });
    return { ok: true };
  }

  /**
   * Turn the request into a match the requester created (listed booking or unlisted venue, spec 9.1 step 6). The
   * picked players are added as approved: at a listed venue they then pay their share as usual.
   */
  async convert(userId: string, requestId: string, matchId: string, now = new Date()) {
    const r = await this.request(requestId);
    if (r.requesterId !== userId || !['open', 'matched'].includes(this.effectiveStatus(r, now)))
      throw new FindError('NOT_FOUND', 'Request not found.');
    const [m] = await this.db
      .select({ hostId: matches.hostId, sportId: matches.sportId })
      .from(matches)
      .where(eq(matches.id, matchId));
    if (!m || m.hostId !== userId || m.sportId !== r.sportId)
      throw new FindError('INVALID_REQUEST', 'Choose a match you host for the same sport.');
    const picked = await this.responses(requestId, ['selected']);
    for (const p of picked) {
      await this.db.insert(matchPlayers).values({ matchId, userId: p, status: 'requested' }).onConflictDoNothing();
      await this.matches.decide(userId, matchId, p, true, now);
    }
    await this.db
      .update(findRequests)
      .set({ status: 'matched', matchId, updatedAt: now })
      .where(eq(findRequests.id, requestId));
    return { ok: true, added: picked.length };
  }

  // ---------- jobs ----------

  /** Expire requests past their window; send the next batch where too few accepted (spec 9.1 step 3). */
  async runJobs(now = new Date()) {
    const expired = await this.db
      .update(findRequests)
      .set({ status: 'expired', updatedAt: now })
      .where(and(inArray(findRequests.status, ['open', 'matched']), lt(findRequests.windowEnd, now)))
      .returning({ id: findRequests.id });
    const minutes = await getSetting(this.db, 'find.batch_minutes');
    const due = await this.db
      .select({ id: findRequests.id, needed: findRequests.playersNeeded })
      .from(findRequests)
      .where(
        and(eq(findRequests.status, 'open'), lt(findRequests.lastBatchAt, new Date(now.getTime() - minutes * 60_000))),
      );
    let alerted = 0;
    for (const r of due) {
      const taken = await this.responses(r.id, ['accepted', 'selected']);
      if (taken.length < r.needed) alerted += await this.notifyBatch(r.id, now);
    }
    return { findExpired: expired.length, findAlerted: alerted };
  }

  // ---------- helpers ----------

  /**
   * The next batch of nearby players who match, nearest first: sport and alert preferences, radius, filters, blocks,
   * quiet hours, the daily alert cap and minor safeguards (spec 9.1, 9.3, Foundation 10.2).
   */
  private async notifyBatch(requestId: string, now: Date) {
    const r = await this.request(requestId);
    const [cfg, requester] = await Promise.all([
      Promise.all([
        getSetting(this.db, 'find.batch_size'),
        getSetting(this.db, 'find.alerts_per_day'),
        getSetting(this.db, 'find.location_max_age_hours'),
        getSetting(this.db, 'find.quiet_start_hour'),
        getSetting(this.db, 'find.quiet_end_hour'),
        getSetting(this.db, 'minors.find_players_separate'),
        getSetting(this.db, 'rating.start'),
      ]),
      this.db
        .select({ isMinor: users.isMinor, allows: playerAvailability.guardianAllowsAdults })
        .from(users)
        .leftJoin(playerAvailability, eq(playerAvailability.userId, users.id))
        .where(eq(users.id, r.requesterId))
        .then((rows) => rows[0]),
    ]);
    const [batch, perDay, maxAge, quietStart, quietEnd, separate, startRating] = cfg;
    const since = new Date(now.getTime() - maxAge * 3_600_000);
    const day = new Date(now.getTime() - 86_400_000);
    const rows = (
      await this.db.execute(sql`
        select pa.user_id as id, u.dob, u.gender, u.is_minor, pa.guardian_allows_adults as allows,
          st_distance(pa.location, ${r.location}::geography)::int as distance,
          exists (select 1 from verifications v where v.user_id = u.id and v.status = 'approved') as verified,
          (select rt.rating from ratings rt where rt.user_id = u.id and rt.sport_id = ${r.sportId} and rt.kind = 'skill') as rating
        from player_availability pa
        join users u on u.id = pa.user_id
        join countries c on c.code = u.country_code
        where pa.location is not null
          and pa.located_at > ${since.toISOString()}
          and st_dwithin(pa.location, ${r.location}::geography, ${r.radiusKm * 1000})
          and u.status = 'active'
          and u.id <> ${r.requesterId}
          and (pa.alert_mode = 'always' or (pa.alert_mode = 'available' and pa.available))
          and (cardinality(pa.sport_slugs) = 0 or ${r.sportSlug} = any(pa.sport_slugs))
          and not exists (select 1 from user_blocks b where (b.blocker_id = u.id and b.blocked_id = ${r.requesterId})
                                                         or (b.blocker_id = ${r.requesterId} and b.blocked_id = u.id))
          and not exists (select 1 from find_responses fr where fr.request_id = ${requestId} and fr.user_id = u.id)
          and (select count(*) from find_responses fr where fr.user_id = u.id and fr.notified_at > ${day.toISOString()}) < ${perDay}
          and (pa.quiet_hours_ok or not (
            extract(hour from (${now.toISOString()}::timestamptz at time zone c.timezone)) >= ${quietStart}
            or extract(hour from (${now.toISOString()}::timestamptz at time zone c.timezone)) < ${quietEnd}))
        order by distance
        limit ${batch * 3}
      `)
    ).rows as {
      id: string;
      dob: string | null;
      gender: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;
      is_minor: boolean;
      allows: boolean;
      distance: number;
      verified: boolean;
      rating: number | null;
    }[];
    const picked = rows
      .filter((c) => {
        if (separate && c.is_minor !== !!requester?.isMinor) {
          // A minor meets adults only when the minor's guardian allows it (Foundation 10.2).
          if (c.is_minor ? !c.allows : !requester?.allows) return false;
        }
        const viewer = {
          id: c.id,
          dob: c.dob,
          gender: c.gender,
          verified: c.verified,
          ratings: new Map(c.rating === null ? [] : [[r.sportId, Number(c.rating)]]),
          startRating,
        };
        return eligible(viewer, r.filters as MatchFilters, r.windowStart, r.sportId);
      })
      .slice(0, batch);
    await this.db.update(findRequests).set({ lastBatchAt: now }).where(eq(findRequests.id, requestId));
    if (!picked.length) return 0;
    await this.db
      .insert(findResponses)
      .values(picked.map((c) => ({ requestId, userId: c.id, distanceM: Number(c.distance), notifiedAt: now })))
      .onConflictDoNothing();
    for (const c of picked)
      await this.notes?.notify(c.id, {
        kind: 'match',
        title: `${r.sport} players needed nearby`,
        body: `Someone ${distanceBand(Number(c.distance))} away needs ${r.playersNeeded} ${r.playersNeeded === 1 ? 'player' : 'players'}. Tap to join in.`,
        link: `/find-players/${requestId}`,
        refId: requestId,
      });
    return picked.length;
  }

  private window(input: Window, now: Date) {
    if (input.window === 'now') return { start: now, end: new Date(now.getTime() + 3 * 3_600_000) };
    if (input.window === 'today') return { start: now, end: new Date(now.getTime() + 12 * 3_600_000) };
    const { startAt, endAt } = input;
    if (!startAt || !endAt || endAt <= startAt || endAt <= now || endAt.getTime() - now.getTime() > 7 * 86_400_000)
      throw new FindError('INVALID_REQUEST', 'Choose a time window within the next seven days.');
    return { start: startAt < now ? now : startAt, end: endAt };
  }

  private effectiveStatus(r: { status: string; windowEnd: Date }, now: Date) {
    return (['open', 'matched'].includes(r.status) && r.windowEnd <= now ? 'expired' : r.status) as
      'open' | 'matched' | 'closed' | 'expired';
  }

  private async request(requestId: string) {
    const [r] = await this.db
      .select({ req: findRequests, sport: sports.name, sportSlug: sports.slug })
      .from(findRequests)
      .innerJoin(sports, eq(sports.id, findRequests.sportId))
      .where(eq(findRequests.id, requestId));
    if (!r) throw new FindError('NOT_FOUND', 'Request not found.');
    return { ...r.req, sport: r.sport, sportSlug: r.sportSlug };
  }

  private async ownOpen(userId: string, requestId: string, now: Date) {
    const r = await this.request(requestId);
    if (r.requesterId !== userId) throw new FindError('NOT_FOUND', 'Request not found.');
    if (this.effectiveStatus(r, now) !== 'open') throw new FindError('CLOSED', 'This request is no longer open.');
    return r;
  }

  private async responses(requestId: string, statuses: ('accepted' | 'selected' | 'not_selected')[]) {
    const rows = await this.db
      .select({ userId: findResponses.userId })
      .from(findResponses)
      .where(and(eq(findResponses.requestId, requestId), inArray(findResponses.status, statuses)));
    return rows.map((x) => x.userId);
  }
}
