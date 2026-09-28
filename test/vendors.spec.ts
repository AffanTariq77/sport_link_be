import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BookingsService } from '../src/bookings/bookings.service.js';
import { paymentAccounts, siteVisits, sports, users, verifications } from '../src/db/schema.js';
import { DocumentCrypto } from '../src/verification/document-crypto.js';
import { VendorError, VendorsService, type Price } from '../src/vendors/vendors.service.js';
import { VenuesService } from '../src/venues/venues.service.js';
import { at, createVenue, ensurePakistan, NOW, testDb } from './fixtures.js';

const { db, pool } = testDb();
const crypto = new DocumentCrypto(randomBytes(32).toString('base64'));
const vendors = new VendorsService(db, crypto);
afterAll(() => pool.end());
beforeAll(async () => {
  await ensurePakistan(db);
  await db
    .insert(sports)
    .values([
      { slug: 'padel', name: 'Padel', teamSizeMin: 2, teamSizeMax: 2 },
      { slug: 'futsal', name: 'Futsal', teamSizeMin: 5, teamSizeMax: 5 },
    ])
    .onConflictDoNothing();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e) => (e instanceof VendorError ? e.code : Promise.reject(e)),
  );
// Fake data only.
async function owner({ verified = true } = {}) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9200${String(randomInt(0, 1e8)).padStart(8, '0')}`, countryCode: 'PK', name: 'Test Owner' })
    .returning({ id: users.id });
  if (verified) {
    await db.insert(verifications).values({
      userId: u!.id,
      docType: 'cnic',
      docNumberEncrypted: 'test',
      docNumberHash: randomBytes(16).toString('hex'),
      frontKey: 'test-front',
      backKey: 'test-back',
    });
  }
  return u!.id;
}
const branchInput = {
  name: 'Test Arena',
  address: '1 Test Road',
  city: 'Lahore',
  latitude: 31.52,
  longitude: 74.35,
  facilities: ['parking'],
  rules: null,
};
const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: '07:00', closesAt: '02:00' }));
const weekdayOnly: Price[] = [
  { dayType: 'weekday', startTime: '07:00', endTime: '00:00', pricePerHour: 400_000 },
  { dayType: 'all', startTime: '00:00', endTime: '07:00', pricePerHour: 500_000 },
];

describe('applying', () => {
  it('needs an identity document submitted, and only once per owner', async () => {
    expect(await code(vendors.apply(await owner({ verified: false }), 'Test Sports'))).toBe('VERIFY_FIRST');
    const me = await owner();
    expect(await vendors.apply(me, '  Test Sports  ')).toMatchObject({
      businessName: 'Test Sports',
      status: 'applied',
    });
    expect(await code(vendors.apply(me, 'Again'))).toBe('ALREADY_APPLIED');
  });

  it('owners without a vendor account cannot create venues', async () => {
    expect(await code(vendors.createBranch(await owner(), branchInput))).toBe('NOT_VENDOR');
  });
});

describe('setting up a venue', () => {
  let me: string;
  let branchId: string;
  let courtId: string;
  beforeAll(async () => {
    me = await owner();
    await vendors.apply(me, 'Setup Test Sports');
    ({ id: branchId } = await vendors.createBranch(me, branchInput));
    ({ id: courtId } = await vendors.createCourt(me, branchId, {
      name: 'Court A',
      surface: 'Artificial grass',
      slotMinutes: 60,
      sports: ['padel', 'futsal'],
    }));
  });

  it('only the owner can change a venue or its courts', async () => {
    const stranger = await owner();
    await vendors.apply(stranger, 'Other Sports');
    expect(await code(vendors.updateBranch(stranger, branchId, branchInput))).toBe('NOT_FOUND');
    expect(await code(vendors.setHours(stranger, courtId, everyDay))).toBe('NOT_FOUND');
    expect(
      await code(
        vendors.createCourt(stranger, branchId, { name: 'X', surface: null, slotMinutes: 60, sports: ['padel'] }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('rejects overlapping hours, overlapping prices and unknown sports', async () => {
    expect(
      await code(
        vendors.setHours(me, courtId, [
          { weekday: 1, opensAt: '07:00', closesAt: '12:00' },
          { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
        ]),
      ),
    ).toBe('INVALID_HOURS');
    expect(
      await code(
        vendors.setPrices(me, courtId, [
          { dayType: 'weekday', startTime: '07:00', endTime: '18:00', pricePerHour: 1 },
          { dayType: 'weekday', startTime: '17:00', endTime: '00:00', pricePerHour: 1 },
        ]),
      ),
    ).toBe('INVALID_PRICES');
    expect(
      await code(
        vendors.setPrices(me, courtId, [{ dayType: 'all', startTime: '18:00', endTime: '07:00', pricePerHour: 1 }]),
      ),
    ).toBe('INVALID_PRICES');
    expect(
      await code(vendors.createCourt(me, branchId, { name: 'B', surface: null, slotMinutes: 60, sports: ['curling'] })),
    ).toBe('UNKNOWN_SPORT');
  });

  it('checklist catches open hours without a price, and submit waits for a payment account', async () => {
    await vendors.setHours(me, courtId, everyDay);
    await vendors.setPrices(me, courtId, weekdayOnly);
    const checklist = async () => (await vendors.setup(me, NOW)).branches[0]!.checklist;
    const prices = (await checklist()).find((i) => i.key === 'prices')!;
    expect(prices).toMatchObject({ done: false, label: 'Set a price for every open hour (Court A)' });

    await vendors.setPrices(me, courtId, [
      ...weekdayOnly,
      { dayType: 'weekend', startTime: '07:00', endTime: '00:00', pricePerHour: 700_000 },
    ]);
    expect((await checklist()).filter((i) => !i.done).map((i) => i.key)).toEqual(['payment']);
    expect((await vendors.setup(me, NOW)).branches[0]).toMatchObject({ latitude: 31.52, longitude: 74.35 });
    expect(await code(vendors.submit(me, branchId, NOW))).toBe('INCOMPLETE');
  });

  it('stores account numbers encrypted and shows only the last digits, pending approval', async () => {
    await vendors.addAccount(me, { method: 'jazzcash', accountTitle: 'Test Owner', accountNumber: '0300 0001234' });
    const [row] = await db.select().from(paymentAccounts).where(eq(paymentAccounts.accountTitle, 'Test Owner'));
    expect(row!.accountNumberEncrypted).not.toContain('1234');
    const { paymentAccounts: listed } = await vendors.setup(me, NOW);
    expect(listed).toEqual([
      expect.objectContaining({ method: 'jazzcash', accountNumberEnding: '1234', status: 'pending' }),
    ]);
    expect(
      await code(vendors.addAccount(me, { method: 'bank_transfer', accountTitle: 'Test Owner', accountNumber: '123' })),
    ).toBe('INVALID_ACCOUNT');
  });

  it('a complete venue goes for review with a site visit request, and stays hidden from players', async () => {
    expect(await vendors.submit(me, branchId, NOW)).toEqual({ id: branchId, status: 'pending_visit' });
    expect(await db.select().from(siteVisits).where(eq(siteVisits.branchId, branchId))).toHaveLength(1);
    expect(await code(vendors.submit(me, branchId, NOW))).toBe('ALREADY_SUBMITTED');
    expect((await new VenuesService(db).list({})).some((v) => v.id === branchId)).toBe(false);
  });
});

describe('courts with bookings', () => {
  it('cannot be switched off while they have upcoming bookings', async () => {
    const v = await createVenue(db); // v.userId owns this venue
    await new BookingsService(db).createHold({
      courtId: v.courtId,
      userId: v.userId,
      startAt: at('2030-01-07T20:00'),
      endAt: at('2030-01-07T21:00'),
      now: NOW,
    });
    const court = { name: 'Court 1', surface: null, slotMinutes: 60, sports: ['padel'] };
    expect(await code(vendors.updateCourt(v.userId, v.courtId, { ...court, active: false }, NOW))).toBe(
      'HAS_FUTURE_BOOKINGS',
    );
    expect(await code(vendors.updateCourt(v.userId, v.courtId, { ...court, active: true }, NOW))).toBe('OK');
  });
});
