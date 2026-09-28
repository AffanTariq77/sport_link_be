import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import {
  bookings,
  branches,
  countries,
  courts,
  holidays,
  openingHours,
  priceRules,
  vendors,
  venuePolicies,
} from '../db/schema.js';
import { getSetting } from '../settings.js';
import { calculateAdvance, calculatePrice, isWithinOpeningHours, type PriceRule } from './pricing.js';

export class BookingError extends Error {
  constructor(
    public readonly code:
      'SLOT_TAKEN' | 'INVALID_TIME' | 'IN_PAST' | 'OUTSIDE_OPENING_HOURS' | 'NO_PRICE' | 'COURT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

interface SlotInput {
  courtId: string;
  startAt: Date;
  endAt: Date;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Postgres error code for an exclusion constraint violation.
const EXCLUSION_VIOLATION = '23P01';

@Injectable()
export class BookingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Player selects a slot: create a short hold. The DB constraint guarantees no overlap. */
  async createHold(input: SlotInput & { userId: string; now?: Date }) {
    const now = input.now ?? new Date();
    return this.insert(input, now, async (tx, ctx) => {
      const holdMinutes = await getSetting(tx, 'booking.hold_minutes', ctx.countryCode);
      return {
        source: 'app' as const,
        status: 'held' as const,
        createdBy: input.userId,
        holdExpiresAt: new Date(now.getTime() + holdMinutes * 60_000),
        countsForBilling: true,
      };
    });
  }

  /** The player's own bookings, newest slot first. Holds past their expiry show as expired. */
  async listForUser(userId: string, now = new Date()) {
    const rows = await this.db
      .select({
        id: bookings.id,
        status: bookings.status,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        currency: bookings.currency,
        total: bookings.total,
        advanceDue: bookings.advanceDue,
        holdExpiresAt: bookings.holdExpiresAt,
        paymentDeadlineAt: bookings.paymentDeadlineAt,
        policy: bookings.policySnapshot,
        court: { id: courts.id, name: courts.name },
        venue: { id: branches.id, name: branches.name, city: branches.city, timezone: branches.timezone },
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(and(eq(bookings.createdBy, userId), eq(bookings.source, 'app')))
      .orderBy(desc(bookings.startAt))
      .limit(100);
    return rows.map((b) => ({ ...b, status: effectiveStatus(b, now) }));
  }

  /** Vendor books a walk-in or phone customer. Confirmed immediately. */
  async createManual(input: SlotInput & { staffUserId: string; customerName: string; now?: Date }) {
    const now = input.now ?? new Date();
    return this.insert(input, now, async (tx, ctx) => ({
      source: 'manual' as const,
      status: 'confirmed' as const,
      createdBy: input.staffUserId,
      manualCustomerName: input.customerName,
      countsForBilling: await getSetting(tx, 'billing.count_manual_bookings', ctx.countryCode),
    }));
  }

  /** Vendor blocks time for maintenance or private use. Never billed. */
  async createBlock(input: SlotInput & { staffUserId: string; reason: string; now?: Date }) {
    const now = input.now ?? new Date();
    return this.insert(
      input,
      now,
      async () => ({
        source: 'block' as const,
        status: 'confirmed' as const,
        createdBy: input.staffUserId,
        manualCustomerName: input.reason,
        countsForBilling: false,
      }),
      { skipPricing: true },
    );
  }

  private async insert(
    input: SlotInput,
    now: Date,
    fields: (
      tx: Tx,
      ctx: { countryCode: string },
    ) => Promise<
      Partial<typeof bookings.$inferInsert> &
        Pick<typeof bookings.$inferInsert, 'source' | 'status' | 'countsForBilling'>
    >,
    opts: { skipPricing?: boolean } = {},
  ) {
    const { courtId, startAt, endAt } = input;
    if (!(endAt > startAt)) throw new BookingError('INVALID_TIME', 'The end time must be after the start time.');
    if (startAt <= now) throw new BookingError('IN_PAST', 'This slot has already started. Choose a later time.');

    try {
      return await this.db.transaction(async (tx) => {
        const ctx = await this.loadCourt(tx, courtId);
        const step = await getSetting(tx, 'booking.slot_step_minutes', ctx.countryCode);
        const durationMin = (endAt.getTime() - startAt.getTime()) / 60_000;
        if (durationMin % step !== 0 || startAt.getTime() % (step * 60_000) !== 0) {
          throw new BookingError('INVALID_TIME', `Bookings must start and end on ${step}-minute steps.`);
        }

        let total = 0;
        let advanceDue = 0;
        if (!opts.skipPricing) {
          if (!isWithinOpeningHours(startAt, endAt, ctx.timezone, ctx.hours)) {
            throw new BookingError('OUTSIDE_OPENING_HOURS', 'The court is closed at this time.');
          }
          const weekendDays = await getSetting(tx, 'calendar.weekend_days', ctx.countryCode);
          try {
            total = calculatePrice(startAt, endAt, ctx.timezone, ctx.rules, ctx.holidays, weekendDays, step);
          } catch {
            throw new BookingError('NO_PRICE', 'This time cannot be booked yet. Choose another slot.');
          }
          advanceDue = calculateAdvance(total, ctx.policy.advanceType, ctx.policy.advanceValue);
        }

        await this.expireStale(tx, courtId, now);

        const [row] = await tx
          .insert(bookings)
          .values({
            courtId,
            startAt,
            endAt,
            currency: ctx.currency,
            total,
            advanceDue,
            policySnapshot: ctx.policy,
            ...(await fields(tx, ctx)),
          })
          .returning();
        return row!;
      });
    } catch (err) {
      if (isExclusionViolation(err))
        throw new BookingError('SLOT_TAKEN', 'This slot has just been taken. Choose another time.');
      throw err;
    }
  }

  /** Holds and unpaid bookings past their deadline stop blocking the slot. */
  private async expireStale(tx: Tx, courtId: string, now: Date) {
    await tx
      .update(bookings)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(bookings.courtId, courtId),
          or(
            and(eq(bookings.status, 'held'), lt(bookings.holdExpiresAt, now)),
            and(eq(bookings.status, 'pending_payment'), lt(bookings.paymentDeadlineAt, now)),
          ),
        ),
      );
  }

  private async loadCourt(tx: Tx, courtId: string) {
    const [court] = await tx
      .select({
        active: courts.active,
        branchId: branches.id,
        branchStatus: branches.status,
        timezone: branches.timezone,
        vendorStatus: vendors.status,
        countryCode: vendors.countryCode,
      })
      .from(courts)
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(eq(courts.id, courtId));
    if (!court || !court.active || court.branchStatus !== 'live' || court.vendorStatus !== 'approved') {
      throw new BookingError('COURT_UNAVAILABLE', 'This court cannot be booked right now.');
    }

    const [policy] = await tx.select().from(venuePolicies).where(eq(venuePolicies.branchId, court.branchId));
    if (!policy) throw new BookingError('COURT_UNAVAILABLE', 'This court cannot be booked right now.');

    const [country] = await tx
      .select({ currency: countries.currency })
      .from(countries)
      .where(eq(countries.code, court.countryCode));

    const hours = await tx.select().from(openingHours).where(eq(openingHours.courtId, courtId));
    const rules: PriceRule[] = await tx
      .select({
        dayType: priceRules.dayType,
        startTime: priceRules.startTime,
        endTime: priceRules.endTime,
        pricePerHour: priceRules.pricePerHour,
      })
      .from(priceRules)
      .where(eq(priceRules.courtId, courtId));
    const hol = await tx
      .select({ day: holidays.day })
      .from(holidays)
      .where(eq(holidays.countryCode, court.countryCode));

    const policySnapshot = {
      advanceType: policy.advanceType,
      advanceValue: policy.advanceValue,
      cancelRefund: policy.cancelRefund,
      cancelWindowHours: policy.cancelWindowHours,
      noShowRefund: policy.noShowRefund,
      recurringAllowed: policy.recurringAllowed,
      allowUnpaidCash: policy.allowUnpaidCash,
    };
    return {
      countryCode: court.countryCode,
      currency: country!.currency,
      timezone: court.timezone,
      hours,
      rules,
      holidays: new Set(hol.map((h) => h.day)),
      policy: policySnapshot,
    };
  }
}

/** Status as the player should see it: holds and unpaid bookings past their deadline are expired. */
export function effectiveStatus(
  b: { status: (typeof bookings.$inferSelect)['status']; holdExpiresAt: Date | null; paymentDeadlineAt: Date | null },
  now: Date,
) {
  if (b.status === 'held' && b.holdExpiresAt && b.holdExpiresAt <= now) return 'expired' as const;
  if (b.status === 'pending_payment' && b.paymentDeadlineAt && b.paymentDeadlineAt <= now) return 'expired' as const;
  return b.status;
}

function isExclusionViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === EXCLUSION_VIOLATION) return true;
  }
  return false;
}
