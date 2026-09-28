import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { BookingsService, effectiveStatus } from '../bookings/bookings.service.js';
import { localToInstant, slotTimes } from '../bookings/pricing.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { bookings, branches, courts, openingHours, users } from '../db/schema.js';
import { DocumentCrypto } from '../verification/document-crypto.js';
import { vendorAccess } from './access.js';
import { VendorError } from './vendors.service.js';

const SHOWN = ['held', 'pending_payment', 'confirmed', 'completed', 'no_show'] as const;

@Injectable()
export class CalendarService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BookingsService) private readonly bookings: BookingsService,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
  ) {}

  /** One local day at a branch: every court's slots with app bookings, manual bookings and blocks together. */
  async day(userId: string, branchId: string, date: string, now = new Date()) {
    await this.assertBranch(userId, branchId, 'view_bookings');
    const [branch] = await this.db
      .select({ id: branches.id, name: branches.name, timezone: branches.timezone })
      .from(branches)
      .where(eq(branches.id, branchId));
    const courtRows = await this.db
      .select({ id: courts.id, name: courts.name, slotMinutes: courts.slotMinutes })
      .from(courts)
      .where(and(eq(courts.branchId, branchId), eq(courts.active, true)))
      .orderBy(asc(courts.name));
    const ids = courtRows.map((c) => c.id);
    const hours = ids.length ? await this.db.select().from(openingHours).where(inArray(openingHours.courtId, ids)) : [];
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

    const perCourt = courtRows.map((c) => ({
      ...c,
      slots: slotTimes(
        weekday,
        hours.filter((h) => h.courtId === c.id),
        c.slotMinutes,
      ).map(([from, to]) => ({
        startAt: localToInstant(date, from, branch!.timezone),
        endAt: localToInstant(date, to, branch!.timezone),
      })),
    }));
    const lastEnd = Math.max(24 * 60, ...perCourt.flatMap((c) => c.slots.map((s) => s.endAt.getTime())));
    const dayStart = localToInstant(date, 0, branch!.timezone);
    const dayEnd = new Date(Math.max(lastEnd, localToInstant(date, 24 * 60, branch!.timezone).getTime()));

    const rows = ids.length
      ? await this.db
          .select({ b: bookings, playerName: users.name })
          .from(bookings)
          .leftJoin(users, eq(users.id, bookings.createdBy))
          .where(
            and(
              inArray(bookings.courtId, ids),
              lt(bookings.startAt, dayEnd),
              gt(bookings.endAt, dayStart),
              inArray(bookings.status, [...SHOWN]),
            ),
          )
          .orderBy(asc(bookings.startAt))
      : [];
    const visible = rows
      .map(({ b, playerName }) => ({ b, playerName, status: effectiveStatus(b, now) }))
      .filter((r) => r.status !== 'expired');

    return {
      branch: branch!,
      date,
      courts: perCourt.map((c) => ({
        id: c.id,
        name: c.name,
        slots: c.slots,
        bookings: visible
          .filter((r) => r.b.courtId === c.id)
          .map(({ b, playerName, status }) => ({
            id: b.id,
            source: b.source,
            status,
            startAt: b.startAt,
            endAt: b.endAt,
            currency: b.currency,
            total: b.total,
            advanceDue: b.advanceDue,
            // App bookings show the player's name only, never their phone (CLAUDE.md).
            name: b.source === 'app' ? playerName : b.manualCustomerName,
            customerPhone:
              b.source === 'manual' && b.manualCustomerPhoneEncrypted
                ? this.crypto.decryptPhone(b.manualCustomerPhoneEncrypted)
                : null,
          })),
      })),
    };
  }

  /** Walk-in or phone booking, confirmed at once and counted for billing (setting billing.count_manual_bookings). */
  async manual(
    userId: string,
    input: { courtId: string; startAt: Date; endAt: Date; customerName: string; customerPhone?: string },
    now = new Date(),
  ) {
    await this.assertCourt(userId, input.courtId, 'create_bookings');
    const phone = input.customerPhone?.trim();
    const b = await this.bookings.createManual({
      courtId: input.courtId,
      startAt: input.startAt,
      endAt: input.endAt,
      staffUserId: userId,
      customerName: input.customerName.trim(),
      customerPhoneEncrypted: phone ? this.crypto.encryptPhone(phone) : undefined,
      now,
    });
    return { id: b.id, status: b.status };
  }

  /** Maintenance or private use. Never billed; the no-overlap constraint stops it covering existing bookings. */
  async block(
    userId: string,
    input: { courtId: string; startAt: Date; endAt: Date; reason: string },
    now = new Date(),
  ) {
    await this.assertCourt(userId, input.courtId, 'create_bookings');
    const b = await this.bookings.createBlock({ ...input, reason: input.reason.trim(), staffUserId: userId, now });
    return { id: b.id, status: b.status };
  }

  /** Vendor marks a confirmed booking whose slot has started as a no-show. */
  async noShow(userId: string, bookingId: string, now = new Date()) {
    const [b] = await this.db
      .select({
        id: bookings.id,
        status: bookings.status,
        startAt: bookings.startAt,
        branchId: courts.branchId,
        source: bookings.source,
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .where(eq(bookings.id, bookingId));
    if (!b) throw new VendorError('NOT_FOUND', 'Booking not found.');
    await this.assertBranch(userId, b.branchId, 'create_bookings');
    if (b.status !== 'confirmed' || b.source === 'block' || b.startAt > now) {
      throw new VendorError('NOT_FOUND', 'Only a confirmed booking that has started can be marked as a no-show.');
    }
    await this.db.update(bookings).set({ status: 'no_show', updatedAt: now }).where(eq(bookings.id, bookingId));
    return { id: bookingId, status: 'no_show' as const };
  }

  private async assertBranch(userId: string, branchId: string, permission: 'view_bookings' | 'create_bookings') {
    const { branchIds } = await vendorAccess(this.db, userId, permission);
    if (!branchIds.includes(branchId)) throw new VendorError('NOT_FOUND', 'Venue not found.');
  }

  private async assertCourt(userId: string, courtId: string, permission: 'create_bookings') {
    const [c] = await this.db.select({ branchId: courts.branchId }).from(courts).where(eq(courts.id, courtId));
    if (!c) throw new VendorError('NOT_FOUND', 'Court not found.');
    await this.assertBranch(userId, c.branchId, permission);
  }
}
