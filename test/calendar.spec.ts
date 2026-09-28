import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingError, BookingsService } from '../src/bookings/bookings.service.js';
import { bookings, branches, users } from '../src/db/schema.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { CalendarService } from '../src/vendors/calendar.service.js';
import { StaffService } from '../src/vendors/staff.service.js';
import { VendorError } from '../src/vendors/vendors.service.js';
import { at, createVenue, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const engine = new BookingsService(db);
const calendar = new CalendarService(db, engine, crypto);
const staff = new StaffService(db);
afterAll(() => pool.end());

const MONDAY = '2030-01-07';
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof VendorError || e instanceof BookingError ? e.code : Promise.reject(e)),
  );
// Fake numbers only.
async function person(name: string) {
  const digits = String(randomInt(0, 1e7)).padStart(7, '0');
  const [u] = await db
    .insert(users)
    .values({ phone: `+92303${digits}`, countryCode: 'PK', name })
    .returning({ id: users.id });
  return { id: u!.id, phone: `0303 ${digits}` };
}
const slot = (hour: number) => ({
  startAt: at(`${MONDAY}T${String(hour).padStart(2, '0')}:00`),
  endAt: at(`${MONDAY}T${String(hour + 1).padStart(2, '0')}:00`),
});

let v: Awaited<ReturnType<typeof createVenue>>; // v.userId owns the venue
let vendorId: string;
beforeAll(async () => {
  v = await createVenue(db);
  [{ vendorId }] = (await db
    .select({ vendorId: branches.vendorId })
    .from(branches)
    .where(eq(branches.id, v.branchId))) as [{ vendorId: string }];
});

describe('vendor calendar', () => {
  it('shows app bookings, manual bookings and blocks together, never a player phone', async () => {
    const player = await person('Hamza Test');
    await engine.createHold({ courtId: v.courtId, userId: player.id, ...slot(18), now: NOW });
    await calendar.manual(
      v.userId,
      { courtId: v.courtId, ...slot(19), customerName: 'Walk-in Team', customerPhone: '0300 0000042' },
      NOW,
    );
    await calendar.block(v.userId, { courtId: v.courtId, ...slot(21), reason: 'Net repair' }, NOW);

    const day = await calendar.day(v.userId, v.branchId, MONDAY, NOW);
    const court = day.courts[0]!;
    expect(court.slots).toHaveLength(20);
    expect(court.bookings.map((b) => [b.source, b.status, b.name, b.customerPhone])).toEqual([
      ['app', 'held', 'Hamza Test', null],
      ['manual', 'confirmed', 'Walk-in Team', '0300 0000042'],
      ['block', 'confirmed', 'Net repair', null],
    ]);
    expect(JSON.stringify(court.bookings)).not.toContain(player.phone.replace(' ', ''));

    const [stored] = await db.select().from(bookings).where(eq(bookings.manualCustomerName, 'Walk-in Team'));
    expect(stored!.manualCustomerPhoneEncrypted).not.toContain('0042');
    expect(stored!.countsForBilling).toBe(true);
  });

  it('manual bookings and blocks cannot overlap existing bookings', async () => {
    expect(
      await code(calendar.manual(v.userId, { courtId: v.courtId, ...slot(19), customerName: 'Second team' }, NOW)),
    ).toBe('SLOT_TAKEN');
    expect(await code(calendar.block(v.userId, { courtId: v.courtId, ...slot(18), reason: 'Painting' }, NOW))).toBe(
      'SLOT_TAKEN',
    );
  });

  it('marks no-shows only after the slot has started', async () => {
    const { id } = await calendar.manual(v.userId, { courtId: v.courtId, ...slot(10), customerName: 'Late Team' }, NOW);
    expect(await code(calendar.noShow(v.userId, id, NOW))).toBe('NOT_FOUND');
    expect(await calendar.noShow(v.userId, id, at(`${MONDAY}T10:20`))).toEqual({ id, status: 'no_show' });
  });
});

describe('staff', () => {
  it('get exactly the permissions they were given, and lose access as soon as they are removed', async () => {
    const receptionist = await person('Receptionist Test');
    const outsider = await person('Outsider Test');
    expect(await code(calendar.day(receptionist.id, v.branchId, MONDAY, NOW))).toBe('NOT_FOUND');

    await staff.add(v.userId, vendorId, { phone: receptionist.phone, permissions: ['view_bookings'], branchIds: [] });
    expect(await code(calendar.day(receptionist.id, v.branchId, MONDAY, NOW))).toBe('OK');
    expect(
      await code(calendar.manual(receptionist.id, { courtId: v.courtId, ...slot(12), customerName: 'X' }, NOW)),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        staff.add(receptionist.id, vendorId, { phone: outsider.phone, permissions: ['view_bookings'], branchIds: [] }),
      ),
    ).toBe('NOT_VENDOR');

    await staff.add(v.userId, vendorId, {
      phone: receptionist.phone,
      permissions: ['view_bookings', 'create_bookings'],
      branchIds: [v.branchId],
    });
    expect(
      await code(calendar.manual(receptionist.id, { courtId: v.courtId, ...slot(12), customerName: 'Y' }, NOW)),
    ).toBe('OK');
    expect((await staff.list(v.userId, vendorId)).map((s) => s.name)).toEqual(['Receptionist Test']);

    await staff.remove(v.userId, vendorId, receptionist.id);
    expect(await code(calendar.day(receptionist.id, v.branchId, MONDAY, NOW))).toBe('NOT_FOUND');
  });

  it('needs an existing account and the vendor’s own branches', async () => {
    expect(
      await code(
        staff.add(v.userId, vendorId, { phone: '0303 9999999', permissions: ['view_bookings'], branchIds: [] }),
      ),
    ).toBe('NOT_FOUND');
    const other = await createVenue(db);
    const helper = await person('Helper Test');
    expect(
      await code(
        staff.add(v.userId, vendorId, {
          phone: helper.phone,
          permissions: ['view_bookings'],
          branchIds: [other.branchId],
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});
