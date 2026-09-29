import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BillingError, BillingService } from '../src/billing/billing.service.js';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { auditLog, bookings, branches, invoiceLines, invoices, vendors } from '../src/db/schema.js';
import type { FileStorage } from '../src/verification/storage.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const files = new Map<string, Buffer>();
const storage: FileStorage = {
  put: async (k, d) => void files.set(k, d),
  get: async (k) => files.get(k)!,
  delete: async (k) => void files.delete(k),
};
const billing = new BillingService(db, storage);
const engine = new BookingsService(db);
afterAll(() => pool.end());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof BillingError ? e.code : Promise.reject(e)),
  );
const days = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000);
const FIRST_OF_FEB = at('2030-02-01T03:00');
const actor = { adminId: '00000000-0000-4000-8000-000000000001', ip: null };

let v: Awaited<ReturnType<typeof createVenue>>; // commission 5% (500 bps)
let vendorId: string;
const hold = (start: string, hours = 1) =>
  engine.createHold({
    courtId: v.courtId,
    userId: v.userId,
    startAt: at(start),
    endAt: new Date(at(start).getTime() + hours * 3_600_000),
    now: NOW,
  });

beforeAll(async () => {
  v = await createVenue(db);
  [{ vendorId }] = (await db
    .select({ vendorId: branches.vendorId })
    .from(branches)
    .where(eq(branches.id, v.branchId))) as [{ vendorId: string }];
  // January 2030: two app bookings (one a no-show), a walk-in and a block; one app booking in February.
  const a = await hold('2030-01-07T08:00'); // weekday 06:00-18:00 at Rs 3,000
  const b = await hold('2030-01-08T19:00'); // weekday evening at Rs 5,000
  const f = await hold('2030-02-04T08:00');
  await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, a.id));
  await db.update(bookings).set({ status: 'no_show' }).where(eq(bookings.id, b.id));
  await db.update(bookings).set({ status: 'confirmed' }).where(eq(bookings.id, f.id));
  await engine.createManual({
    courtId: v.courtId,
    startAt: at('2030-01-09T10:00'),
    endAt: at('2030-01-09T11:00'),
    staffUserId: v.userId,
    customerName: 'Walk-in',
    now: NOW,
  });
  await engine.createBlock({
    courtId: v.courtId,
    startAt: at('2030-01-10T10:00'),
    endAt: at('2030-01-10T12:00'),
    staffUserId: v.userId,
    reason: 'Repairs',
    now: NOW,
  });
});

describe('monthly invoices', () => {
  it('completes finished bookings, then bills January on the 1st of February, once', async () => {
    const { completed } = await billing.completeFinishedBookings(FIRST_OF_FEB);
    expect(completed).toBeGreaterThanOrEqual(2); // the January app booking and walk-in (the block stays a block)

    expect((await billing.issueMonthlyInvoices(FIRST_OF_FEB)).issued).toBeGreaterThanOrEqual(1);
    const [inv] = await db.select().from(invoices).where(eq(invoices.vendorId, vendorId));
    expect(inv).toMatchObject({
      periodStart: '2030-01-01',
      periodEnd: '2030-01-31',
      currency: 'PKR',
      status: 'issued',
    });
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    // 5% of Rs 3,000 (app), Rs 5,000 (no-show, billed by default) and Rs 3,000 (walk-in). Not the block or February.
    expect(lines.map((l) => l.amount).sort((x, y) => x - y)).toEqual([15_000, 15_000, 25_000]);
    expect(inv!.amount).toBe(55_000);

    await billing.issueMonthlyInvoices(days(FIRST_OF_FEB, 0.1));
    expect(await db.select().from(invoices).where(eq(invoices.vendorId, vendorId))).toHaveLength(1);
  });

  it('shows the running total for the current month', async () => {
    const running = await billing.runningTotal(vendorId, at('2030-02-20T12:00'));
    expect(running).toMatchObject({ periodStart: '2030-02-01', currency: 'PKR', billingModel: 'percentage' });
    expect(running.bookings).toBe(0); // February's booking is not completed until it has been played
    await billing.completeFinishedBookings(at('2030-02-20T12:00'));
    expect((await billing.runningTotal(vendorId, at('2030-02-20T12:00'))).amount).toBe(15_000);
  });

  it('a vendor on a monthly plan gets one line for the fee', async () => {
    const other = await createVenue(db);
    const [{ vendorId: planVendor }] = (await db
      .select({ vendorId: branches.vendorId })
      .from(branches)
      .where(eq(branches.id, other.branchId))) as [{ vendorId: string }];
    await db.update(vendors).set({ billingModel: 'monthly', monthlyFee: 2_500_000 }).where(eq(vendors.id, planVendor));
    await billing.issueMonthlyInvoices(FIRST_OF_FEB);
    const [inv] = await db.select().from(invoices).where(eq(invoices.vendorId, planVendor));
    expect(inv!.amount).toBe(2_500_000);
  });
});

describe('overdue ladder and payment', () => {
  it('reminds, warns, hides the venue, blocks the vendor; paying restores both', async () => {
    const [inv] = await db.select().from(invoices).where(eq(invoices.vendorId, vendorId));
    const step = async (n: number) => billing.runOverdueLadder(days(inv!.issuedAt!, n));
    const status = async () => {
      const [b] = await db.select({ s: branches.status }).from(branches).where(eq(branches.id, v.branchId));
      const [ve] = await db.select({ s: vendors.status }).from(vendors).where(eq(vendors.id, vendorId));
      const [i] = await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, inv!.id));
      return [i!.s, b!.s, ve!.s];
    };

    await step(7);
    expect(await status()).toEqual(['issued', 'live', 'approved']);
    await step(14);
    expect(await status()).toEqual(['overdue', 'live', 'approved']);
    await step(21);
    expect(await status()).toEqual(['overdue', 'hidden', 'approved']);
    await step(30);
    expect(await status()).toEqual(['overdue', 'hidden', 'blocked']);
    await step(31); // runs again without repeating anything
    const events = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, inv!.id), eq(auditLog.actorType, 'system')));
    expect(events.map((e) => e.action).sort()).toEqual([
      'invoice.reminder',
      'invoice.vendor_blocked',
      'invoice.venues_hidden',
      'invoice.warning',
    ]);

    expect(await code(billing.uploadProof(vendorId, inv!.id, { buffer: Buffer.from('not an image'), size: 12 }))).toBe(
      'INVALID_IMAGE',
    );
    const jpeg = Buffer.alloc(500, 1);
    jpeg.set([0xff, 0xd8, 0xff]);
    await billing.uploadProof(vendorId, inv!.id, { buffer: jpeg, size: jpeg.length });
    expect((await billing.proof(inv!.id)).equals(jpeg)).toBe(true);

    await billing.settle(inv!.id, { paid: true }, actor);
    expect(await status()).toEqual(['paid', 'live', 'approved']);
    expect(await code(billing.settle(inv!.id, { paid: false, reason: 'Duplicate' }, actor))).toBe('NOT_OPEN');
  });
});
