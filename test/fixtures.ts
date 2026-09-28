import { createDb, type Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';

export const testDb = () => createDb(process.env.TEST_DATABASE_URL!);

// Karachi is UTC+5 with no daylight saving. `at('2030-01-07T17:30')` = that local time.
export const at = (local: string) => new Date(`${local}:00+05:00`);
export const NOW = at('2029-12-01T12:00');

let counter = 0;

export async function ensurePakistan(db: Db) {
  await db
    .insert(s.countries)
    .values({
      code: 'PK',
      name: 'Pakistan',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      languages: ['en', 'ur'],
      paymentMethods: ['jazzcash', 'easypaisa', 'bank_transfer', 'cash'],
      enabled: true,
    })
    .onConflictDoNothing();
}

/** A live, approved venue with one court open 06:00 to 02:00 every day. Fake data only. */
export async function createVenue(db: Db) {
  const n = ++counter;
  await ensurePakistan(db);
  const [user] = await db
    .insert(s.users)
    .values({ phone: `+920000000${String(n).padStart(3, '0')}`, countryCode: 'PK', status: 'active' })
    .returning();
  const [vendor] = await db
    .insert(s.vendors)
    .values({
      ownerUserId: user!.id,
      businessName: `Test Vendor ${n}`,
      countryCode: 'PK',
      status: 'approved',
      commissionBps: 500,
    })
    .returning();
  const [branch] = await db
    .insert(s.branches)
    .values({
      vendorId: vendor!.id,
      name: 'Main',
      address: 'Test address',
      city: 'Lahore',
      location: 'SRID=4326;POINT(74.3587 31.5204)',
      timezone: 'Asia/Karachi',
      status: 'live',
    })
    .returning();
  await db.insert(s.venuePolicies).values({ branchId: branch!.id, advanceType: 'percentage', advanceValue: 2000 });
  const [court] = await db.insert(s.courts).values({ branchId: branch!.id, name: 'Court 1' }).returning();
  await db
    .insert(s.openingHours)
    .values(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ courtId: court!.id, weekday, opensAt: '06:00', closesAt: '02:00' })),
    );
  await db.insert(s.priceRules).values([
    { courtId: court!.id, dayType: 'weekday', startTime: '06:00', endTime: '18:00', pricePerHour: 300_000 },
    { courtId: court!.id, dayType: 'weekday', startTime: '18:00', endTime: '00:00', pricePerHour: 500_000 },
    { courtId: court!.id, dayType: 'weekend', startTime: '06:00', endTime: '00:00', pricePerHour: 600_000 },
    { courtId: court!.id, dayType: 'all', startTime: '00:00', endTime: '06:00', pricePerHour: 400_000 },
  ]);
  return { userId: user!.id, courtId: court!.id, branchId: branch!.id };
}
