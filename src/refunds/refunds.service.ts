import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { effectiveStatus } from '../bookings/bookings.service.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { bookings, bookingShares, branches, courts, matches, refunds, reports, users, vendors } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { vendorAccess } from '../vendors/access.js';

export class RefundError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_CANCELLABLE' | 'NOT_DUE' | 'NOT_SENT',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Policy = { cancelRefund?: boolean; cancelWindowHours?: number };
export type RefundReason = 'player_cancelled' | 'vendor_cancelled' | 'left_match' | 'match_cancelled';

/** The policy snapshotted on the booking decides, even if the venue changed it since (spec 6.3). */
export function refundableByPolicy(policy: Policy, startAt: Date, now: Date) {
  return !!policy.cancelRefund && startAt.getTime() - now.getTime() >= (policy.cancelWindowHours ?? 0) * 3_600_000;
}

/**
 * Records a refund for every paid (confirmed) share given, when `full` or the policy allows. Unpaid shares are
 * voided. The vendor then sends the money directly and marks it sent (Foundation 8.4).
 */
export async function refundShares(
  tx: Pick<Db, 'select' | 'insert' | 'update'>,
  input: { bookingId: string; shareIds?: string[]; reason: RefundReason; full: boolean; now: Date },
) {
  const [b] = await tx.select().from(bookings).where(eq(bookings.id, input.bookingId));
  if (!b) return { refunds: 0 };
  const shares = await tx
    .select()
    .from(bookingShares)
    .where(
      and(
        eq(bookingShares.bookingId, input.bookingId),
        input.shareIds ? (input.shareIds.length ? inArray(bookingShares.id, input.shareIds) : sql`false`) : undefined,
      ),
    );
  const unpaid = shares.filter((s) => ['pending', 'submitted', 'rejected'].includes(s.status)).map((s) => s.id);
  if (unpaid.length)
    await tx
      .update(bookingShares)
      .set({ status: 'void', updatedAt: input.now })
      .where(inArray(bookingShares.id, unpaid));
  const refundable = input.full || refundableByPolicy(b.policySnapshot as Policy, b.startAt, input.now);
  const paid = shares.filter((s) => s.status === 'confirmed' && s.advanceAmount > 0);
  if (!refundable || !paid.length) return { refunds: 0 };
  await tx
    .insert(refunds)
    .values(
      paid.map((s) => ({
        bookingId: b.id,
        shareId: s.id,
        userId: s.userId,
        currency: b.currency,
        amount: s.advanceAmount,
        reason: input.reason,
      })),
    )
    .onConflictDoNothing();
  return { refunds: paid.length };
}

