import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { effectiveStatus } from '../bookings/bookings.service.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../db/errors.js';
import {
  blocks,
  bookings,
  bookingShares,
  branches,
  courts,
  gender,
  matches,
  matchPlayers,
  paymentAccounts,
  paymentMethod,
  ratings,
  reports,
  sports,
  teamMembers,
  teams,
  users,
  verifications,
} from '../db/schema.js';
import { ageOn } from '../users/profile.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { refundShares } from '../refunds/refunds.service.js';
import { getSetting } from '../settings.js';
import { DocumentCrypto } from '../verification/document-crypto.js';

export class MatchError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_HOST'
      | 'BOOKING_NOT_READY'
      | 'ALREADY_A_MATCH'
      | 'INVALID_MATCH'
      | 'UNLISTED_WARNING_REQUIRED'
      | 'NOT_ELIGIBLE'
      | 'CLOSED'
      | 'OVERLAPPING'
      | 'ALREADY_REQUESTED'
      | 'FULL'
      | 'NOT_APPROVED'
      | 'INVALID_REFERENCE'
      | 'METHOD_NOT_ACCEPTED'
      | 'DUPLICATE_TRANSACTION',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Gender = (typeof gender.enumValues)[number];
export type MatchFilters = {
  minAge?: number;
  maxAge?: number;
  gender?: Gender | null;
  verifiedOnly?: boolean;
  minRating?: number;
  maxRating?: number;
};
export type Viewer = {
  id: string;
  dob: string | null;
  gender: Gender | null;
  verified: boolean;
  /** Skill rating per sport id; unrated players count as the start rating. */
  ratings?: Map<string, number>;
  startRating?: number;
};

// Join requests that hold a place: approved players have a share to pay, confirmed ones have paid.
const TAKING_PLACE = ['approved', 'confirmed'] as const;
const ACTIVE_PLAYER = ['requested', 'approved', 'confirmed'] as const;
const REFERENCE = /^[A-Za-z0-9-]{4,40}$/;

/** Recounts a match: full when the host's players plus confirmed and approved joiners fill every slot. */
export async function refreshMatchStatus(tx: Pick<Db, 'select' | 'update'>, matchId: string) {
  const [m] = await tx.select().from(matches).where(eq(matches.id, matchId));
  if (!m || !['open', 'full'].includes(m.status)) return;
  const [taken] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(matchPlayers)
    .where(and(eq(matchPlayers.matchId, matchId), inArray(matchPlayers.status, [...TAKING_PLACE])));
  const status = m.hostBrings + Number(taken!.n) >= m.slotsTotal ? 'full' : 'open';
  if (status !== m.status)
    await tx.update(matches).set({ status, updatedAt: new Date() }).where(eq(matches.id, matchId));
}

