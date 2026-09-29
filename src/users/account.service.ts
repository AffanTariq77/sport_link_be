import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { audit } from '../admin/audit.js';
import { AuthService } from '../auth/auth.service.js';
import { normalisePhone } from '../auth/phone.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode } from '../db/errors.js';
import {
  auditLog,
  bookings,
  branches,
  devices,
  matches,
  matchPlayers,
  playerAvailability,
  reports,
  sessions,
  teamMembers,
  teams,
  users,
  vendors,
  verifications,
} from '../db/schema.js';
import { STORAGE, type FileStorage } from '../verification/storage.js';

export class AccountError extends Error {
  constructor(
    public readonly code: 'INVALID_PHONE' | 'SAME_PHONE' | 'PHONE_TAKEN' | 'NOT_FOUND' | 'HAS_COMMITMENTS',
    message: string,
  ) {
    super(message);
  }
}

type Actor = { adminId: string; ip?: string | null };

/** Phone number change and account deletion (spec 5 edge cases). */
@Injectable()
export class AccountService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(STORAGE) private readonly storage: FileStorage,
  ) {}

  // ---------- phone number change ----------

  /** Sends a code to the current number and to the new one; both must be entered to switch. */
  async startPhoneChange(userId: string, newPhone: string, now = new Date()) {
    const { current, next } = await this.phones(userId, newPhone);
    await this.auth.requestOtp({ phone: current, now });
    await this.auth.requestOtp({ phone: next, now });
    return { ok: true };
  }

  async confirmPhoneChange(
    userId: string,
    input: { newPhone: string; oldCode: string; newCode: string },
    now = new Date(),
  ) {
    const { current, next } = await this.phones(userId, input.newPhone);
    await this.auth.consumeCode(current, input.oldCode, now);
    await this.auth.consumeCode(next, input.newCode, now);
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(users).set({ phone: next, updatedAt: now }).where(eq(users.id, userId));
        await tx.insert(auditLog).values({
          actorType: 'user',
          actorId: userId,
          action: 'user.phone_change',
          targetType: 'user',
          targetId: userId,
          after: { verifiedBoth: true },
        });
      });
    } catch (err) {
      if (hasPgCode(err, '23505'))
        throw new AccountError('PHONE_TAKEN', 'That number already has a SportsLink account.');
      throw err;
    }
    return { ok: true };
  }

  /** Lost the old number: support checks the request and changes it (spec 5). */
  async requestPhoneReview(userId: string, input: { newPhone: string; reason: string }) {
    const { next } = await this.phones(userId, input.newPhone);
    await this.db.insert(reports).values({
      reporterId: userId,
      targetType: 'user',
      targetId: userId,
      reason: 'phone_change_review',
      details: input.reason.trim(),
      evidence: { newPhone: next },
    });
    return { ok: true };
  }

  /** Admin sets the number after reviewing a lost-number request. Sessions end so the new number signs in. */
  async adminChangePhone(userId: string, newPhone: string, actor: Actor, now = new Date()) {
    const parsed = normalisePhone(newPhone);
    if (!parsed) throw new AccountError('INVALID_PHONE', 'Enter a Pakistani mobile number, for example 0300 1234567.');
    const [u] = await this.db.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
    if (!u) throw new AccountError('NOT_FOUND', 'User not found.');
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(users).set({ phone: parsed.phone, updatedAt: now }).where(eq(users.id, userId));
        await tx
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
        await audit(tx, {
          actorId: actor.adminId,
          action: 'user.phone_change',
          targetType: 'user',
          targetId: userId,
          before: { phone: u.phone },
          after: { phone: parsed.phone },
          ip: actor.ip,
        });
      });
    } catch (err) {
      if (hasPgCode(err, '23505'))
        throw new AccountError('PHONE_TAKEN', 'That number already has a SportsLink account.');
      throw err;
    }
    return { ok: true };
  }

  // ---------- deletion ----------

  /**
   * Deletes the account (spec 5): personal data and ID images are removed; bookings, invoices, results and audit
   * records stay, anonymised. Upcoming bookings, hosted matches, venues and captaincy must be dealt with first.
   */
  async deleteAccount(userId: string, now = new Date()) {
    const blockers: string[] = [];
    const [booking] = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.createdBy, userId),
          eq(bookings.source, 'app'),
          inArray(bookings.status, ['held', 'pending_payment', 'confirmed']),
          gt(bookings.endAt, now),
        ),
      )
      .limit(1);
    if (booking) blockers.push('cancel your upcoming bookings');
    const [hosting] = await this.db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.hostId, userId), inArray(matches.status, ['open', 'full']), gt(matches.endAt, now)))
      .limit(1);
    if (hosting) blockers.push('cancel the matches you host');
    const [venue] = await this.db
      .select({ id: branches.id })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(eq(vendors.ownerUserId, userId), inArray(branches.status, ['live', 'pending_visit'])))
      .limit(1);
    if (venue) blockers.push('contact SportsLink to close your venues');
    const captaincies = await this.db
      .select({ teamId: teams.id })
      .from(teams)
      .where(and(eq(teams.captainId, userId), eq(teams.status, 'active')));
    for (const t of captaincies) {
      const [other] = await this.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, t.teamId), eq(teamMembers.status, 'active'), ne(teamMembers.userId, userId)))
        .limit(1);
      if (other) {
        blockers.push('make someone else captain of your teams');
        break;
      }
    }
    if (blockers.length)
      throw new AccountError('HAS_COMMITMENTS', `Before deleting your account, ${blockers.join(', ')}.`);

    const docs = await this.db.select().from(verifications).where(eq(verifications.userId, userId));
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          phone: `deleted:${userId}`,
          name: 'Deleted player',
          dob: null,
          gender: null,
          city: null,
          photoKey: null,
          guardianUserId: null,
          status: 'deleted',
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      await tx
        .update(sessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await tx.delete(devices).where(eq(devices.userId, userId));
      await tx.delete(playerAvailability).where(eq(playerAvailability.userId, userId));
      await tx
        .update(teamMembers)
        .set({ status: 'left', updatedAt: now })
        .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.status, ['invited', 'active'])));
      await tx
        .update(teams)
        .set({ status: 'disbanded', updatedAt: now })
        .where(and(eq(teams.captainId, userId), eq(teams.status, 'active')));
      await tx
        .update(matchPlayers)
        .set({ status: 'withdrawn', updatedAt: now })
        .where(and(eq(matchPlayers.userId, userId), inArray(matchPlayers.status, ['requested', 'waitlisted'])));
      // ID documents: numbers and images go; the duplicate hash goes too, so the person can sign up again.
      for (const d of docs)
        await tx
          .update(verifications)
          .set({
            docNumberEncrypted: '',
            docNumberHash: `deleted:${d.id}`,
            frontKey: '',
            backKey: '',
            status: d.status === 'pending' || d.status === 'approved' ? 'rejected' : d.status,
            rejectionReason: 'Account deleted',
            updatedAt: now,
          })
          .where(eq(verifications.id, d.id));
      await tx.insert(auditLog).values({
        actorType: 'user',
        actorId: userId,
        action: 'user.delete',
        targetType: 'user',
        targetId: userId,
      });
    });
    for (const d of docs)
      for (const key of [d.frontKey, d.backKey]) if (key) await this.storage.delete(key).catch(() => undefined);
    return { ok: true };
  }

  private async phones(userId: string, newPhone: string) {
    const parsed = normalisePhone(newPhone);
    if (!parsed) throw new AccountError('INVALID_PHONE', 'Enter a Pakistani mobile number, for example 0300 1234567.');
    const [me] = await this.db.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
    if (!me) throw new AccountError('NOT_FOUND', 'Account not found.');
    if (me.phone === parsed.phone) throw new AccountError('SAME_PHONE', 'That is already your number.');
    const [taken] = await this.db.select({ id: users.id }).from(users).where(eq(users.phone, parsed.phone));
    if (taken) throw new AccountError('PHONE_TAKEN', 'That number already has a SportsLink account.');
    return { current: me.phone, next: parsed.phone };
  }
}
