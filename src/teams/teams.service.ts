import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, lt, ne, notInArray, or } from 'drizzle-orm';
import { audit } from '../admin/audit.js';
import { normalisePhone } from '../auth/phone.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import {
  matchResults,
  matches,
  reports,
  sports,
  teamMembers,
  teamRatings,
  teams,
  tournamentEntries,
  tournaments,
  users,
} from '../db/schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { tierFor } from '../ratings/players.service.js';
import { getSetting } from '../settings.js';

export class TeamError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_CAPTAIN'
      | 'INVALID_TEAM'
      | 'ALREADY_MEMBER'
      | 'NOT_INVITED'
      | 'CAPTAIN_LEAVING'
      | 'ROSTER_LOCKED',
    message: string,
  ) {
    super(message);
  }
}

type Role = 'captain' | 'vice_captain' | 'member';
const LEADERS: Role[] = ['captain', 'vice_captain'];

/**
 * Teams for one sport (spec 12.1). The captain (or vice captain) invites existing players by phone; the invitee
 * accepts. The captain can hand the role over. Phone numbers are only used to find the player, never returned.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  async create(userId: string, input: { sport: string; name: string; city?: string }) {
    const [sport] = await this.db.select({ id: sports.id }).from(sports).where(eq(sports.slug, input.sport));
    if (!sport) throw new TeamError('INVALID_TEAM', 'Choose a sport from the list.');
    return this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(teams)
        .values({ sportId: sport.id, name: input.name.trim(), city: input.city?.trim() || null, captainId: userId })
        .returning({ id: teams.id });
      await tx.insert(teamMembers).values({ teamId: t!.id, userId, role: 'captain', status: 'active' });
      return { id: t!.id };
    });
  }

  /** Teams the user plays for or is invited to. */
  mine(userId: string) {
    return this.db
      .select({
        id: teams.id,
        name: teams.name,
        sport: sports.name,
        city: teams.city,
        role: teamMembers.role,
        status: teamMembers.status,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(sports, eq(sports.id, teams.sportId))
      .where(
        and(
          eq(teamMembers.userId, userId),
          inArray(teamMembers.status, ['invited', 'active']),
          eq(teams.status, 'active'),
        ),
      )
      .orderBy(asc(teams.name));
  }

  /** Browse teams to challenge. */
  list(filter: { sport?: string; q?: string }) {
    return this.db
      .select({ id: teams.id, name: teams.name, sport: sports.name, city: teams.city })
      .from(teams)
      .innerJoin(sports, eq(sports.id, teams.sportId))
      .where(
        and(
          eq(teams.status, 'active'),
          filter.sport ? eq(sports.slug, filter.sport) : undefined,
          filter.q ? ilike(teams.name, `%${filter.q.replace(/[%_]/g, '')}%`) : undefined,
        ),
      )
      .orderBy(asc(teams.name))
      .limit(50);
  }

  /** Team page: roster, team rating and recent team matches (spec 12.1). */
  async get(userId: string | null, teamId: string) {
    const [t] = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        city: teams.city,
        status: teams.status,
        sport: sports.name,
        sportSlug: sports.slug,
        captainId: teams.captainId,
      })
      .from(teams)
      .innerJoin(sports, eq(sports.id, teams.sportId))
      .where(eq(teams.id, teamId));
    if (!t || t.status !== 'active') throw new TeamError('NOT_FOUND', 'Team not found.');
    const roster = await this.db
      .select({ id: users.id, name: users.name, role: teamMembers.role, status: teamMembers.status })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.status, ['invited', 'active'])))
      .orderBy(asc(teamMembers.createdAt));
    const me = roster.find((m) => m.id === userId);
    const leader = me?.status === 'active' && LEADERS.includes(me.role);
    const [r] = await this.db.select().from(teamRatings).where(eq(teamRatings.teamId, teamId));
    const [tiers, provisional] = [
      await getSetting(this.db, 'rating.tiers'),
      await getSetting(this.db, 'rating.provisional_deviation'),
    ];
    const history = await this.db
      .select({
        id: matches.id,
        startAt: matches.startAt,
        status: matches.status,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        outcome: matchResults.outcome,
        score: matchResults.score,
      })
      .from(matches)
      .leftJoin(matchResults, and(eq(matchResults.matchId, matches.id), eq(matchResults.status, 'confirmed')))
      .where(or(eq(matches.homeTeamId, teamId), eq(matches.awayTeamId, teamId)))
      .orderBy(desc(matches.startAt))
      .limit(20);
    const opponentIds = [...new Set(history.map((h) => (h.homeTeamId === teamId ? h.awayTeamId : h.homeTeamId)))];
    const opponents = opponentIds.filter(Boolean).length
      ? await this.db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(
            inArray(
              teams.id,
              opponentIds.filter((x): x is string => !!x),
            ),
          )
      : [];
    return {
      id: t.id,
      name: t.name,
      city: t.city,
      sport: t.sport,
      sportSlug: t.sportSlug,
      myRole: me?.status === 'active' ? me.role : null,
      invited: me?.status === 'invited',
      members: roster
        .filter((m) => m.status === 'active' || leader)
        .map((m) => ({ id: m.id, name: m.name ?? 'Player', role: m.role, status: m.status })),
      rating: r
        ? {
            rating: Math.round(r.rating),
            provisional: r.deviation > provisional,
            tier: r.deviation > provisional ? null : tierFor(r.rating, tiers),
            games: r.games,
          }
        : null,
      matches: history.map((h) => {
        const home = h.homeTeamId === teamId;
        const opponent = home ? h.awayTeamId : h.homeTeamId;
        const won = h.outcome && h.outcome !== 'draw' ? (h.outcome === 'a') === home : null;
        return {
          id: h.id,
          startAt: h.startAt,
          status: h.status,
          opponent: opponents.find((o) => o.id === opponent)?.name ?? null,
          result:
            h.outcome === 'draw' ? ('draw' as const) : won === null ? null : won ? ('won' as const) : ('lost' as const),
          score: h.score,
        };
      }),
    };
  }

  async invite(userId: string, teamId: string, phone: string) {
    const t = await this.leaderOf(userId, teamId);
    const parsed = normalisePhone(phone);
    const [u] = parsed ? await this.db.select({ id: users.id }).from(users).where(eq(users.phone, parsed.phone)) : [];
    if (!u) throw new TeamError('NOT_FOUND', 'No SportsLink account has this number. Ask them to sign up first.');
    const [existing] = await this.db
      .select({ status: teamMembers.status })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, u.id)));
    if (existing && ['invited', 'active'].includes(existing.status))
      throw new TeamError('ALREADY_MEMBER', 'This player is already in the team or invited.');
    await this.db
      .insert(teamMembers)
      .values({ teamId, userId: u.id, invitedBy: userId, status: 'invited', role: 'member' })
      .onConflictDoUpdate({
        target: [teamMembers.teamId, teamMembers.userId],
        set: { status: 'invited', role: 'member', invitedBy: userId, updatedAt: new Date() },
      });
    await this.notes?.notify(u.id, {
      kind: 'match',
      title: 'Team invite',
      body: `You are invited to join ${t.name}.`,
      link: `/teams/${teamId}`,
      refId: teamId,
    });
    return { ok: true };
  }

  async respond(userId: string, teamId: string, accept: boolean) {
    const [m] = await this.db
      .select({ status: teamMembers.status, invitedBy: teamMembers.invitedBy, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), eq(teams.status, 'active')));
    if (m?.status !== 'invited') throw new TeamError('NOT_INVITED', 'There is no invite to answer.');
    await this.db
      .update(teamMembers)
      .set({ status: accept ? 'active' : 'declined', updatedAt: new Date() })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    if (accept) {
      const [u] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      await this.notes?.notify(m.invitedBy, {
        kind: 'match',
        title: 'Invite accepted',
        body: `${u?.name ?? 'A player'} joined ${m.name}.`,
        link: `/teams/${teamId}`,
        refId: teamId,
      });
    }
    return { ok: true };
  }

  /** A member leaves. The captain hands over first, unless they are the last member (the team is disbanded). */
  async leave(userId: string, teamId: string) {
    const t = await this.team(teamId);
    const active = await this.activeMembers(teamId);
    if (!active.some((m) => m.userId === userId)) throw new TeamError('NOT_FOUND', 'You are not in this team.');
    if (t.captainId === userId && active.length > 1)
      throw new TeamError('CAPTAIN_LEAVING', 'Make someone else captain before you leave.');
    await this.assertRosterOpen(teamId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(teamMembers)
        .set({ status: 'left', updatedAt: new Date() })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      if (active.length === 1)
        await tx.update(teams).set({ status: 'disbanded', updatedAt: new Date() }).where(eq(teams.id, teamId));
    });
    return { ok: true };
  }

  /** Captain or vice captain removes a member or cancels an invite. Nobody removes the captain. */
  async remove(userId: string, teamId: string, memberId: string) {
    const t = await this.leaderOf(userId, teamId);
    if (memberId === t.captainId || memberId === userId)
      throw new TeamError('NOT_CAPTAIN', 'The captain cannot be removed. Leave the team instead.');
    const [m] = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, memberId),
          inArray(teamMembers.status, ['invited', 'active']),
        ),
      );
    if (!m) throw new TeamError('NOT_FOUND', 'Member not found.');
    if (m.role === 'vice_captain' && t.captainId !== userId)
      throw new TeamError('NOT_CAPTAIN', 'Only the captain can remove the vice captain.');
    await this.assertRosterOpen(teamId);
    await this.db
      .update(teamMembers)
      .set({ status: 'removed', role: 'member', updatedAt: new Date() })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, memberId)));
    return { ok: true };
  }

  /** Captain only. Making someone captain hands the role over; the old captain becomes vice captain. */
  async setRole(userId: string, teamId: string, memberId: string, role: Role) {
    const t = await this.team(teamId);
    if (t.captainId !== userId) throw new TeamError('NOT_CAPTAIN', 'Only the captain can change roles.');
    if (memberId === userId) throw new TeamError('INVALID_TEAM', 'Choose another member.');
    const active = await this.activeMembers(teamId);
    if (!active.some((m) => m.userId === memberId)) throw new TeamError('NOT_FOUND', 'Member not found.');
    await this.db.transaction(async (tx) => {
      if (role === 'captain') {
        await this.handOver(tx, teamId, memberId, userId);
      } else {
        await tx
          .update(teamMembers)
          .set({ role, updatedAt: new Date() })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, memberId)));
      }
    });
    return { ok: true };
  }

  /**
   * Job: a banned captain is replaced by the vice captain (spec 12.1). Without one, the team is reported for an
   * admin to assign a captain.
   */
  async replaceBannedCaptains() {
    const stuck = await this.db
      .select({ id: teams.id, captainId: teams.captainId, name: teams.name })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.captainId))
      .where(and(eq(teams.status, 'active'), inArray(users.status, ['banned', 'deleted'])));
    let replaced = 0;
    for (const t of stuck) {
      const [vice] = await this.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            eq(teamMembers.teamId, t.id),
            eq(teamMembers.status, 'active'),
            eq(teamMembers.role, 'vice_captain'),
            eq(users.status, 'active'),
          ),
        )
        .limit(1);
      if (vice) {
        await this.db.transaction((tx) => this.handOver(tx, t.id, vice.userId, t.captainId, 'member'));
        replaced++;
        continue;
      }
      const [open] = await this.db
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(eq(reports.targetId, t.id), eq(reports.reason, 'team_without_captain'), ne(reports.status, 'actioned')),
        )
        .limit(1);
      if (!open)
        await this.db.insert(reports).values({
          targetType: 'team',
          targetId: t.id,
          reason: 'team_without_captain',
          details: `${t.name}: the captain is banned and there is no vice captain. Assign a new captain.`,
        });
    }
    return { captainsReplaced: replaced };
  }

  /** Admin assigns a captain (spec 12.1 edge case), logged in the same transaction. */
  async assignCaptain(teamId: string, memberId: string, actor: { adminId: string; ip?: string | null }) {
    const t = await this.team(teamId);
    const active = await this.activeMembers(teamId);
    if (!active.some((m) => m.userId === memberId)) throw new TeamError('NOT_FOUND', 'Member not found.');
    await this.db.transaction(async (tx) => {
      await this.handOver(tx, teamId, memberId, t.captainId, 'member');
      await audit(tx, {
        actorId: actor.adminId,
        action: 'team.assign_captain',
        targetType: 'team',
        targetId: teamId,
        before: { captainId: t.captainId },
        after: { captainId: memberId },
        ip: actor.ip,
      });
    });
    return { ok: true };
  }

  /** True if the user is an active member of the team. */
  async isMember(userId: string, teamId: string) {
    return (await this.activeMembers(teamId)).some((m) => m.userId === userId);
  }

  // ---------- helpers ----------

  /** In a tournament whose registration has closed the roster is locked, unless an admin allowed changes (12.1). */
  private async assertRosterOpen(teamId: string, now = new Date()) {
    const [locked] = await this.db
      .select({ id: tournamentEntries.id })
      .from(tournamentEntries)
      .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
      .where(
        and(
          eq(tournamentEntries.teamId, teamId),
          inArray(tournamentEntries.status, ['pending_payment', 'submitted', 'confirmed']),
          eq(tournamentEntries.rosterUnlocked, false),
          lt(tournaments.registrationDeadline, now),
          notInArray(tournaments.status, ['completed', 'cancelled']),
        ),
      )
      .limit(1);
    if (locked)
      throw new TeamError(
        'ROSTER_LOCKED',
        'The team is in a tournament, so the roster is locked. Ask SportsLink support.',
      );
  }

  private async handOver(
    tx: Pick<Db, 'update'>,
    teamId: string,
    to: string,
    from: string,
    fromRole: Role = 'vice_captain',
  ) {
    await tx
      .update(teamMembers)
      .set({ role: fromRole, updatedAt: new Date() })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, from)));
    await tx
      .update(teamMembers)
      .set({ role: 'captain', updatedAt: new Date() })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, to)));
    await tx.update(teams).set({ captainId: to, updatedAt: new Date() }).where(eq(teams.id, teamId));
  }

  private async team(teamId: string) {
    const [t] = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.status, 'active')));
    if (!t) throw new TeamError('NOT_FOUND', 'Team not found.');
    return t;
  }

  private activeMembers(teamId: string) {
    return this.db
      .select({ userId: teamMembers.userId, role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.status, 'active')));
  }

  /** The team, if the user is its captain or vice captain. */
  async leaderOf(userId: string, teamId: string) {
    const t = await this.team(teamId);
    const [m] = await this.db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), eq(teamMembers.status, 'active')));
    if (!m || !LEADERS.includes(m.role))
      throw new TeamError('NOT_CAPTAIN', 'Only the captain or vice captain can do this.');
    return t;
  }
}
