import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import {
  auditLog,
  blocks,
  bookings,
  branches,
  conversationMembers,
  conversations,
  courts,
  findRequests,
  findResponses,
  matches,
  matchPlayers,
  messages,
  reports,
  sports,
  teamMembers,
  teams,
  users,
} from '../db/schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { getSetting } from '../settings.js';
import { vendorAccess } from '../vendors/access.js';
import { containsPhoneNumber } from './phone-detect.js';

export class ChatError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'PHONE_WARNING' | 'EMPTY' | 'BLOCKED',
    message: string,
  ) {
    super(message);
  }
}

const PLAYING = ['approved', 'confirmed'] as const;
const REPORT_CONTEXT = 20; // messages attached to a report (spec 10)
const PAGE = 100;

@Injectable()
export class ChatService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  /** The match group chat: host plus approved and confirmed players (spec 10). Created on first use. */
  async openMatch(userId: string, matchId: string) {
    await this.assertMatchMember(userId, matchId);
    return { id: await this.getOrCreate('match', matchId) };
  }

  /** Find Players group: the requester and the players they picked (spec 9.1 step 5). */
  async openFind(userId: string, requestId: string) {
    await this.assertFindMember(userId, requestId);
    return { id: await this.getOrCreate('find_players', requestId) };
  }

  /** Team chat: every active member (spec 10). */
  async openTeam(userId: string, teamId: string) {
    await this.assertTeamMember(userId, teamId);
    return { id: await this.getOrCreate('team', teamId) };
  }

  /** Player and venue chat about a booking. The venue side is anyone who can see the venue's calendar. */
  async openBooking(userId: string, bookingId: string) {
    await this.assertBookingMember(userId, bookingId);
    return { id: await this.getOrCreate('booking', bookingId) };
  }

  /** Conversations the user belongs to, newest activity first, with the unread count. */
  async list(userId: string) {
    const matchIds = this.db
      .select({ id: matches.id })
      .from(matches)
      .leftJoin(matchPlayers, and(eq(matchPlayers.matchId, matches.id), eq(matchPlayers.userId, userId)))
      .where(or(eq(matches.hostId, userId), inArray(matchPlayers.status, [...PLAYING])));
    const bookingIds = this.db.select({ id: bookings.id }).from(bookings).where(eq(bookings.createdBy, userId));
    const findIds = this.db
      .select({ id: findRequests.id })
      .from(findRequests)
      .leftJoin(findResponses, and(eq(findResponses.requestId, findRequests.id), eq(findResponses.userId, userId)))
      .where(or(eq(findRequests.requesterId, userId), eq(findResponses.status, 'selected')));
    const teamIds = this.db
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.status, 'active')));
    // Venue side: booking chats at every branch whose calendar this user can see.
    const { branchIds } = await vendorAccess(this.db, userId, 'view_bookings');
    const venueBookingIds = this.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .where(branchIds.length ? inArray(courts.branchId, branchIds) : sql`false`);
    const rows = await this.db
      .select({
        id: conversations.id,
        type: conversations.type,
        refId: conversations.refId,
        lastAt: sql<Date | null>`(select max(${messages.createdAt}) from ${messages} where ${messages.conversationId} = ${conversations.id})`,
        lastBody: sql<
          string | null
        >`(select ${messages.body} from ${messages} where ${messages.conversationId} = ${conversations.id} order by ${messages.createdAt} desc limit 1)`,
        lastReadAt: conversationMembers.lastReadAt,
      })
      .from(conversations)
      .leftJoin(
        conversationMembers,
        and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, userId)),
      )
      .where(
        or(
          and(eq(conversations.type, 'match'), inArray(conversations.refId, matchIds)),
          and(eq(conversations.type, 'booking'), inArray(conversations.refId, bookingIds)),
          and(eq(conversations.type, 'team'), inArray(conversations.refId, teamIds)),
          and(eq(conversations.type, 'find_players'), inArray(conversations.refId, findIds)),
          and(eq(conversations.type, 'booking'), inArray(conversations.refId, venueBookingIds)),
          sql`${conversationMembers.userId} is not null`,
        ),
      );
    const titles = await this.titles(rows);
    const unread = await Promise.all(
      rows.map(async (r) => {
        const [c] = await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, r.id),
              r.lastReadAt ? gt(messages.createdAt, r.lastReadAt) : undefined,
              or(isNull(messages.senderId), sql`${messages.senderId} <> ${userId}`),
            ),
          );
        return Number(c!.n);
      }),
    );
    return rows
      .map((r, i) => ({
        id: r.id,
        type: r.type,
        title: titles.get(r.id) ?? 'Chat',
        lastMessage: r.lastBody,
        lastAt: r.lastAt ? new Date(r.lastAt) : null,
        unread: unread[i]!,
      }))
      .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
  }

  /** Messages after a point (for polling), hiding anyone the reader has blocked. Marks the chat read. */
  async messages(userId: string, conversationId: string, after?: Date, now = new Date()) {
    const convo = await this.assertMember(userId, conversationId);
    const blocked = this.db.select({ id: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, userId));
    const rows = await this.db
      .select({
        id: messages.id,
        kind: messages.kind,
        body: messages.body,
        createdAt: messages.createdAt,
        senderId: messages.senderId,
        senderName: users.name,
        flaggedPhone: messages.flaggedPhone,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          after ? gt(messages.createdAt, after) : undefined,
          or(isNull(messages.senderId), notInArray(messages.senderId, blocked)),
        ),
      )
      .orderBy(after ? asc(messages.createdAt) : desc(messages.createdAt))
      .limit(PAGE);
    await this.db
      .insert(conversationMembers)
      .values({ conversationId, userId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [conversationMembers.conversationId, conversationMembers.userId],
        set: { lastReadAt: now },
      });
    const ordered = after ? rows : rows.reverse();
    return {
      id: conversationId,
      type: convo.type,
      messages: ordered.map((m) => ({ ...m, mine: m.senderId === userId })),
    };
  }

  /**
   * Sends a text message. A phone number triggers a safety warning first (Foundation 4.6): the message is only
   * sent once the sender confirms, and it is marked so moderators can see numbers were shared.
   */
  async send(
    userId: string,
    conversationId: string,
    input: { body: string; confirmPhone?: boolean },
    now = new Date(),
  ) {
    const convo = await this.assertMember(userId, conversationId);
    const body = input.body.trim();
    if (!body) throw new ChatError('EMPTY', 'Type a message first.');
    const hasPhone = containsPhoneNumber(body);
    if (hasPhone && !input.confirmPhone) {
      throw new ChatError(
        'PHONE_WARNING',
        'This looks like a phone number. For your safety, keep chatting in SportsLink until you know the other players. Send it anyway?',
      );
    }
    const sent = await this.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(messages)
        .values({ conversationId, senderId: userId, kind: 'text', body, flaggedPhone: hasPhone, createdAt: now })
        .returning({ id: messages.id, createdAt: messages.createdAt });
      if (hasPhone) {
        await tx.insert(auditLog).values({
          actorType: 'user',
          actorId: userId,
          action: 'chat.phone_number_shared',
          targetType: 'conversation',
          targetId: conversationId,
          after: { messageId: m!.id },
        });
      }
      await tx
        .insert(conversationMembers)
        .values({ conversationId, userId, lastReadAt: now })
        .onConflictDoUpdate({
          target: [conversationMembers.conversationId, conversationMembers.userId],
          set: { lastReadAt: now },
        });
      return m!;
    });
    if (this.notes) {
      const [sender] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      // One unread chat notification per conversation; the chat itself shows every message.
      await this.notes.notify(await this.recipients(convo, userId), {
        kind: 'chat',
        title: `New message from ${sender?.name ?? 'a player'}`,
        body: body.length > 80 ? `${body.slice(0, 77)}...` : body,
        link: `/chats/${conversationId}`,
        refId: conversationId,
        collapse: true,
      });
    }
    return sent;
  }

  /** Everyone in the chat except the sender and anyone who has blocked them. */
  private async recipients(c: typeof conversations.$inferSelect, senderId: string) {
    let ids: string[] = [];
    if (c.type === 'find_players') {
      ids = await this.findMembers(c.refId!);
    } else if (c.type === 'team') {
      const members = await this.db
        .select({ id: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, c.refId!), eq(teamMembers.status, 'active')));
      ids = members.map((x) => x.id);
    } else if (c.type === 'match') {
      const [m] = await this.db.select({ hostId: matches.hostId }).from(matches).where(eq(matches.id, c.refId!));
      const players = await this.db
        .select({ id: matchPlayers.userId })
        .from(matchPlayers)
        .where(and(eq(matchPlayers.matchId, c.refId!), inArray(matchPlayers.status, [...PLAYING])));
      ids = [m?.hostId, ...players.map((p) => p.id)].filter((x): x is string => !!x);
    } else {
      const [b] = await this.db
        .select({ createdBy: bookings.createdBy, vendorId: branches.vendorId, branchId: branches.id })
        .from(bookings)
        .innerJoin(courts, eq(courts.id, bookings.courtId))
        .innerJoin(branches, eq(branches.id, courts.branchId))
        .where(eq(bookings.id, c.refId!));
      if (b) ids = [b.createdBy!, ...(await this.notes!.vendorRecipients(b.vendorId, 'view_bookings', b.branchId))];
    }
    const blockers = await this.db.select({ id: blocks.blockerId }).from(blocks).where(eq(blocks.blockedId, senderId));
    return ids.filter((id) => id !== senderId && !blockers.some((x) => x.id === id));
  }

  /** Report a chat: the last messages are attached for the moderators, who can only read reported chats (spec 14). */
  async report(userId: string, conversationId: string, input: { reason: string; details?: string }) {
    await this.assertMember(userId, conversationId);
    const recent = await this.db
      .select({ id: messages.id, senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(REPORT_CONTEXT);
    const [me] = await this.db.select({ isMinor: users.isMinor }).from(users).where(eq(users.id, userId));
    const [r] = await this.db
      .insert(reports)
      .values({
        reporterId: userId,
        targetType: 'conversation',
        targetId: conversationId,
        reason: input.reason,
        details: input.details ?? null,
        evidence: { messages: recent.reverse() },
        involvesMinor: me?.isMinor ?? false,
      })
      .returning({ id: reports.id });
    return { id: r!.id };
  }

  /** Blocked people cannot message or see each other's activity (spec 10); their chat messages are hidden. */
  async block(userId: string, otherId: string) {
    if (userId === otherId) throw new ChatError('BLOCKED', 'You cannot block yourself.');
    const [other] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, otherId));
    if (!other) throw new ChatError('NOT_FOUND', 'Person not found.');
    await this.db.insert(blocks).values({ blockerId: userId, blockedId: otherId }).onConflictDoNothing();
    return { blocked: true };
  }

  async unblock(userId: string, otherId: string) {
    await this.db.delete(blocks).where(and(eq(blocks.blockerId, userId), eq(blocks.blockedId, otherId)));
    return { blocked: false };
  }

  // ---------- access ----------

  private async getOrCreate(type: 'match' | 'booking' | 'team' | 'find_players', refId: string) {
    const [existing] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.type, type), eq(conversations.refId, refId)));
    if (existing) return existing.id;
    // Two people opening the chat at once: the unique index keeps one conversation.
    await this.db.insert(conversations).values({ type, refId }).onConflictDoNothing();
    const [created] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.type, type), eq(conversations.refId, refId)));
    return created!.id;
  }

  /** Membership is worked out from the match or booking each time, so leaving a match removes access at once. */
  private async assertMember(userId: string, conversationId: string) {
    const [c] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!c?.refId) throw new ChatError('NOT_FOUND', 'Chat not found.');
    if (c.type === 'match') await this.assertMatchMember(userId, c.refId);
    else if (c.type === 'booking') await this.assertBookingMember(userId, c.refId);
    else if (c.type === 'team') await this.assertTeamMember(userId, c.refId);
    else if (c.type === 'find_players') await this.assertFindMember(userId, c.refId);
    else throw new ChatError('NOT_FOUND', 'Chat not found.');
    return c;
  }

  private async assertMatchMember(userId: string, matchId: string) {
    const [m] = await this.db
      .select({ hostId: matches.hostId, playerStatus: matchPlayers.status })
      .from(matches)
      .leftJoin(matchPlayers, and(eq(matchPlayers.matchId, matches.id), eq(matchPlayers.userId, userId)))
      .where(eq(matches.id, matchId));
    const ok =
      m && (m.hostId === userId || (m.playerStatus && (PLAYING as readonly string[]).includes(m.playerStatus)));
    if (!ok) throw new ChatError('NOT_FOUND', 'Chat not found.');
  }

  /** Open while the request lives, and for find.chat_hours_after_close after it closes or expires (spec 9.3). */
  private async findMembers(requestId: string, now = new Date()) {
    const [r] = await this.db.select().from(findRequests).where(eq(findRequests.id, requestId));
    if (!r) return [];
    const hours = await getSetting(this.db, 'find.chat_hours_after_close');
    const ended = r.closedAt ?? (r.windowEnd < now ? r.windowEnd : null);
    if (ended && now.getTime() > ended.getTime() + hours * 3_600_000) return [];
    const picked = await this.db
      .select({ id: findResponses.userId })
      .from(findResponses)
      .where(and(eq(findResponses.requestId, requestId), eq(findResponses.status, 'selected')));
    return [r.requesterId, ...picked.map((p) => p.id)];
  }

  private async assertFindMember(userId: string, requestId: string) {
    if (!(await this.findMembers(requestId)).includes(userId)) throw new ChatError('NOT_FOUND', 'Chat not found.');
  }

  private async assertTeamMember(userId: string, teamId: string) {
    const [m] = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          eq(teamMembers.status, 'active'),
          eq(teams.status, 'active'),
        ),
      );
    if (!m) throw new ChatError('NOT_FOUND', 'Chat not found.');
  }

  private async assertBookingMember(userId: string, bookingId: string) {
    const [b] = await this.db
      .select({ createdBy: bookings.createdBy, source: bookings.source, branchId: courts.branchId })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .where(eq(bookings.id, bookingId));
    if (!b || b.source !== 'app') throw new ChatError('NOT_FOUND', 'Chat not found.');
    // Foundation 10.2 safeguard (setting): minors chat only in match group chats, not privately with adults.
    const [booker] = await this.db.select({ isMinor: users.isMinor }).from(users).where(eq(users.id, b.createdBy!));
    if (booker?.isMinor && (await getSetting(this.db, 'minors.block_private_chat'))) {
      throw new ChatError('NOT_FOUND', 'Private chats are not available for players under 18.');
    }
    if (b.createdBy === userId) return;
    const { branchIds } = await vendorAccess(this.db, userId, 'view_bookings');
    if (!branchIds.includes(b.branchId)) throw new ChatError('NOT_FOUND', 'Chat not found.');
  }

  private async titles(rows: { id: string; type: string; refId: string | null }[]) {
    const out = new Map<string, string>();
    const matchRefs = rows.filter((r) => r.type === 'match').map((r) => r.refId!);
    const bookingRefs = rows.filter((r) => r.type === 'booking').map((r) => r.refId!);
    const ms = matchRefs.length
      ? await this.db
          .select({
            id: matches.id,
            sport: sports.name,
            venue: sql<string>`coalesce(${branches.name}, ${matches.unlistedVenueName})`,
          })
          .from(matches)
          .innerJoin(sports, eq(sports.id, matches.sportId))
          .leftJoin(bookings, eq(bookings.id, matches.bookingId))
          .leftJoin(courts, eq(courts.id, bookings.courtId))
          .leftJoin(branches, eq(branches.id, courts.branchId))
          .where(inArray(matches.id, matchRefs))
      : [];
    const bs = bookingRefs.length
      ? await this.db
          .select({ id: bookings.id, venue: branches.name, court: courts.name })
          .from(bookings)
          .innerJoin(courts, eq(courts.id, bookings.courtId))
          .innerJoin(branches, eq(branches.id, courts.branchId))
          .where(inArray(bookings.id, bookingRefs))
      : [];
    const teamRefs = rows.filter((r) => r.type === 'team').map((r) => r.refId!);
    const ts = teamRefs.length
      ? await this.db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamRefs))
      : [];
    const findRefs = rows.filter((r) => r.type === 'find_players').map((r) => r.refId!);
    const fs = findRefs.length
      ? await this.db
          .select({ id: findRequests.id, sport: sports.name })
          .from(findRequests)
          .innerJoin(sports, eq(sports.id, findRequests.sportId))
          .where(inArray(findRequests.id, findRefs))
      : [];
    for (const r of rows) {
      const f = fs.find((x) => x.id === r.refId);
      if (f) out.set(r.id, `Find Players · ${f.sport}`);
      const t = ts.find((x) => x.id === r.refId);
      if (t) out.set(r.id, `Team · ${t.name}`);
      const m = ms.find((x) => x.id === r.refId);
      const b = bs.find((x) => x.id === r.refId);
      if (m) out.set(r.id, `${m.sport} match · ${m.venue}`);
      if (b) out.set(r.id, `Booking · ${b.venue}, ${b.court}`);
    }
    return out;
  }
}