@Injectable()
export class MatchesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  /** Short "Padel on Thu 1 Oct" label for notifications. */
  private async label(matchId: string) {
    const [m] = await this.db
      .select({ sport: sports.name, startAt: matches.startAt, hostId: matches.hostId })
      .from(matches)
      .innerJoin(sports, eq(sports.id, matches.sportId))
      .where(eq(matches.id, matchId));
    const day = m
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Karachi',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(m.startAt)
      : '';
    return { text: m ? `${m.sport} on ${day}` : 'your match', hostId: m?.hostId };
  }

  /**
   * Host creates a match (spec 8). At a listed venue it uses the host's own booking, which must be confirmed or
   * waiting for the vendor's check: the host secures the slot and pays for the players they bring. At an unlisted
   * venue there is no booking or payment, and the host must accept the no-responsibility warning.
   */
  async create(
    userId: string,
    input: {
      sport: string;
      bookingId?: string;
      unlisted?: { name: string; address: string; latitude: number; longitude: number; startAt: Date; endAt: Date };
      acceptedUnlistedWarning?: boolean;
      slotsTotal: number;
      hostBrings: number;
      filters: MatchFilters;
      /** Team match: the host's team (captain or vice captain), and optionally the team challenged. */
      teamId?: string;
      opponentTeamId?: string;
    },
    now = new Date(),
  ) {
    if (input.hostBrings < 1 || input.hostBrings >= input.slotsTotal) {
      throw new MatchError(
        'INVALID_MATCH',
        'Leave at least one open place, and count yourself in the players you bring.',
      );
    }
    if (input.filters.minRating && input.filters.maxRating && input.filters.minRating > input.filters.maxRating) {
      throw new MatchError('INVALID_MATCH', 'The lowest rating must be below the highest.');
    }
    if (input.filters.minAge && input.filters.maxAge && input.filters.minAge > input.filters.maxAge) {
      throw new MatchError('INVALID_MATCH', 'The minimum age must not be above the maximum age.');
    }
    const [sport] = await this.db.select({ id: sports.id }).from(sports).where(eq(sports.slug, input.sport));
    if (!sport) throw new MatchError('INVALID_MATCH', 'Choose a sport from the list.');
    if (input.teamId) {
      const home = await this.teamFor(input.teamId, sport.id);
      if (!(await this.leads(userId, input.teamId)) || !home)
        throw new MatchError('INVALID_MATCH', 'Only the captain or vice captain can create a match for this team.');
      if (
        input.opponentTeamId &&
        (input.opponentTeamId === input.teamId || !(await this.teamFor(input.opponentTeamId, sport.id)))
      )
        throw new MatchError('INVALID_MATCH', 'Choose another team of the same sport to challenge.');
    } else if (input.opponentTeamId) {
      throw new MatchError('INVALID_MATCH', 'Choose your team first.');
    }

    let place: { bookingId: string | null; startAt: Date; endAt: Date; unlisted: typeof input.unlisted | null };
    if (input.bookingId) {
      const [b] = await this.db
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, input.bookingId), eq(bookings.createdBy, userId)));
      const status = b && effectiveStatus(b, now);
      if (!b || (status !== 'confirmed' && status !== 'pending_payment') || b.startAt <= now) {
        throw new MatchError('BOOKING_NOT_READY', 'Book the slot and pay the advance first, then create the match.');
      }
      place = { bookingId: b.id, startAt: b.startAt, endAt: b.endAt, unlisted: null };
    } else if (input.unlisted) {
      if (!input.acceptedUnlistedWarning) {
        throw new MatchError(
          'UNLISTED_WARNING_REQUIRED',
          'Confirm you understand SportsLink does not verify this venue.',
        );
      }
      if (!(input.unlisted.endAt > input.unlisted.startAt) || input.unlisted.startAt <= now) {
        throw new MatchError('INVALID_MATCH', 'Choose a future start time and an end after it.');
      }
      place = {
        bookingId: null,
        startAt: input.unlisted.startAt,
        endAt: input.unlisted.endAt,
        unlisted: input.unlisted,
      };
    } else {
      throw new MatchError('INVALID_MATCH', 'Choose your booking or an unlisted venue.');
    }

    const cutoffMinutes = await getSetting(this.db, 'match.join_cutoff_minutes');
    try {
      const [m] = await this.db
        .insert(matches)
        .values({
          hostId: userId,
          sportId: sport.id,
          bookingId: place.bookingId,
          unlistedVenueName: place.unlisted?.name.trim() ?? null,
          unlistedVenueAddress: place.unlisted?.address.trim() ?? null,
          location: place.unlisted ? `SRID=4326;POINT(${place.unlisted.longitude} ${place.unlisted.latitude})` : null,
          startAt: place.startAt,
          endAt: place.endAt,
          slotsTotal: input.slotsTotal,
          hostBrings: input.hostBrings,
          filters: input.filters,
          joinCutoffAt: new Date(place.startAt.getTime() - cutoffMinutes * 60_000),
          homeTeamId: input.teamId ?? null,
          challengedTeamId: input.opponentTeamId ?? null,
        })
        .returning({ id: matches.id });
      if (input.opponentTeamId) {
        const leaders = await this.db
          .select({ id: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, input.opponentTeamId),
              eq(teamMembers.status, 'active'),
              inArray(teamMembers.role, ['captain', 'vice_captain']),
            ),
          );
        await this.notes?.notify(
          leaders.map((l) => l.id),
          {
            kind: 'match',
            title: 'Your team is challenged',
            body: 'Another team wants to play you. Open the match to accept.',
            link: `/matches/${m!.id}`,
            refId: m!.id,
          },
        );
      }
      return { id: m!.id };
    } catch (err) {
      if (hasPgCode(err, UNIQUE_VIOLATION))
        throw new MatchError('ALREADY_A_MATCH', 'This booking already has a match.');
      throw err;
    }
  }

  /** Open matches this player may see: filters they meet, hosts who have not blocked them, joining still open. */
  async list(userId: string, filter: { sport?: string }, now = new Date()) {
    const viewer = await this.viewer(userId);
    const rows = await this.baseQuery()
      .where(
        and(
          inArray(matches.status, ['open', 'full']),
          gt(matches.joinCutoffAt, now),
          filter.sport ? eq(sports.slug, filter.sport) : undefined,
          sql`not exists (select 1 from ${blocks} where ${blocks.blockerId} = ${matches.hostId} and ${blocks.blockedId} = ${userId})`,
        ),
      )
      .orderBy(asc(matches.startAt))
      .limit(100);
    const summaries = await this.summarise(rows);
    return summaries.filter((m) => m.host.id === userId || eligible(viewer, m.filters, m.startAt, m.sportId));
  }

  /** Matches the player hosts or has asked to join. */
  async mine(userId: string) {
    const joined = this.db
      .select({ id: matchPlayers.matchId })
      .from(matchPlayers)
      .where(eq(matchPlayers.userId, userId));
    const rows = await this.baseQuery()
      .where(or(eq(matches.hostId, userId), inArray(matches.id, joined)))
      .orderBy(asc(matches.startAt))
      .limit(100);
    return this.summarise(rows);
  }

  /** A match with its players. The host also sees join requests. Phone numbers are never included. */
  async get(userId: string, matchId: string, now = new Date()) {
    const rows = await this.baseQuery().where(eq(matches.id, matchId));
    const [m] = await this.summarise(rows);
    if (!m) throw new MatchError('NOT_FOUND', 'Match not found.');
    const isHost = m.host.id === userId;
    const players = await this.db
      .select({
        userId: matchPlayers.userId,
        name: users.name,
        status: matchPlayers.status,
        shareStatus: bookingShares.status,
        shareAmount: bookingShares.amount,
      })
      .from(matchPlayers)
      .innerJoin(users, eq(users.id, matchPlayers.userId))
      .leftJoin(bookingShares, eq(bookingShares.id, matchPlayers.shareId))
      .where(eq(matchPlayers.matchId, matchId))
      .orderBy(asc(matchPlayers.createdAt));
    const me = players.find((p) => p.userId === userId) ?? null;
    if (!isHost && !me && !eligible(await this.viewer(userId), m.filters, m.startAt, m.sportId)) {
      throw new MatchError('NOT_FOUND', 'Match not found.');
    }
    return {
      ...m,
      isHost,
      canJoin: !isHost && !me && ['open', 'full'].includes(m.status) && m.joinCutoffAt > now,
      me: me && { status: me.status, shareStatus: me.shareStatus, shareAmount: me.shareAmount },
      // Host sees everyone; others see who is playing.
      players: players
        .filter((p) => isHost || ['approved', 'confirmed'].includes(p.status))
        .map((p) => ({ userId: p.userId, name: p.name, status: p.status, shareStatus: isHost ? p.shareStatus : null })),
    };
  }

  /** Join request. The host approves every one (Foundation 4.3). */
  async join(userId: string, matchId: string, input: { acceptedUnlistedWarning?: boolean }, now = new Date()) {
    const m = await this.getOpen(matchId, now);
    if (m.hostId === userId) throw new MatchError('ALREADY_REQUESTED', 'You are the host of this match.');
    if (!m.bookingId && !input.acceptedUnlistedWarning) {
      throw new MatchError(
        'UNLISTED_WARNING_REQUIRED',
        'Confirm you understand SportsLink does not verify this venue.',
      );
    }
    const [blocked] = await this.db
      .select({ id: blocks.blockerId })
      .from(blocks)
      .where(and(eq(blocks.blockerId, m.hostId), eq(blocks.blockedId, userId)));
    if (blocked || !eligible(await this.viewer(userId), m.filters as MatchFilters, m.startAt, m.sportId)) {
      throw new MatchError('NOT_ELIGIBLE', 'This match is not open to you.');
    }
    if (m.homeTeamId) {
      const teamsInMatch = [m.homeTeamId, m.awayTeamId].filter((x): x is string => !!x);
      const [member] = await this.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.userId, userId),
            eq(teamMembers.status, 'active'),
            inArray(teamMembers.teamId, teamsInMatch),
          ),
        );
      if (!member) throw new MatchError('NOT_ELIGIBLE', 'Only players from the two teams can join this match.');
    }
    await this.assertNoOverlap(userId, m.startAt, m.endAt, matchId);
    await this.db
      .insert(matchPlayers)
      .values({ matchId, userId, status: 'requested' })
      .onConflictDoUpdate({
        target: [matchPlayers.matchId, matchPlayers.userId],
        set: { status: 'requested', updatedAt: now },
        setWhere: inArray(matchPlayers.status, ['declined', 'withdrawn']),
      });
    const [row] = await this.db
      .select({ status: matchPlayers.status })
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)));
    if (row?.status !== 'requested') throw new MatchError('ALREADY_REQUESTED', 'You have already asked to join.');
    if (this.notes) {
      const [me] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      const { text } = await this.label(matchId);
      await this.notes.notify(m.hostId, {
        kind: 'match',
        title: 'Join request',
        body: `${me?.name ?? 'A player'} wants to join ${text}.`,
        link: `/matches/${matchId}`,
      });
    }
    return { status: 'requested' as const };
  }

  /**
   * Host approves or declines. Approval creates the player's share at a listed venue (price divided by the places);
   * at an unlisted venue there is nothing to pay, so they are confirmed. Once full, approvals go to the waitlist.
   */
  async decide(hostId: string, matchId: string, playerId: string, approve: boolean, now = new Date()) {
    const result = await this.decideTx(hostId, matchId, playerId, approve, now);
    if (this.notes) {
      const { text } = await this.label(matchId);
      const body: Record<string, string> = {
        approved: `You are in for ${text}. Pay your share to confirm your place.`,
        confirmed: `You are in for ${text}.`,
        declined: `The host did not accept your request for ${text}.`,
        waitlisted: `${text} is full. You are on the waitlist.`,
      };
      await this.notes.notify(playerId, {
        kind: 'match',
        title:
          result.status === 'declined'
            ? 'Request declined'
            : result.status === 'waitlisted'
              ? 'On the waitlist'
              : 'Request approved',
        body: body[result.status]!,
        link: `/matches/${matchId}`,
      });
      if (result.status === 'approved' || result.status === 'confirmed')
        await this.notes.tellGuardian(playerId, `Joined a match: ${text}`);
    }
    return result;
  }

  private async decideTx(hostId: string, matchId: string, playerId: string, approve: boolean, now: Date) {
    return this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for('update');
      if (!m) throw new MatchError('NOT_FOUND', 'Match not found.');
      if (m.hostId !== hostId) throw new MatchError('NOT_HOST', 'Only the host can do this.');
      if (!m.joinCutoffAt || m.joinCutoffAt <= now)
        throw new MatchError('CLOSED', 'Joining has closed for this match.');
      const [p] = await tx
        .select()
        .from(matchPlayers)
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, playerId)));
      if (!p || !['requested', 'waitlisted'].includes(p.status))
        throw new MatchError('NOT_FOUND', 'Request not found.');
      if (!approve) {
        await tx
          .update(matchPlayers)
          .set({ status: 'declined', updatedAt: now })
          .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, playerId)));
        return { status: 'declined' as const };
      }
      const [taken] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(matchPlayers)
        .where(and(eq(matchPlayers.matchId, matchId), inArray(matchPlayers.status, [...TAKING_PLACE])));
      if (m.hostBrings + Number(taken!.n) >= m.slotsTotal) {
        await tx
          .update(matchPlayers)
          .set({ status: 'waitlisted', updatedAt: now })
          .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, playerId)));
        return { status: 'waitlisted' as const };
      }
      let shareId: string | null = null;
      if (m.bookingId) {
        const [b] = await tx.select({ total: bookings.total }).from(bookings).where(eq(bookings.id, m.bookingId));
        const perPlayer = Math.ceil(b!.total / m.slotsTotal);
        const [share] = await tx
          .insert(bookingShares)
          .values({
            bookingId: m.bookingId,
            userId: playerId,
            amount: perPlayer,
            advanceAmount: perPlayer,
            dueAt: m.joinCutoffAt,
          })
          .returning({ id: bookingShares.id });
        shareId = share!.id;
      }
      const status = m.bookingId ? ('approved' as const) : ('confirmed' as const);
      await tx
        .update(matchPlayers)
        .set({ status, shareId, updatedAt: now })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, playerId)));
      await refreshMatchStatus(tx, matchId);
      return { status };
    });
  }

  /** Host removes a player before the match (Foundation 4.3), for example one who has not paid by the deadline. */
  async remove(hostId: string, matchId: string, playerId: string, now = new Date()) {
    const [m] = await this.db
      .select({ hostId: matches.hostId, startAt: matches.startAt })
      .from(matches)
      .where(eq(matches.id, matchId));
    if (!m) throw new MatchError('NOT_FOUND', 'Match not found.');
    if (m.hostId !== hostId) throw new MatchError('NOT_HOST', 'Only the host can do this.');
    if (m.startAt <= now) throw new MatchError('CLOSED', 'The match has started.');
    const result = await this.leaveAs(matchId, playerId, 'removed', now);
    await this.notes?.notify(playerId, {
      kind: 'match',
      title: 'Removed from a match',
      body: `The host removed you from ${(await this.label(matchId)).text}. Any refund follows the venue policy.`,
      link: `/matches/${matchId}`,
    });
    return result;
  }

  /** Player leaves. Refunds of a paid share follow the booking policy (handled with cancellations). */
  async leave(userId: string, matchId: string, now = new Date()) {
    return this.leaveAs(matchId, userId, 'withdrawn', now);
  }

  async cancel(hostId: string, matchId: string, now = new Date()) {
    const [m] = await this.db
      .select({ hostId: matches.hostId, status: matches.status })
      .from(matches)
      .where(eq(matches.id, matchId));
    if (!m) throw new MatchError('NOT_FOUND', 'Match not found.');
    if (m.hostId !== hostId) throw new MatchError('NOT_HOST', 'Only the host can do this.');
    if (!['open', 'full'].includes(m.status)) throw new MatchError('CLOSED', 'This match can no longer be cancelled.');
    await this.db.transaction(async (tx) => {
      await tx.update(matches).set({ status: 'cancelled', updatedAt: now }).where(eq(matches.id, matchId));
      // Joiners' paid shares are refunded as the booking policy allows (spec 8.2); the host keeps their booking.
      const [booking] = await tx.select({ id: matches.bookingId }).from(matches).where(eq(matches.id, matchId));
      const shareIds = (
        await tx.select({ shareId: matchPlayers.shareId }).from(matchPlayers).where(eq(matchPlayers.matchId, matchId))
      )
        .map((r) => r.shareId)
        .filter((id): id is string => !!id);
      if (booking?.id && shareIds.length) {
        await refundShares(tx, { bookingId: booking.id, shareIds, reason: 'match_cancelled', full: false, now });
      }
    });
    if (this.notes) {
      const players = await this.db
        .select({ id: matchPlayers.userId })
        .from(matchPlayers)
        .where(
          and(
            eq(matchPlayers.matchId, matchId),
            inArray(matchPlayers.status, ['requested', 'approved', 'confirmed', 'waitlisted']),
          ),
        );
      await this.notes.notify(
        players.map((p) => p.id),
        {
          kind: 'match',
          title: 'Match cancelled',
          body: `The host cancelled ${(await this.label(matchId)).text}. Any refund follows the venue policy.`,
          link: `/matches/${matchId}`,
        },
      );
    }
    return { status: 'cancelled' as const };
  }

  /** Where an approved player pays their share: the venue's approved accounts (Foundation 8.1). */
  async payInfo(userId: string, matchId: string) {
    const p = await this.approvedPlayer(userId, matchId);
    const accounts = await this.db
      .select({
        method: paymentAccounts.method,
        accountTitle: paymentAccounts.accountTitle,
        bankName: paymentAccounts.bankName,
        accountNumberEncrypted: paymentAccounts.accountNumberEncrypted,
      })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.vendorId, p.vendorId),
          eq(paymentAccounts.status, 'approved'),
          ne(paymentAccounts.method, 'cash'),
        ),
      );
    return {
      amount: p.amount,
      currency: p.currency,
      shareStatus: p.shareStatus,
      accounts: accounts.map(({ accountNumberEncrypted, ...a }) => ({
        ...a,
        accountNumber: accountNumberEncrypted ? this.crypto.decryptAccount(accountNumberEncrypted) : null,
      })),
    };
  }

  /** Approved player reports paying their share; the vendor confirms it in their payments queue. */
  async payShare(
    userId: string,
    matchId: string,
    input: { method: (typeof paymentMethod.enumValues)[number]; txnReference: string },
  ) {
    const p = await this.approvedPlayer(userId, matchId);
    if (p.shareStatus === 'submitted' || p.shareStatus === 'confirmed') {
      throw new MatchError('NOT_APPROVED', 'Your payment is already with the venue.');
    }
    const reference = input.txnReference.trim();
    if (!REFERENCE.test(reference))
      throw new MatchError('INVALID_REFERENCE', 'Enter the transaction ID from your payment receipt.');
    const [account] = await this.db
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.vendorId, p.vendorId),
          eq(paymentAccounts.method, input.method),
          eq(paymentAccounts.status, 'approved'),
        ),
      );
    if (!account || input.method === 'cash')
      throw new MatchError('METHOD_NOT_ACCEPTED', 'This venue does not accept that payment method.');
    try {
      await this.db
        .update(bookingShares)
        .set({ method: input.method, txnReference: reference, status: 'submitted', updatedAt: new Date() })
        .where(eq(bookingShares.id, p.shareId));
    } catch (err) {
      if (!hasPgCode(err, UNIQUE_VIOLATION)) throw err;
      await this.db.insert(reports).values({
        reporterId: userId,
        targetType: 'booking',
        targetId: p.bookingId,
        reason: 'duplicate_transaction_reference',
        details: 'Automatic flag: payment reference already used for another booking.',
        evidence: { method: input.method, matchId },
      });
      throw new MatchError(
        'DUPLICATE_TRANSACTION',
        'That transaction ID has already been used. Check the ID on your receipt.',
      );
    }
    return { shareStatus: 'submitted' as const };
  }

  // ---------- helpers ----------

  private baseQuery() {
    return this.db
      .select({
        id: matches.id,
        status: matches.status,
        startAt: matches.startAt,
        endAt: matches.endAt,
        joinCutoffAt: matches.joinCutoffAt,
        slotsTotal: matches.slotsTotal,
        hostBrings: matches.hostBrings,
        filters: matches.filters,
        sport: sports.name,
        sportId: matches.sportId,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        challengedTeamId: matches.challengedTeamId,
        host: { id: users.id, name: users.name },
        bookingId: matches.bookingId,
        unlistedVenueName: matches.unlistedVenueName,
        unlistedVenueAddress: matches.unlistedVenueAddress,
        venueName: branches.name,
        venueCity: branches.city,
        timezone: branches.timezone,
        courtName: courts.name,
        total: bookings.total,
        currency: bookings.currency,
      })
      .from(matches)
      .innerJoin(sports, eq(sports.id, matches.sportId))
      .innerJoin(users, eq(users.id, matches.hostId))
      .leftJoin(bookings, eq(bookings.id, matches.bookingId))
      .leftJoin(courts, eq(courts.id, bookings.courtId))
      .leftJoin(branches, eq(branches.id, courts.branchId));
  }

  private async summarise(rows: Awaited<ReturnType<MatchesService['baseQuery']>>) {
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await this.db
          .select({ matchId: matchPlayers.matchId, n: sql<number>`count(*)::int` })
          .from(matchPlayers)
          .where(and(inArray(matchPlayers.matchId, ids), inArray(matchPlayers.status, [...TAKING_PLACE])))
          .groupBy(matchPlayers.matchId)
      : [];
    const teamIds = [...new Set(rows.flatMap((r) => [r.homeTeamId, r.awayTeamId, r.challengedTeamId]))].filter(
      (x): x is string => !!x,
    );
    const teamNames = teamIds.length
      ? await this.db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds))
      : [];
    const team = (tid: string | null) => (tid ? (teamNames.find((t) => t.id === tid) ?? null) : null);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      teams: r.homeTeamId
        ? { home: team(r.homeTeamId), away: team(r.awayTeamId), challenged: team(r.challengedTeamId) }
        : null,
      sport: r.sport,
      sportId: r.sportId,
      startAt: r.startAt,
      endAt: r.endAt,
      joinCutoffAt: r.joinCutoffAt!,
      timezone: r.timezone ?? 'Asia/Karachi',
      slotsTotal: r.slotsTotal,
      slotsFilled: r.hostBrings + Number(counts.find((c) => c.matchId === r.id)?.n ?? 0),
      filters: r.filters as MatchFilters,
      host: r.host,
      listed: !!r.bookingId,
      bookingId: r.bookingId,
      venue: r.bookingId
        ? { name: r.venueName!, detail: `${r.courtName}, ${r.venueCity}` }
        : { name: r.unlistedVenueName!, detail: r.unlistedVenueAddress! },
      // Each joining player's share of the court price; the host pays the rest (Foundation 4.3).
      pricePerPlayer: r.total !== null ? Math.ceil(r.total / r.slotsTotal) : null,
      currency: r.currency,
    }));
  }

  /** A team takes up the challenge: an open team match, or one that named this team (spec 12.1). */
  async acceptChallenge(userId: string, matchId: string, teamId: string, now = new Date()) {
    const m = await this.getOpen(matchId, now);
    if (!m.homeTeamId || m.awayTeamId) throw new MatchError('CLOSED', 'This match is not looking for a team.');
    if (m.homeTeamId === teamId || (m.challengedTeamId && m.challengedTeamId !== teamId))
      throw new MatchError('NOT_ELIGIBLE', 'This challenge is for another team.');
    if (!(await this.leads(userId, teamId)) || !(await this.teamFor(teamId, m.sportId)))
      throw new MatchError('NOT_ELIGIBLE', 'Only the captain or vice captain of a team in this sport can accept.');
    const [done] = await this.db
      .update(matches)
      .set({ awayTeamId: teamId, updatedAt: now })
      .where(and(eq(matches.id, matchId), isNull(matches.awayTeamId)))
      .returning({ id: matches.id });
    if (!done) throw new MatchError('CLOSED', 'Another team has already accepted.');
    const { text } = await this.label(matchId);
    await this.notes?.notify(m.hostId, {
      kind: 'match',
      title: 'Challenge accepted',
      body: `A team accepted your challenge for ${text}.`,
      link: `/matches/${matchId}`,
      refId: matchId,
    });
    return { id: matchId, awayTeamId: teamId };
  }

  private async leads(userId: string, teamId: string) {
    const [m] = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          eq(teamMembers.status, 'active'),
          inArray(teamMembers.role, ['captain', 'vice_captain']),
        ),
      );
    return !!m;
  }

  private async teamFor(teamId: string, sportId: string) {
    const [t] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.sportId, sportId), eq(teams.status, 'active')));
    return t ?? null;
  }

  private async viewer(userId: string): Promise<Viewer> {
    const [u] = await this.db
      .select({ id: users.id, dob: users.dob, gender: users.gender })
      .from(users)
      .where(eq(users.id, userId));
    const [v] = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.userId, userId), eq(verifications.status, 'approved')))
      .limit(1);
    const rated = await this.db
      .select({ sportId: ratings.sportId, rating: ratings.rating })
      .from(ratings)
      .where(and(eq(ratings.userId, userId), eq(ratings.kind, 'skill')));
    return {
      id: userId,
      dob: u?.dob ?? null,
      gender: u?.gender ?? null,
      verified: !!v,
      ratings: new Map(rated.map((r) => [r.sportId, r.rating])),
      startRating: await getSetting(this.db, 'rating.start'),
    };
  }

  private async getOpen(matchId: string, now: Date) {
    const [m] = await this.db.select().from(matches).where(eq(matches.id, matchId));
    if (!m) throw new MatchError('NOT_FOUND', 'Match not found.');
    if (!['open', 'full'].includes(m.status) || !m.joinCutoffAt || m.joinCutoffAt <= now) {
      throw new MatchError('CLOSED', 'Joining has closed for this match.');
    }
    return m;
  }

  /** Spec 8.2: a player cannot be in two matches at overlapping times. */
  private async assertNoOverlap(userId: string, startAt: Date, endAt: Date, exceptMatchId: string) {
    const [clash] = await this.db
      .select({ id: matches.id })
      .from(matches)
      .leftJoin(matchPlayers, and(eq(matchPlayers.matchId, matches.id), eq(matchPlayers.userId, userId)))
      .where(
        and(
          ne(matches.id, exceptMatchId),
          inArray(matches.status, ['open', 'full', 'in_progress']),
          lt(matches.startAt, endAt),
          gt(matches.endAt, startAt),
          or(eq(matches.hostId, userId), inArray(matchPlayers.status, [...ACTIVE_PLAYER])),
        ),
      )
      .limit(1);
    if (clash) throw new MatchError('OVERLAPPING', 'You are already in a match at this time.');
  }

  private async leaveAs(matchId: string, userId: string, status: 'withdrawn' | 'removed', now: Date) {
    return this.db.transaction(async (tx: Tx) => {
      const [p] = await tx
        .select()
        .from(matchPlayers)
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)));
      if (!p || !['requested', 'approved', 'confirmed', 'waitlisted'].includes(p.status)) {
        throw new MatchError('NOT_FOUND', 'Player not found in this match.');
      }
      await tx
        .update(matchPlayers)
        .set({ status, updatedAt: now })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)));
      // An unpaid share is voided; a paid one is refunded if the booking policy allows (spec 8.2).
      if (p.shareId) {
        const [share] = await tx
          .select({ bookingId: bookingShares.bookingId })
          .from(bookingShares)
          .where(eq(bookingShares.id, p.shareId));
        await refundShares(tx, {
          bookingId: share!.bookingId,
          shareIds: [p.shareId],
          reason: 'left_match',
          full: false,
          now,
        });
      }
      await refreshMatchStatus(tx, matchId);
      return { status };
    });
  }

  private async approvedPlayer(userId: string, matchId: string) {
    const [p] = await this.db
      .select({
        status: matchPlayers.status,
        shareId: matchPlayers.shareId,
        shareStatus: bookingShares.status,
        amount: bookingShares.amount,
        bookingId: bookings.id,
        currency: bookings.currency,
        vendorId: branches.vendorId,
      })
      .from(matchPlayers)
      .innerJoin(bookingShares, eq(bookingShares.id, matchPlayers.shareId))
      .innerJoin(bookings, eq(bookings.id, bookingShares.bookingId))
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)));
    if (!p || !['approved', 'confirmed'].includes(p.status)) {
      throw new MatchError('NOT_APPROVED', 'The host needs to approve you before you pay.');
    }
    return { ...p, shareId: p.shareId! };
  }
}

/** True if the player meets the match filters (Foundation 4.3). Unknown age or gender does not pass a filter on it. */
export function eligible(viewer: Viewer, filters: MatchFilters, at: Date, sportId?: string) {
  if (filters.verifiedOnly && !viewer.verified) return false;
  if (filters.minRating || filters.maxRating) {
    const r = (sportId && viewer.ratings?.get(sportId)) || viewer.startRating || 1500;
    if (filters.minRating && r < filters.minRating) return false;
    if (filters.maxRating && r > filters.maxRating) return false;
  }
  if (filters.gender && viewer.gender !== filters.gender) return false;
  if (filters.minAge || filters.maxAge) {
    if (!viewer.dob) return false;
    const age = ageOn(viewer.dob, at);
    if (filters.minAge && age < filters.minAge) return false;
    if (filters.maxAge && age > filters.maxAge) return false;
  }
  return true;
}
