import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { effectiveStatus } from '../bookings/bookings.service.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode, UNIQUE_VIOLATION } from '../db/errors.js';
import {
  bookings,
  bookingShares,
  matchPlayers,
  branches,
  courts,
  paymentAccounts,
  paymentMethod,
  reports,
  users,
  vendors,
} from '../db/schema.js';
import { getSetting } from '../settings.js';
import { DocumentCrypto } from '../verification/document-crypto.js';
import { refreshMatchStatus } from '../matches/matches.service.js';
import { money } from '../money.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { vendorAccess } from '../vendors/access.js';

export class PaymentError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_PAYABLE'
      | 'METHOD_NOT_ACCEPTED'
      | 'CASH_NOT_ALLOWED'
      | 'INVALID_REFERENCE'
      | 'DUPLICATE_TRANSACTION'
      | 'ALREADY_SUBMITTED'
      | 'NOT_SUBMITTED'
      | 'BOOKING_EXPIRED',
    message: string,
  ) {
    super(message);
  }
}

type Method = (typeof paymentMethod.enumValues)[number];
type Policy = { allowUnpaidCash?: boolean };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const REFERENCE = /^[A-Za-z0-9-]{4,40}$/;

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  /** What the player needs to pay the advance: the venue's approved accounts (Foundation 8.1). */
  async payInfo(bookingId: string, userId: string, now = new Date()) {
    const booking = await this.ownBooking(bookingId, userId);
    const accounts = await this.db
      .select({
        method: paymentAccounts.method,
        accountTitle: paymentAccounts.accountTitle,
        accountNumberEncrypted: paymentAccounts.accountNumberEncrypted,
        bankName: paymentAccounts.bankName,
      })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.vendorId, booking.vendorId),
          eq(paymentAccounts.status, 'approved'),
          ne(paymentAccounts.method, 'cash'), // paying at the venue is payAtVenueAllowed, not an account
        ),
      )
      .orderBy(asc(paymentAccounts.method));
    const shares = await this.db
      .select({ status: bookingShares.status, method: bookingShares.method, txnReference: bookingShares.txnReference })
      .from(bookingShares)
      .where(eq(bookingShares.bookingId, bookingId))
      .orderBy(asc(bookingShares.createdAt));
    return {
      status: effectiveStatus(booking, now),
      currency: booking.currency,
      timezone: booking.timezone,
      total: booking.total,
      advanceDue: booking.advanceDue,
      holdExpiresAt: booking.holdExpiresAt,
      paymentDeadlineAt: booking.paymentDeadlineAt,
      payAtVenueAllowed: this.cashAllowed(booking),
      accounts: accounts.map(({ accountNumberEncrypted, ...a }) => ({
        ...a,
        accountNumber: accountNumberEncrypted ? this.crypto.decryptAccount(accountNumberEncrypted) : null,
      })),
      payments: shares,
    };
  }

  /**
   * Player reports paying the advance (method and transaction ID), or chooses to pay at the venue when the
   * venue allows unpaid bookings. The vendor's confirmation is the source of truth (Foundation 8.2).
   */
  async submit(bookingId: string, userId: string, input: { method: Method; txnReference?: string }, now = new Date()) {
    const booking = await this.ownBooking(bookingId, userId);
    const payAtVenue = input.method === 'cash';
    if (payAtVenue && !this.cashAllowed(booking)) {
      throw new PaymentError('CASH_NOT_ALLOWED', 'This venue needs the advance paid before your slot is confirmed.');
    }
    const reference = input.txnReference?.trim() ?? '';
    if (!payAtVenue && !REFERENCE.test(reference)) {
      throw new PaymentError('INVALID_REFERENCE', 'Enter the transaction ID from your payment receipt.');
    }
    const [account] = await this.db
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(
        and(
          eq(paymentAccounts.vendorId, booking.vendorId),
          eq(paymentAccounts.method, input.method),
          eq(paymentAccounts.status, 'approved'),
        ),
      );
    // Paying at the venue depends on the venue's policy (checked above), not on an account being listed.
    if (!account && !payAtVenue) {
      throw new PaymentError('METHOD_NOT_ACCEPTED', 'This venue does not accept that payment method.');
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for('update');
        const status = effectiveStatus(locked!, now);
        if (status === 'pending_payment') {
          const [waiting] = await tx
            .select({ id: bookingShares.id })
            .from(bookingShares)
            .where(and(eq(bookingShares.bookingId, bookingId), eq(bookingShares.status, 'submitted')));
          if (waiting) throw new PaymentError('ALREADY_SUBMITTED', 'The venue is checking your payment.');
        } else if (status !== 'held') {
          throw new PaymentError('NOT_PAYABLE', 'This booking can no longer be paid. Please book the slot again.');
        }

        await tx.insert(bookingShares).values({
          bookingId,
          userId,
          amount: booking.total,
          advanceAmount: booking.advanceDue,
          method: input.method,
          txnReference: payAtVenue ? null : reference,
          status: payAtVenue ? 'pending' : 'submitted',
        });
        if (payAtVenue) {
          // Venue allows unpaid bookings: confirmed now, paid in full at the venue.
          await tx.update(bookings).set({ status: 'confirmed', updatedAt: now }).where(eq(bookings.id, bookingId));
        } else {
          const minutes = await getSetting(tx, 'booking.payment_confirm_minutes', booking.countryCode);
          await tx
            .update(bookings)
            .set({
              status: 'pending_payment',
              paymentDeadlineAt: locked!.paymentDeadlineAt ?? new Date(now.getTime() + minutes * 60_000),
              updatedAt: now,
            })
            .where(eq(bookings.id, bookingId));
        }
        const [after] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
        return { status: effectiveStatus(after!, now), paymentDeadlineAt: after!.paymentDeadlineAt };
      });
      if (payAtVenue) {
        await this.notes?.notify(userId, {
          kind: 'booking',
          title: 'Booking confirmed',
          body: 'Your slot is booked. Pay at the venue.',
          link: '/bookings',
        });
      } else if (this.notes) {
        await this.notes.notify(
          await this.notes.vendorRecipients(booking.vendorId, 'confirm_payments', booking.branchId),
          {
            kind: 'payment',
            title: 'Payment to check',
            body: `${money(booking.advanceDue, booking.currency)} by ${input.method.replace('_', ' ')}, reference ${reference}.`,
            link: '/vendor/payments',
          },
        );
      }
      return result;
    } catch (err) {
      if (!hasPgCode(err, UNIQUE_VIOLATION)) throw err;
      // Spec 7.1: a transaction ID used on another booking is rejected and flagged.
      await this.db.insert(reports).values({
        reporterId: userId,
        targetType: 'booking',
        targetId: bookingId,
        reason: 'duplicate_transaction_reference',
        details: 'Automatic flag: payment reference already used for another booking.',
        evidence: { method: input.method },
      });
      throw new PaymentError(
        'DUPLICATE_TRANSACTION',
        'That transaction ID has already been used. Check the ID on your receipt.',
      );
    }
  }

  /** Branches this user can confirm payments for: owned vendors, or staff with the permission. */
  vendorAccess(userId: string) {
    return vendorAccess(this.db, userId, 'confirm_payments');
  }

  /** Vendor's queue of payments waiting to be checked against their account. */
  async queue(userId: string, now = new Date()) {
    const { branchIds } = await this.vendorAccess(userId);
    if (!branchIds.length) return [];
    const rows = await this.db
      .select({
        id: bookingShares.id,
        method: bookingShares.method,
        txnReference: bookingShares.txnReference,
        advanceAmount: bookingShares.advanceAmount,
        submittedAt: bookingShares.createdAt,
        playerName: users.name,
        booking: {
          id: bookings.id,
          status: bookings.status,
          startAt: bookings.startAt,
          endAt: bookings.endAt,
          currency: bookings.currency,
          total: bookings.total,
          holdExpiresAt: bookings.holdExpiresAt,
          paymentDeadlineAt: bookings.paymentDeadlineAt,
        },
        court: courts.name,
        branch: { name: branches.name, timezone: branches.timezone },
      })
      .from(bookingShares)
      .innerJoin(bookings, eq(bookings.id, bookingShares.bookingId))
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(users, eq(users.id, bookingShares.userId))
      .where(and(eq(bookingShares.status, 'submitted'), inArray(branches.id, branchIds)))
      .orderBy(asc(bookings.paymentDeadlineAt))
      .limit(200);
    // Never the player's phone number (CLAUDE.md), only their name.
    return rows.map(({ booking, ...r }) => ({
      ...r,
      booking: { ...booking, status: effectiveStatus(booking, now) },
    }));
  }

  /** Vendor confirms the money arrived. The booking is confirmed once confirmed payments cover the advance. */
  async confirm(shareId: string, userId: string, now = new Date()) {
    const done = await this.decide(shareId, userId, now, async (tx, share, booking) => {
      await tx
        .update(bookingShares)
        .set({ status: 'confirmed', confirmedBy: userId, confirmedAt: now, updatedAt: now })
        .where(eq(bookingShares.id, share.id));
      const [paid] = await tx
        .select({ sum: sql<number>`coalesce(sum(${bookingShares.advanceAmount}), 0)::bigint` })
        .from(bookingShares)
        .where(and(eq(bookingShares.bookingId, booking.id), eq(bookingShares.status, 'confirmed')));
      if (Number(paid!.sum) >= booking.advanceDue) {
        await tx.update(bookings).set({ status: 'confirmed', updatedAt: now }).where(eq(bookings.id, booking.id));
      }
      // A match player's paid share confirms their place (spec 8.1: confirmed = share paid).
      const [joiner] = await tx
        .update(matchPlayers)
        .set({ status: 'confirmed', updatedAt: now })
        .where(and(eq(matchPlayers.shareId, share.id), eq(matchPlayers.status, 'approved')))
        .returning({ matchId: matchPlayers.matchId });
      if (joiner) await refreshMatchStatus(tx, joiner.matchId);
    });
    await this.notes?.notify(
      done.playerId,
      done.matchId
        ? {
            kind: 'match',
            title: 'Your place is confirmed',
            body: 'The venue confirmed your payment. See you on the court.',
            link: `/matches/${done.matchId}`,
          }
        : {
            kind: 'booking',
            title: 'Booking confirmed',
            body: 'The venue confirmed your advance payment.',
            link: '/bookings',
          },
    );
    return { id: done.id };
  }

  /** Vendor says the money did not arrive. Opens a dispute (spec 7.1); the player may submit again before the deadline. */
  async reject(shareId: string, userId: string, reason: string, now = new Date()) {
    const done = await this.decide(shareId, userId, now, async (tx, share, booking) => {
      await tx
        .update(bookingShares)
        .set({ status: 'rejected', confirmedBy: userId, confirmedAt: now, updatedAt: now })
        .where(eq(bookingShares.id, share.id));
      // ponytail: disputes are reports until the admin disputes area (spec 14) has its own table.
      await tx.insert(reports).values({
        reporterId: userId,
        targetType: 'booking',
        targetId: booking.id,
        reason: 'payment_rejected',
        details: reason,
        evidence: { shareId: share.id, method: share.method },
      });
    });
    await this.notes?.notify(done.playerId, {
      kind: 'payment',
      title: 'Payment not found',
      body: `The venue could not find your payment: ${reason} Check the transaction ID and send it again.`,
      link: done.matchId ? `/matches/${done.matchId}` : `/bookings/${done.bookingId}/pay`,
    });
    return { id: done.id };
  }

  private async decide(
    shareId: string,
    userId: string,
    now: Date,
    apply: (tx: Tx, share: typeof bookingShares.$inferSelect, booking: typeof bookings.$inferSelect) => Promise<void>,
  ) {
    const { branchIds } = await this.vendorAccess(userId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ share: bookingShares, booking: bookings, branchId: courts.branchId })
        .from(bookingShares)
        .innerJoin(bookings, eq(bookings.id, bookingShares.bookingId))
        .innerJoin(courts, eq(courts.id, bookings.courtId))
        .where(eq(bookingShares.id, shareId))
        .for('update', { of: [bookingShares, bookings] });
      if (!row || !branchIds.includes(row.branchId)) throw new PaymentError('NOT_FOUND', 'Payment not found.');
      if (row.share.status !== 'submitted')
        throw new PaymentError('NOT_SUBMITTED', 'This payment was already handled.');
      // A match player's share is paid after the host has secured the booking, so its booking may be confirmed.
      const [joiner] = await tx
        .select({ matchId: matchPlayers.matchId })
        .from(matchPlayers)
        .where(eq(matchPlayers.shareId, shareId));
      const status = effectiveStatus(row.booking, now);
      if (status !== 'pending_payment' && !(joiner && status === 'confirmed')) {
        throw new PaymentError('BOOKING_EXPIRED', 'This booking expired before the payment was checked.');
      }
      await apply(tx, row.share, row.booking);
      return { id: shareId, playerId: row.share.userId, bookingId: row.booking.id, matchId: joiner?.matchId ?? null };
    });
  }

  private cashAllowed(booking: { advanceDue: number; policySnapshot: unknown }) {
    return booking.advanceDue === 0 || (booking.policySnapshot as Policy).allowUnpaidCash === true;
  }

  private async ownBooking(bookingId: string, userId: string) {
    const [b] = await this.db
      .select({
        id: bookings.id,
        status: bookings.status,
        currency: bookings.currency,
        total: bookings.total,
        advanceDue: bookings.advanceDue,
        holdExpiresAt: bookings.holdExpiresAt,
        paymentDeadlineAt: bookings.paymentDeadlineAt,
        policySnapshot: bookings.policySnapshot,
        vendorId: branches.vendorId,
        branchId: branches.id,
        timezone: branches.timezone,
        countryCode: vendors.countryCode,
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.createdBy, userId)));
    if (!b) throw new PaymentError('NOT_FOUND', 'Booking not found.');
    return b;
  }
}