@Injectable()
export class RefundsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Player cancels their own booking. A hold is simply released; paid advances follow the policy. */
  async cancelByPlayer(userId: string, bookingId: string, now = new Date()) {
    return this.db.transaction(async (tx) => {
      const b = await this.lockBooking(tx, bookingId);
      if (b.createdBy !== userId || b.source !== 'app') throw new RefundError('NOT_FOUND', 'Booking not found.');
      return this.cancel(tx, b, 'player', 'player_cancelled', false, now);
    });
  }

  /** Vendor cancels (for example rain or a closure): a full refund whatever the policy (spec 6.3, setting). */
  async cancelByVendor(userId: string, bookingId: string, reason: string, now = new Date()) {
    return this.db.transaction(async (tx) => {
      const b = await this.lockBooking(tx, bookingId);
      const { branchIds } = await vendorAccess(tx, userId, 'create_bookings');
      if (!branchIds.includes(b.branchId)) throw new RefundError('NOT_FOUND', 'Booking not found.');
      const full = await getSetting(tx, 'booking.vendor_cancel_full_refund', b.countryCode);
      return this.cancel(tx, b, 'vendor', 'vendor_cancelled', full, now, reason);
    });
  }

  /** Refunds the venue still has to send, for branches where the user confirms payments. */
  async dueForVendor(userId: string) {
    const { branchIds } = await vendorAccess(this.db, userId, 'confirm_payments');
    if (!branchIds.length) return [];
    return this.db
      .select({
        id: refunds.id,
        amount: refunds.amount,
        currency: refunds.currency,
        reason: refunds.reason,
        status: refunds.status,
        playerName: users.name,
        booking: {
          id: bookings.id,
          startAt: bookings.startAt,
          court: courts.name,
          branch: branches.name,
          timezone: branches.timezone,
        },
        paidMethod: bookingShares.method,
      })
      .from(refunds)
      .innerJoin(bookings, eq(bookings.id, refunds.bookingId))
      .innerJoin(bookingShares, eq(bookingShares.id, refunds.shareId))
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(users, eq(users.id, refunds.userId))
      .where(and(inArray(courts.branchId, branchIds), inArray(refunds.status, ['due', 'disputed'])))
      .orderBy(asc(refunds.createdAt));
  }

  async markSent(userId: string, refundId: string, reference: string, now = new Date()) {
    const due = await this.dueForVendor(userId);
    const r = due.find((x) => x.id === refundId);
    if (!r) throw new RefundError('NOT_FOUND', 'Refund not found.');
    await this.db
      .update(refunds)
      .set({ status: 'sent', vendorReference: reference.trim(), sentAt: now, updatedAt: now })
      .where(and(eq(refunds.id, refundId), inArray(refunds.status, ['due', 'disputed'])));
    return { id: refundId, status: 'sent' as const };
  }

  forPlayer(userId: string) {
    return this.db
      .select({
        id: refunds.id,
        bookingId: refunds.bookingId,
        amount: refunds.amount,
        currency: refunds.currency,
        reason: refunds.reason,
        status: refunds.status,
        vendorReference: refunds.vendorReference,
        sentAt: refunds.sentAt,
      })
      .from(refunds)
      .where(eq(refunds.userId, userId))
      .orderBy(desc(refunds.createdAt));
  }

  /** Player confirms the money arrived, or raises a dispute for support (Foundation 8.4). */
  async confirm(userId: string, refundId: string, received: boolean, details: string | undefined, now = new Date()) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.id, refundId), eq(refunds.userId, userId)))
        .for('update');
      if (!r) throw new RefundError('NOT_FOUND', 'Refund not found.');
      if (received) {
        if (r.status !== 'sent') throw new RefundError('NOT_SENT', 'The venue has not marked this refund as sent yet.');
        await tx
          .update(refunds)
          .set({ status: 'received', confirmedAt: now, updatedAt: now })
          .where(eq(refunds.id, refundId));
        await tx
          .update(bookingShares)
          .set({ status: 'refunded', updatedAt: now })
          .where(eq(bookingShares.id, r.shareId));
        return { id: refundId, status: 'received' as const };
      }
      await tx.update(refunds).set({ status: 'disputed', updatedAt: now }).where(eq(refunds.id, refundId));
      await tx.insert(reports).values({
        reporterId: userId,
        targetType: 'booking',
        targetId: r.bookingId,
        reason: 'refund_dispute',
        details: details ?? 'Player says the refund has not arrived.',
        evidence: { refundId, amount: r.amount, vendorReference: r.vendorReference },
      });
      return { id: refundId, status: 'disputed' as const };
    });
  }

  private async lockBooking(tx: Tx, bookingId: string) {
    const [row] = await tx
      .select({ b: bookings, branchId: courts.branchId, countryCode: vendors.countryCode })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(eq(bookings.id, bookingId))
      .for('update', { of: [bookings] });
    if (!row) throw new RefundError('NOT_FOUND', 'Booking not found.');
    return { ...row.b, branchId: row.branchId, countryCode: row.countryCode };
  }

  private async cancel(
    tx: Tx,
    b: typeof bookings.$inferSelect & { branchId: string },
    by: 'player' | 'vendor',
    reason: RefundReason,
    full: boolean,
    now: Date,
    note?: string,
  ) {
    const status = effectiveStatus(b, now);
    // Only the venue can remove its own block.
    if (
      !['held', 'pending_payment', 'confirmed'].includes(status) ||
      (b.source === 'block' && by !== 'vendor') ||
      b.startAt <= now
    ) {
      throw new RefundError('NOT_CANCELLABLE', 'This booking can no longer be cancelled.');
    }
    await tx
      .update(bookings)
      .set({ status: 'cancelled', cancelledBy: by, cancelReason: note ?? null, updatedAt: now })
      .where(eq(bookings.id, b.id));
    // A match on this booking is cancelled too; every paid share is refunded the same way (spec 8.2).
    await tx
      .update(matches)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(matches.bookingId, b.id), inArray(matches.status, ['open', 'full'])));
    const { refunds: count } = await refundShares(tx, { bookingId: b.id, reason, full, now });
    return { id: b.id, status: 'cancelled' as const, refunds: count };
  }
}
