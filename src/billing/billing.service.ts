import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.js';
import { localToInstant, toLocal } from '../bookings/pricing.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { auditLog, bookings, branches, countries, courts, invoiceLines, invoices, vendors } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { STORAGE, type FileStorage } from '../verification/storage.js';

export class BillingError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_OPEN' | 'INVALID_IMAGE',
    message: string,
  ) {
    super(message);
  }
}

type Actor = { adminId: string; ip?: string | null };
const OPEN = ['issued', 'overdue'] as const;
const isImage = (b: Buffer) =>
  (b[0] === 0xff && b[1] === 0xd8) ||
  b.subarray(1, 4).toString('latin1') === 'PNG' ||
  b.subarray(8, 12).toString('latin1') === 'WEBP';

/** First day of the month holding `date` (YYYY-MM-DD), and of the month before. */
function monthBounds(localDate: string) {
  const [y, m] = localDate.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const thisMonth = `${y}-${pad(m)}-01`;
  const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { prev, thisMonth, next };
}
const dayBefore = (date: string) =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Bookings a vendor is billed for between two instants: counted, and completed (or no-show if billed). */
  private async countedBookings(vendorId: string, from: Date, to: Date, countryCode: string) {
    const noShows = await getSetting(this.db, 'billing.count_no_shows', countryCode);
    return this.db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        total: bookings.total,
        court: courts.name,
        branch: branches.name,
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(
        and(
          eq(branches.vendorId, vendorId),
          eq(bookings.countsForBilling, true),
          inArray(bookings.source, ['app', 'manual']),
          inArray(bookings.status, noShows ? ['completed', 'no_show'] : ['completed']),
          gte(bookings.startAt, from),
          lt(bookings.startAt, to),
        ),
      )
      .orderBy(asc(bookings.startAt));
  }

  private lines(
    vendor: { billingModel: 'percentage' | 'monthly'; commissionBps: number | null; monthlyFee: number | null },
    counted: Awaited<ReturnType<BillingService['countedBookings']>>,
    monthLabel: string,
  ) {
    if (vendor.billingModel === 'monthly') {
      return [{ bookingId: null, description: `Monthly plan, ${monthLabel}`, amount: vendor.monthlyFee ?? 0 }];
    }
    const bps = vendor.commissionBps ?? 0;
    return counted.map((b) => ({
      bookingId: b.id,
      description: `${b.branch}, ${b.court}, ${b.startAt.toISOString().slice(0, 10)}: ${bps / 100}% of booking`,
      // Integer minor units, rounded per booking (CLAUDE.md: never floats in stored money).
      amount: Math.round((b.total * bps) / 10_000),
    }));
  }

  /**
   * Issues last month's invoice for every approved vendor on the 1st, in the vendor's country timezone (spec 7.4).
   * Safe to run repeatedly: one invoice per vendor and period (unique index), and issued invoices never change.
   */
  async issueMonthlyInvoices(now = new Date()) {
    const rows = await this.db
      .select({ vendor: vendors, timezone: countries.timezone, currency: countries.currency })
      .from(vendors)
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .where(inArray(vendors.status, ['approved', 'suspended', 'blocked']));
    let issued = 0;
    for (const { vendor, timezone, currency } of rows) {
      const { prev, thisMonth } = monthBounds(toLocal(now, timezone).date);
      const from = localToInstant(prev, 0, timezone);
      const to = localToInstant(thisMonth, 0, timezone);
      const counted = await this.countedBookings(vendor.id, from, to, vendor.countryCode);
      const lines = this.lines(vendor, counted, prev.slice(0, 7));
      const amount = lines.reduce((sum, l) => sum + l.amount, 0);
      if (!lines.length) continue; // nothing to bill this month
      const dueDays = await getSetting(this.db, 'billing.due_days', vendor.countryCode);
      const created = await this.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            vendorId: vendor.id,
            periodStart: prev,
            periodEnd: dayBefore(thisMonth),
            currency,
            amount,
            status: 'issued',
            issuedAt: now,
            dueAt: new Date(now.getTime() + dueDays * 86_400_000),
          })
          .onConflictDoNothing()
          .returning({ id: invoices.id });
        if (!inv) return false;
        await tx.insert(invoiceLines).values(lines.map((l) => ({ ...l, invoiceId: inv.id })));
        return true;
      });
      if (created) issued++;
    }
    return { issued };
  }

  /** What the vendor owes so far this month (spec 13.2 running total). */
  async runningTotal(vendorId: string, now = new Date()) {
    const [row] = await this.db
      .select({ vendor: vendors, timezone: countries.timezone, currency: countries.currency })
      .from(vendors)
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .where(eq(vendors.id, vendorId));
    if (!row) throw new BillingError('NOT_FOUND', 'Vendor not found.');
    const { thisMonth, next } = monthBounds(toLocal(now, row.timezone).date);
    const counted = await this.countedBookings(
      vendorId,
      localToInstant(thisMonth, 0, row.timezone),
      localToInstant(next, 0, row.timezone),
      row.vendor.countryCode,
    );
    const lines = this.lines(row.vendor, counted, thisMonth.slice(0, 7));
    return {
      currency: row.currency,
      periodStart: thisMonth,
      bookings: counted.length,
      amount: lines.reduce((s, l) => s + l.amount, 0),
      billingModel: row.vendor.billingModel,
      commissionBps: row.vendor.commissionBps,
      monthlyFee: row.vendor.monthlyFee,
    };
  }

  async listForVendor(vendorId: string) {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.vendorId, vendorId))
      .orderBy(desc(invoices.periodStart));
    const lines = rows.length
      ? await this.db
          .select()
          .from(invoiceLines)
          .where(
            inArray(
              invoiceLines.invoiceId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    return rows.map((r) => ({
      id: r.id,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      currency: r.currency,
      amount: r.amount,
      status: r.status,
      issuedAt: r.issuedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      proofUploaded: !!r.paymentProofKey,
      lines: lines.filter((l) => l.invoiceId === r.id).map((l) => ({ description: l.description, amount: l.amount })),
    }));
  }

  /** Vendor uploads proof of paying SportsLink; finance then marks the invoice paid (spec 7.4). */
  async uploadProof(vendorId: string, invoiceId: string, image: { buffer: Buffer; size: number }) {
    const [inv] = await this.db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.vendorId, vendorId)));
    if (!inv) throw new BillingError('NOT_FOUND', 'Invoice not found.');
    if (!OPEN.includes(inv.status as (typeof OPEN)[number]))
      throw new BillingError('NOT_OPEN', 'This invoice is already settled.');
    if (image.size > 5_000_000 || !isImage(image.buffer)) {
      throw new BillingError('INVALID_IMAGE', 'Upload a JPEG, PNG or WebP photo or screenshot under 5 MB.');
    }
    const key = `invoices/${vendorId}/${invoiceId}-proof`;
    await this.storage.put(key, image.buffer);
    await this.db
      .update(invoices)
      .set({ paymentProofKey: key, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    return { id: invoiceId };
  }

  // ---------- admin ----------

  listForAdmin(status: (typeof OPEN)[number] | 'paid' | 'written_off') {
    return this.db
      .select({
        id: invoices.id,
        vendor: { id: vendors.id, businessName: vendors.businessName, status: vendors.status },
        periodStart: invoices.periodStart,
        currency: invoices.currency,
        amount: invoices.amount,
        status: invoices.status,
        issuedAt: invoices.issuedAt,
        dueAt: invoices.dueAt,
        proofUploaded: sql<boolean>`${invoices.paymentProofKey} is not null`,
      })
      .from(invoices)
      .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(eq(invoices.status, status))
      .orderBy(asc(invoices.issuedAt))
      .limit(200);
  }

  async proof(invoiceId: string) {
    const [inv] = await this.db
      .select({ key: invoices.paymentProofKey })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    if (!inv?.key) throw new BillingError('NOT_FOUND', 'No proof uploaded.');
    return this.storage.get(inv.key);
  }

  /** Finance marks an invoice paid, or writes it off with a reason. Paying lifts any overdue hide or block. */
  async settle(
    invoiceId: string,
    outcome: { paid: true } | { paid: false; reason: string },
    actor: Actor,
    now = new Date(),
  ) {
    return this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
      if (!inv) throw new BillingError('NOT_FOUND', 'Invoice not found.');
      if (!OPEN.includes(inv.status as (typeof OPEN)[number]))
        throw new BillingError('NOT_OPEN', 'This invoice is already settled.');
      const status = outcome.paid ? ('paid' as const) : ('written_off' as const);
      await tx
        .update(invoices)
        .set({ status, paidAt: outcome.paid ? now : null, updatedAt: now })
        .where(eq(invoices.id, invoiceId));
      await audit(tx, {
        actorId: actor.adminId,
        action: outcome.paid ? 'invoice.mark_paid' : 'invoice.write_off',
        targetType: 'invoice',
        targetId: invoiceId,
        before: { status: inv.status },
        after: { status, reason: outcome.paid ? null : outcome.reason },
        ip: actor.ip,
      });
      await this.liftIfClear(tx, inv.vendorId, now);
      return { id: invoiceId, status };
    });
  }

  /** Once no invoice is overdue, restore what the ladder did: unblock the vendor, unhide venues it hid. */
  private async liftIfClear(tx: Parameters<Parameters<Db['transaction']>[0]>[0], vendorId: string, now: Date) {
    const [stillOpen] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.vendorId, vendorId), eq(invoices.status, 'overdue')))
      .limit(1);
    if (stillOpen) return;
    await tx
      .update(vendors)
      .set({ status: 'approved', updatedAt: now })
      .where(and(eq(vendors.id, vendorId), eq(vendors.status, 'blocked')));
    // Venues the ladder hid are listed on its audit entries; restore those that are still hidden.
    const vendorInvoices = tx
      .select({ id: sql<string>`${invoices.id}::text` })
      .from(invoices)
      .where(eq(invoices.vendorId, vendorId));
    const entries = await tx
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'invoice.venues_hidden'), inArray(auditLog.targetId, vendorInvoices)));
    const ids = [...new Set(entries.flatMap((e) => (e.after as { branchIds?: string[] } | null)?.branchIds ?? []))];
    if (ids.length) {
      await tx
        .update(branches)
        .set({ status: 'live', updatedAt: now })
        .where(and(inArray(branches.id, ids), eq(branches.status, 'hidden')));
    }
  }

  /**
   * Overdue ladder (Foundation 8.5, all settings): reminder, warning (status overdue), venues hidden from search,
   * vendor blocked. Each step is logged as a system event; notifications are sent once that service exists.
   */
  async runOverdueLadder(now = new Date()) {
    const open = await this.db
      .select({ inv: invoices, vendorStatus: vendors.status, countryCode: vendors.countryCode })
      .from(invoices)
      .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
      .where(and(inArray(invoices.status, [...OPEN]), lte(invoices.issuedAt, now)));
    const done: string[] = [];
    for (const { inv, vendorStatus, countryCode } of open) {
      const age = (now.getTime() - inv.issuedAt!.getTime()) / 86_400_000;
      const days = {
        reminder: await getSetting(this.db, 'billing.reminder_days', countryCode),
        warning: await getSetting(this.db, 'billing.warning_days', countryCode),
        hide: await getSetting(this.db, 'billing.hide_days', countryCode),
        block: await getSetting(this.db, 'billing.block_days', countryCode),
      };
      const logged = async (action: string, after?: unknown) => {
        const [seen] = await this.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.action, action), eq(auditLog.targetId, inv.id)))
          .limit(1);
        if (seen) return true;
        await this.db
          .insert(auditLog)
          .values({ actorType: 'system', action, targetType: 'invoice', targetId: inv.id, after });
        done.push(`${action}:${inv.id}`);
        return false;
      };
      if (age >= days.reminder) await logged('invoice.reminder');
      if (age >= days.warning && !(await logged('invoice.warning'))) {
        await this.db.update(invoices).set({ status: 'overdue', updatedAt: now }).where(eq(invoices.id, inv.id));
      }
      if (age >= days.hide) {
        const live = await this.db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.vendorId, inv.vendorId), eq(branches.status, 'live')));
        if (!(await logged('invoice.venues_hidden', { branchIds: live.map((b) => b.id) })) && live.length) {
          await this.db
            .update(branches)
            .set({ status: 'hidden', updatedAt: now })
            .where(
              inArray(
                branches.id,
                live.map((b) => b.id),
              ),
            );
        }
      }
      if (age >= days.block && vendorStatus !== 'blocked' && !(await logged('invoice.vendor_blocked'))) {
        await this.db.update(vendors).set({ status: 'blocked', updatedAt: now }).where(eq(vendors.id, inv.vendorId));
      }
    }
    return { done };
  }

  /** Confirmed bookings whose slot has ended are completed (spec 6.1); billing counts completed bookings. */
  async completeFinishedBookings(now = new Date()) {
    const rows = await this.db
      .update(bookings)
      .set({ status: 'completed', updatedAt: now })
      .where(and(eq(bookings.status, 'confirmed'), lte(bookings.endAt, now), ne(bookings.source, 'block')))
      .returning({ id: bookings.id });
    return { completed: rows.length };
  }
}
