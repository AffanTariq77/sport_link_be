import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingError, BookingsService } from '../src/bookings/bookings.service.js';
import { bookings, branches } from '../src/db/schema.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const service = new BookingsService(db);
afterAll(() => pool.end());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof BookingError ? e.code : Promise.reject(e)),
  );

describe('double booking', () => {
  let v: Awaited<ReturnType<typeof createVenue>>;
  beforeAll(async () => {
    v = await createVenue(db);
  });

  it('only one of 25 simultaneous holds on the same slot succeeds', async () => {
    const attempts = Array.from({ length: 25 }, () =>
      code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-07T20:00'),
          endAt: at('2030-01-07T21:00'),
          now: NOW,
        }),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'SLOT_TAKEN')).toHaveLength(24);
  });

  it('rejects a partial overlap but allows back-to-back slots', async () => {
    await service.createHold({
      courtId: v.courtId,
      userId: v.userId,
      startAt: at('2030-01-08T10:00'),
      endAt: at('2030-01-08T11:00'),
      now: NOW,
    });
    expect(
      await code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-08T10:30'),
          endAt: at('2030-01-08T11:30'),
          now: NOW,
        }),
      ),
    ).toBe('SLOT_TAKEN');
    expect(
      await code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-08T11:00'),
          endAt: at('2030-01-08T12:00'),
          now: NOW,
        }),
      ),
    ).toBe('OK');
  });

  it('a manual booking blocks the app, and a maintenance block blocks both', async () => {
    await service.createManual({
      courtId: v.courtId,
      staffUserId: v.userId,
      customerName: 'Walk-in',
      startAt: at('2030-01-09T10:00'),
      endAt: at('2030-01-09T11:00'),
      now: NOW,
    });
    expect(
      await code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-09T10:00'),
          endAt: at('2030-01-09T11:00'),
          now: NOW,
        }),
      ),
    ).toBe('SLOT_TAKEN');
    await service.createBlock({
      courtId: v.courtId,
      staffUserId: v.userId,
      reason: 'Resurfacing',
      startAt: at('2030-01-09T12:00'),
      endAt: at('2030-01-09T14:00'),
      now: NOW,
    });
    expect(
      await code(
        service.createManual({
          courtId: v.courtId,
          staffUserId: v.userId,
          customerName: 'x',
          startAt: at('2030-01-09T13:00'),
          endAt: at('2030-01-09T14:00'),
          now: NOW,
        }),
      ),
    ).toBe('SLOT_TAKEN');
  });

  it('an expired hold frees the slot', async () => {
    await service.createHold({
      courtId: v.courtId,
      userId: v.userId,
      startAt: at('2030-01-10T10:00'),
      endAt: at('2030-01-10T11:00'),
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 16 * 60_000); // default hold is 15 minutes
    expect(
      await code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-10T10:00'),
          endAt: at('2030-01-10T11:00'),
          now: later,
        }),
      ),
    ).toBe('OK');
  });

  it('a cancelled booking frees the slot', async () => {
    const b = await service.createHold({
      courtId: v.courtId,
      userId: v.userId,
      startAt: at('2030-01-11T10:00'),
      endAt: at('2030-01-11T11:00'),
      now: NOW,
    });
    await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, b.id));
    expect(
      await code(
        service.createHold({
          courtId: v.courtId,
          userId: v.userId,
          startAt: at('2030-01-11T10:00'),
          endAt: at('2030-01-11T11:00'),
          now: NOW,
        }),
      ),
    ).toBe('OK');
  });
});

describe('pricing and rules', () => {
  let v: Awaited<ReturnType<typeof createVenue>>;
  beforeAll(async () => {
    v = await createVenue(db);
  });
  const hold = (start: string, end: string) =>
    service.createHold({ courtId: v.courtId, userId: v.userId, startAt: at(start), endAt: at(end), now: NOW });

  it('charges each part of a slot that crosses into peak time, and a 20% advance', async () => {
    // Monday 17:30 to 18:30: half an hour at 3,000 and half an hour at 5,000 PKR per hour.
    const b = await hold('2030-01-07T17:30', '2030-01-07T18:30');
    expect(b.total).toBe(400_000);
    expect(b.advanceDue).toBe(80_000);
    expect(b.currency).toBe('PKR');
    expect(b.status).toBe('held');
    expect(b.countsForBilling).toBe(true);
  });

  it('uses weekend prices on Saturday', async () => {
    const b = await hold('2030-01-05T10:00', '2030-01-05T11:00');
    expect(b.total).toBe(600_000);
  });

  it('allows late-night slots in hours that run past midnight', async () => {
    const b = await hold('2030-01-08T00:30', '2030-01-08T01:30');
    expect(b.total).toBe(400_000);
  });

  it('rejects slots outside opening hours, in the past, misaligned, or back to front', async () => {
    expect(await code(hold('2030-01-08T03:00', '2030-01-08T04:00'))).toBe('OUTSIDE_OPENING_HOURS');
    expect(await code(hold('2030-01-08T01:30', '2030-01-08T02:30'))).toBe('OUTSIDE_OPENING_HOURS');
    expect(await code(hold('2029-11-30T10:00', '2029-11-30T11:00'))).toBe('IN_PAST');
    expect(await code(hold('2030-01-08T10:05', '2030-01-08T11:05'))).toBe('INVALID_TIME');
    expect(await code(hold('2030-01-08T11:00', '2030-01-08T10:00'))).toBe('INVALID_TIME');
  });

  it('refuses bookings at a venue that is not live', async () => {
    await db.update(branches).set({ status: 'suspended' }).where(eq(branches.id, v.branchId));
    expect(await code(hold('2030-01-12T10:00', '2030-01-12T11:00'))).toBe('COURT_UNAVAILABLE');
  });
});

describe('audit log', () => {
  it('cannot be edited or deleted', async () => {
    await pool.query(`INSERT INTO audit_log (actor_type, action) VALUES ('system', 'test')`);
    await expect(pool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});
