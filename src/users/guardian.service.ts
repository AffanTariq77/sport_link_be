import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, or } from 'drizzle-orm';
import { normalisePhone } from '../auth/phone.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  auditLog,
  bookings,
  branches,
  courts,
  matches,
  matchPlayers,
  sports,
  users,
  verifications,
} from '../db/schema.js';
import { getSetting } from '../settings.js';

export class GuardianError extends Error {
  constructor(
    public readonly code: 'NOT_MINOR' | 'NOT_FOUND' | 'GUARDIAN_NOT_VERIFIED' | 'WRONG_VERSION',
    message: string,
  ) {
    super(message);
  }
}

// Shown to the guardian before they accept; changing it means a new `minors.consent_version`.
const CONSENT_TEXT: Record<string, string> = {
  '2026-09-v1': [
    'I am the parent or legal guardian of this player and I allow them to use SportsLink.',
    'I understand they may book venues, join matches and chat with other players in match group chats, and that they will meet people in person.',
    'I will see their bookings and matches in my account. I can withdraw my consent at any time by contacting SportsLink.',
    'I accept responsibility for their use of SportsLink under the terms of use.',
  ].join('\n\n'),
};

/** Guardian consent for players under 18 (spec 5, Foundation 10.2). */
@Injectable()
export class GuardianService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  async consentText() {
    const version = await getSetting(this.db, 'minors.consent_version');
    return { version, text: CONSENT_TEXT[version] ?? '' };
  }

  /** The minor names their parent or guardian by the phone number of the guardian's SportsLink account. */
  async requestGuardian(minorId: string, phone: string) {
    const [me] = await this.db.select({ isMinor: users.isMinor }).from(users).where(eq(users.id, minorId));
    if (!me?.isMinor) throw new GuardianError('NOT_MINOR', 'Only players under 18 need a guardian.');
    const parsed = normalisePhone(phone);
    const [guardian] = parsed
      ? await this.db.select({ id: users.id, isMinor: users.isMinor }).from(users).where(eq(users.phone, parsed.phone))
      : [];
    if (!guardian || guardian.isMinor || guardian.id === minorId) {
      throw new GuardianError(
        'NOT_FOUND',
        'Ask your parent or guardian to sign up to SportsLink first, then enter their number.',
      );
    }
    await this.db
      .update(users)
      .set({
        guardianUserId: guardian.id,
        guardianConsentAt: null,
        guardianConsentVersion: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, minorId));
    const [minor] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, minorId));
    await this.notes?.notify(guardian.id, {
      kind: 'guardian',
      title: 'Guardian request',
      body: `${minor?.name ?? 'A player'} named you as their parent or guardian. Review and give consent.`,
      link: `/family/${minorId}`,
      refId: minorId,
    });
    return { status: 'pending' as const };
  }

  async myGuardian(minorId: string) {
    const [me] = await this.db
      .select({ guardianId: users.guardianUserId, consentAt: users.guardianConsentAt, isMinor: users.isMinor })
      .from(users)
      .where(eq(users.id, minorId));
    if (!me?.isMinor) return { status: 'not_needed' as const, guardianName: null };
    if (!me.guardianId) return { status: 'none' as const, guardianName: null };
    const [g] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, me.guardianId));
    return { status: me.consentAt ? ('accepted' as const) : ('pending' as const), guardianName: g?.name ?? null };
  }

  /** Children who named this user as their guardian, with their consent status. */
  async wards(guardianId: string) {
    return this.db
      .select({ id: users.id, name: users.name, dob: users.dob, consentAt: users.guardianConsentAt })
      .from(users)
      .where(and(eq(users.guardianUserId, guardianId), eq(users.isMinor, true)))
      .orderBy(asc(users.name));
  }

  /**
   * Guardian accepts in their own account. They must have an approved CNIC (spec 5); the consent text version and
   * time are stored and logged.
   */
  async decide(guardianId: string, minorId: string, input: { accept: boolean; version?: string }, now = new Date()) {
    const [minor] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, minorId), eq(users.guardianUserId, guardianId), eq(users.isMinor, true)));
    if (!minor) throw new GuardianError('NOT_FOUND', 'Request not found.');
    if (!input.accept) {
      await this.db
        .update(users)
        .set({ guardianUserId: null, guardianConsentAt: null, guardianConsentVersion: null, updatedAt: now })
        .where(eq(users.id, minorId));
      await this.notes?.notify(minorId, {
        kind: 'guardian',
        title: 'Guardian declined',
        body: 'Your guardian declined the request. Ask them again or name someone else.',
        link: '/',
      });
      return { status: 'declined' as const };
    }
    const [cnic] = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(
        and(
          eq(verifications.userId, guardianId),
          eq(verifications.docType, 'cnic'),
          eq(verifications.status, 'approved'),
        ),
      )
      .limit(1);
    if (!cnic) {
      throw new GuardianError(
        'GUARDIAN_NOT_VERIFIED',
        'Verify your own identity with your CNIC first. Our team checks it before you can approve.',
      );
    }
    const version = await getSetting(this.db, 'minors.consent_version');
    if (input.version !== version)
      throw new GuardianError('WRONG_VERSION', 'The consent text has changed. Please read it again.');
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ guardianConsentAt: now, guardianConsentVersion: version, updatedAt: now })
        .where(eq(users.id, minorId));
      await tx.insert(auditLog).values({
        actorType: 'user',
        actorId: guardianId,
        action: 'guardian.consent',
        targetType: 'user',
        targetId: minorId,
        after: { version },
      });
    });
    await this.notes?.notify(minorId, {
      kind: 'guardian',
      title: 'Guardian consent given',
      body: 'Your guardian gave consent. You can now book and join matches.',
      link: '/',
    });
    return { status: 'accepted' as const };
  }

  /** What a guardian sees of a child's activity (Foundation 3): upcoming bookings and matches. */
  async wardActivity(guardianId: string, minorId: string, now = new Date()) {
    const [minor] = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, minorId), eq(users.guardianUserId, guardianId), isNotNull(users.guardianConsentAt)));
    if (!minor) throw new GuardianError('NOT_FOUND', 'Not found.');
    const upcoming = await this.db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        status: bookings.status,
        venue: branches.name,
        court: courts.name,
        timezone: branches.timezone,
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(
        and(
          eq(bookings.createdBy, minorId),
          gt(bookings.endAt, now),
          inArray(bookings.status, ['held', 'pending_payment', 'confirmed']),
        ),
      )
      .orderBy(asc(bookings.startAt));
    const games = await this.db
      .select({
        id: matches.id,
        startAt: matches.startAt,
        sport: sports.name,
        status: matchPlayers.status,
        hostId: matches.hostId,
      })
      .from(matches)
      .innerJoin(sports, eq(sports.id, matches.sportId))
      .leftJoin(matchPlayers, and(eq(matchPlayers.matchId, matches.id), eq(matchPlayers.userId, minorId)))
      .where(
        and(
          gt(matches.endAt, now),
          or(eq(matches.hostId, minorId), inArray(matchPlayers.status, ['requested', 'approved', 'confirmed'])),
        ),
      )
      .orderBy(asc(matches.startAt));
    return {
      minor,
      bookings: upcoming,
      matches: games.map((g) => ({
        id: g.id,
        startAt: g.startAt,
        sport: g.sport,
        role: g.hostId === minorId ? 'host' : (g.status ?? 'player'),
      })),
    };
  }

  /** Daily: a minor who turns 18 leaves guardianship and verifies again with a CNIC (spec 5). */
  async endGuardianshipAt18(now = new Date()) {
    const minors = await this.db
      .select({ id: users.id, dob: users.dob })
      .from(users)
      .where(and(eq(users.isMinor, true), isNotNull(users.dob)));
    const adults = minors.filter((m) => {
      const [y, mo, d] = m.dob!.split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y + 18, mo - 1, d)) <= now;
    });
    for (const a of adults) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            isMinor: false,
            guardianUserId: null,
            guardianConsentAt: null,
            guardianConsentVersion: null,
            updatedAt: now,
          })
          .where(eq(users.id, a.id));
        // The B-Form stops counting; they are asked to verify with their CNIC.
        await tx
          .update(verifications)
          .set({ status: 'rejected', rejectionReason: 'You are 18 now. Please verify with your CNIC.', updatedAt: now })
          .where(
            and(
              eq(verifications.userId, a.id),
              eq(verifications.docType, 'b_form'),
              inArray(verifications.status, ['pending', 'approved']),
            ),
          );
        await tx
          .insert(auditLog)
          .values({ actorType: 'system', action: 'user.turned_18', targetType: 'user', targetId: a.id });
      });
    }
    return { turned18: adults.length };
  }
}
