// Local development seed. Fake data only: never real phone numbers, CNICs or payment details.
import { createDb } from './client.js';
import * as s from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed production');

const { db, pool } = createDb(url);

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

const sportRows = [
  ['cricket', 'Cricket', 2, 11],
  ['football', 'Football', 5, 11],
  ['futsal', 'Futsal', 5, 5],
  ['padel', 'Padel', 2, 2],
  ['tennis', 'Tennis', 1, 2],
  ['badminton', 'Badminton', 1, 2],
  ['squash', 'Squash', 1, 1],
  ['swimming', 'Swimming', 1, 1],
  ['basketball', 'Basketball', 3, 5],
  ['volleyball', 'Volleyball', 6, 6],
  ['table-tennis', 'Table tennis', 1, 2],
] as const;
const sports = await db
  .insert(s.sports)
  .values(sportRows.map(([slug, name, teamSizeMin, teamSizeMax]) => ({ slug, name, teamSizeMin, teamSizeMax })))
  .onConflictDoNothing()
  .returning();

if (sports.length) {
  const [owner] = await db
    .insert(s.users)
    .values({ phone: '+920000000001', name: 'Demo Vendor', countryCode: 'PK', status: 'active' })
    .returning();
  const [vendor] = await db
    .insert(s.vendors)
    .values({
      ownerUserId: owner!.id,
      businessName: 'Demo Sports Arena',
      countryCode: 'PK',
      status: 'approved',
      commissionBps: 500,
    })
    .returning();
  const [branch] = await db
    .insert(s.branches)
    .values({
      vendorId: vendor!.id,
      name: 'Demo Arena, Gulberg',
      address: '1 Demo Road',
      city: 'Lahore',
      location: 'SRID=4326;POINT(74.3436 31.5102)',
      timezone: 'Asia/Karachi',
      status: 'live',
      facilities: ['parking', 'floodlights', 'changing_rooms'],
    })
    .returning();
  await db.insert(s.venuePolicies).values({ branchId: branch!.id });
  const padel = sports.find((x) => x.slug === 'padel')!;
  for (const name of ['Padel Court 1', 'Padel Court 2']) {
    const [court] = await db.insert(s.courts).values({ branchId: branch!.id, name }).returning();
    await db.insert(s.courtSports).values({ courtId: court!.id, sportId: padel.id });
    await db
      .insert(s.openingHours)
      .values(
        [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ courtId: court!.id, weekday, opensAt: '07:00', closesAt: '02:00' })),
      );
    await db.insert(s.priceRules).values([
      { courtId: court!.id, dayType: 'all', startTime: '00:00', endTime: '07:00', pricePerHour: 500_000 },
      { courtId: court!.id, dayType: 'weekday', startTime: '07:00', endTime: '17:00', pricePerHour: 400_000 },
      { courtId: court!.id, dayType: 'weekday', startTime: '17:00', endTime: '00:00', pricePerHour: 600_000 },
      { courtId: court!.id, dayType: 'weekend', startTime: '07:00', endTime: '00:00', pricePerHour: 700_000 },
    ]);
  }
}

await pool.end();
console.log('Seed complete');
