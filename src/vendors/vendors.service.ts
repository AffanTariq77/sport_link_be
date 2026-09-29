import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { calculatePrice, localToInstant, slotTimes } from '../bookings/pricing.js';
import { DB } from '../db/db.module.js';
import { photoUrl } from './photos.service.js';
import type { Db } from '../db/client.js';
import {
  bookings,
  branches,
  countries,
  courts,
  courtSports,
  dayType,
  holidays,
  openingHours,
  paymentAccounts,
  paymentMethod,
  priceRules,
  siteVisits,
  sports,
  users,
  vendors,
  venuePolicies,
  verifications,
} from '../db/schema.js';
import { getSetting } from '../settings.js';
import { DocumentCrypto } from '../verification/document-crypto.js';

export class VendorError extends Error {
  constructor(
    public readonly code:
      | 'NOT_VENDOR'
      | 'NOT_FOUND'
      | 'ALREADY_APPLIED'
      | 'VERIFY_FIRST'
      | 'INVALID_HOURS'
      | 'INVALID_PRICES'
      | 'UNKNOWN_SPORT'
      | 'HAS_FUTURE_BOOKINGS'
      | 'INCOMPLETE'
      | 'ALREADY_SUBMITTED'
      | 'INVALID_ACCOUNT'
      | 'TOO_MANY_PHOTOS'
      | 'INVALID_IMAGE',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Hours = { weekday: number; opensAt: string; closesAt: string };
export type Price = {
  dayType: (typeof dayType.enumValues)[number];
  startTime: string;
  endTime: string;
  pricePerHour: number;
};
export type BranchInput = {
  name: string;
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  facilities: string[];
  rules: string | null;
};
export type CourtInput = { name: string; surface: string | null; slotMinutes: number; sports: string[] };
export type PolicyInput = {
  advanceType: 'fixed' | 'percentage' | 'none';
  advanceValue: number;
  cancelRefund: boolean;
  cancelWindowHours: number;
  noShowRefund: boolean;
  recurringAllowed: boolean;
  allowUnpaidCash: boolean;
};

const toMinutes = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};
const ACTIVE_BOOKING = ['held', 'pending_payment', 'confirmed'] as const;
// Days checked when making sure every open hour has a price: two weeks covers every weekday twice.
const PRICE_CHECK_DAYS = 14;

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
  ) {}

  /** Vendor mode, step one (Foundation 5.1). Needs the owner's ID submitted: the CNIC is reviewed with the venue. */
  async apply(userId: string, businessName: string) {
    const [existing] = await this.db.select({ id: vendors.id }).from(vendors).where(eq(vendors.ownerUserId, userId));
    if (existing) throw new VendorError('ALREADY_APPLIED', 'You already have a vendor account.');
    const [idDoc] = await this.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.userId, userId), ne(verifications.status, 'rejected')))
      .limit(1);
    if (!idDoc) throw new VendorError('VERIFY_FIRST', 'Verify your identity before applying as a venue.');
    const [user] = await this.db.select({ countryCode: users.countryCode }).from(users).where(eq(users.id, userId));
    const [vendor] = await this.db
      .insert(vendors)
      .values({ ownerUserId: userId, businessName: businessName.trim(), countryCode: user!.countryCode })
      .returning({ id: vendors.id, businessName: vendors.businessName, status: vendors.status });
    return vendor!;
  }

  /** Everything the setup screens show, with a checklist per branch. */
  async setup(userId: string, now = new Date()) {
    const [vendor] = await this.db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        status: vendors.status,
        countryCode: vendors.countryCode,
        currency: countries.currency,
      })
      .from(vendors)
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .where(eq(vendors.ownerUserId, userId));
    if (!vendor) return { vendor: null, branches: [], paymentAccounts: [] };

    const branchRows = await this.db
      .select()
      .from(branches)
      .where(eq(branches.vendorId, vendor.id))
      .orderBy(asc(branches.createdAt));
    const accounts = await this.listAccounts(vendor.id);
    const out = [];
    for (const b of branchRows) {
      const detail = await this.branchDetail(b.id);
      out.push({
        ...detail,
        checklist: await this.checklist(b.id, vendor.id, vendor.countryCode, now),
      });
    }
    return { vendor, branches: out, paymentAccounts: accounts };
  }

  async createBranch(userId: string, input: BranchInput) {
    const vendor = await this.ownVendor(userId);
    const [country] = await this.db
      .select({ timezone: countries.timezone })
      .from(countries)
      .where(eq(countries.code, vendor.countryCode));
    return this.db.transaction(async (tx) => {
      const [branch] = await tx
        .insert(branches)
        .values({ vendorId: vendor.id, timezone: country!.timezone, ...branchValues(input) })
        .returning({ id: branches.id });
      // Defaults from the schema (20% advance, refund up to 24 hours before). The vendor can change them.
      await tx.insert(venuePolicies).values({ branchId: branch!.id });
      return branch!;
    });
  }

  async updateBranch(userId: string, branchId: string, input: BranchInput) {
    await this.ownBranch(userId, branchId);
    await this.db
      .update(branches)
      .set({ ...branchValues(input), updatedAt: new Date() })
      .where(eq(branches.id, branchId));
    return { id: branchId };
  }

  /** Changes apply to new bookings only: existing bookings keep the policy snapshotted when held (spec 6.3). */
  async setPolicy(userId: string, branchId: string, input: PolicyInput) {
    await this.ownBranch(userId, branchId);
    await this.db
      .update(venuePolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(venuePolicies.branchId, branchId));
    return { id: branchId };
  }

  async createCourt(userId: string, branchId: string, input: CourtInput) {
    await this.ownBranch(userId, branchId);
    return this.db.transaction(async (tx) => {
      const sportIds = await this.sportIds(tx, input.sports);
      const [court] = await tx
        .insert(courts)
        .values({
          branchId,
          name: input.name.trim(),
          surface: input.surface?.trim() || null,
          slotMinutes: input.slotMinutes,
        })
        .returning({ id: courts.id });
      await tx.insert(courtSports).values(sportIds.map((sportId) => ({ courtId: court!.id, sportId })));
      return court!;
    });
  }

  async updateCourt(userId: string, courtId: string, input: CourtInput & { active: boolean }, now = new Date()) {
    await this.ownCourt(userId, courtId);
    if (!input.active) await this.assertNoFutureBookings(courtId, now);
    await this.db.transaction(async (tx) => {
      const sportIds = await this.sportIds(tx, input.sports);
      await tx
        .update(courts)
        .set({
          name: input.name.trim(),
          surface: input.surface?.trim() || null,
          slotMinutes: input.slotMinutes,
          active: input.active,
          updatedAt: now,
        })
        .where(eq(courts.id, courtId));
      await tx.delete(courtSports).where(eq(courtSports.courtId, courtId));
      await tx.insert(courtSports).values(sportIds.map((sportId) => ({ courtId, sportId })));
    });
    return { id: courtId };
  }

  /** Replaces the court's opening hours. Existing bookings stay; new slots follow the new hours (spec 6.3). */
  async setHours(userId: string, courtId: string, hours: Hours[]) {
    await this.ownCourt(userId, courtId);
    const seen = new Map<number, [number, number][]>();
    for (const h of hours) {
      const open = toMinutes(h.opensAt);
      let close = toMinutes(h.closesAt);
      if (close <= open) close += 24 * 60; // closes after midnight
      const day = seen.get(h.weekday) ?? [];
      if (day.some(([o, c]) => open < c && close > o)) {
        throw new VendorError('INVALID_HOURS', 'Opening hours on the same day must not overlap.');
      }
      day.push([open, close]);
      seen.set(h.weekday, day);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(openingHours).where(eq(openingHours.courtId, courtId));
      if (hours.length) await tx.insert(openingHours).values(hours.map((h) => ({ courtId, ...h })));
    });
    return { id: courtId };
  }

  /** Replaces the court's price rules. Only new bookings use them: held and confirmed ones keep their price. */
  async setPrices(userId: string, courtId: string, prices: Price[]) {
    await this.ownCourt(userId, courtId);
    const byType = new Map<string, [number, number][]>();
    for (const p of prices) {
      const from = toMinutes(p.startTime);
      const to = toMinutes(p.endTime) || 24 * 60; // '00:00' ends at midnight
      if (to <= from) throw new VendorError('INVALID_PRICES', 'Each price must end after it starts.');
      const ranges = byType.get(p.dayType) ?? [];
      if (ranges.some(([f, t]) => from < t && to > f)) {
        throw new VendorError('INVALID_PRICES', 'Prices for the same kind of day must not overlap.');
      }
      ranges.push([from, to]);
      byType.set(p.dayType, ranges);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(priceRules).where(eq(priceRules.courtId, courtId));
      if (prices.length) await tx.insert(priceRules).values(prices.map((p) => ({ courtId, ...p })));
    });
    return { id: courtId };
  }

  /** New or replacement account. Players only see it after admin approval; a replaced one stays active until then. */
  async addAccount(
    userId: string,
    input: {
      method: (typeof paymentMethod.enumValues)[number];
      accountTitle: string;
      accountNumber?: string;
      bankName?: string;
      replacesAccountId?: string;
    },
  ) {
    const vendor = await this.ownVendor(userId);
    const number = input.accountNumber?.trim() ?? '';
    if (input.method !== 'cash' && number.length < 6) {
      throw new VendorError('INVALID_ACCOUNT', 'Enter the account or wallet number players should pay into.');
    }
    if (input.method === 'bank_transfer' && !input.bankName?.trim()) {
      throw new VendorError('INVALID_ACCOUNT', 'Enter the bank name.');
    }
    if (input.replacesAccountId) {
      const [old] = await this.db
        .select({ id: paymentAccounts.id })
        .from(paymentAccounts)
        .where(and(eq(paymentAccounts.id, input.replacesAccountId), eq(paymentAccounts.vendorId, vendor.id)));
      if (!old) throw new VendorError('NOT_FOUND', 'Account not found.');
    }
    const [row] = await this.db
      .insert(paymentAccounts)
      .values({
        vendorId: vendor.id,
        method: input.method,
        accountTitle: input.accountTitle.trim(),
        accountNumberEncrypted: input.method === 'cash' ? null : this.crypto.encryptAccount(number),
        bankName: input.method === 'bank_transfer' ? input.bankName!.trim() : null,
        replacesAccountId: input.replacesAccountId ?? null,
      })
      .returning({ id: paymentAccounts.id, status: paymentAccounts.status });
    return row!;
  }

  /** Sends a complete branch for review and requests the site visit every venue needs (Foundation 5.1). */
  async submit(userId: string, branchId: string, now = new Date()) {
    const branch = await this.ownBranch(userId, branchId);
    if (branch.status !== 'draft') {
      throw new VendorError('ALREADY_SUBMITTED', 'This venue has already been sent for review.');
    }
    const items = await this.checklist(branchId, branch.vendorId, branch.countryCode, now);
    const missing = items.filter((i) => !i.done);
    if (missing.length) {
      throw new VendorError(
        'INCOMPLETE',
        `Before sending for review: ${missing.map((m) => m.label.toLowerCase()).join('; ')}.`,
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.update(branches).set({ status: 'pending_visit', updatedAt: now }).where(eq(branches.id, branchId));
      await tx.insert(siteVisits).values({ branchId, requestedBy: 'vendor' });
    });
    return { id: branchId, status: 'pending_visit' as const };
  }

  /** What is still missing before a branch can be reviewed. */
  async checklist(branchId: string, vendorId: string, countryCode: string, now: Date) {
    const detail = await this.branchDetail(branchId);
    const active = detail.courts.filter((c) => c.active);
    const [account] = await this.db
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.vendorId, vendorId), ne(paymentAccounts.status, 'rejected')))
      .limit(1);
    const hol = await this.db.select({ day: holidays.day }).from(holidays).where(eq(holidays.countryCode, countryCode));
    const holidaySet = new Set(hol.map((h) => h.day));
    const weekendDays = await getSetting(this.db, 'calendar.weekend_days', countryCode);
    const unpriced = active.filter(
      (c) => c.hours.length && !everySlotPriced(c, detail.timezone, holidaySet, weekendDays, now),
    );
    return [
      { key: 'courts', done: active.length > 0, label: 'Add at least one court' },
      {
        key: 'sports',
        done: active.length > 0 && active.every((c) => c.sports.length),
        label: 'Choose the sports for each court',
      },
      {
        key: 'hours',
        done: active.length > 0 && active.every((c) => c.hours.length),
        label: 'Set opening hours for each court',
      },
      {
        key: 'prices',
        done: active.length > 0 && active.every((c) => c.prices.length) && unpriced.length === 0,
        label: unpriced.length
          ? `Set a price for every open hour (${unpriced.map((c) => c.name).join(', ')})`
          : 'Set prices for each court',
      },
      { key: 'payment', done: !!account, label: 'Add an account players can pay into' },
    ];
  }

  private async branchDetail(branchId: string) {
    const [b] = await this.db
      .select({
        branch: branches,
        latitude: sql<number>`ST_Y(${branches.location}::geometry)`,
        longitude: sql<number>`ST_X(${branches.location}::geometry)`,
      })
      .from(branches)
      .where(eq(branches.id, branchId))
      .then((rows) => rows.map((r) => ({ ...r.branch, latitude: Number(r.latitude), longitude: Number(r.longitude) })));
    const [policy] = await this.db.select().from(venuePolicies).where(eq(venuePolicies.branchId, branchId));
    const [visit] = await this.db
      .select({ scheduledAt: siteVisits.scheduledAt, result: siteVisits.result, notes: siteVisits.notes })
      .from(siteVisits)
      .where(eq(siteVisits.branchId, branchId))
      .orderBy(desc(siteVisits.createdAt))
      .limit(1);
    const courtRows = await this.db
      .select()
      .from(courts)
      .where(eq(courts.branchId, branchId))
      .orderBy(asc(courts.createdAt));
    const ids = courtRows.map((c) => c.id);
    const [sportRows, hourRows, priceRows] = ids.length
      ? await Promise.all([
          this.db
            .select({ courtId: courtSports.courtId, slug: sports.slug })
            .from(courtSports)
            .innerJoin(sports, eq(sports.id, courtSports.sportId))
            .where(inArray(courtSports.courtId, ids)),
          this.db.select().from(openingHours).where(inArray(openingHours.courtId, ids)),
          this.db.select().from(priceRules).where(inArray(priceRules.courtId, ids)),
        ])
      : [[], [], []];
    const hhmm = (t: string) => t.slice(0, 5);
    return {
      id: b!.id,
      name: b!.name,
      address: b!.address,
      city: b!.city,
      latitude: b!.latitude,
      longitude: b!.longitude,
      facilities: b!.facilities,
      photos: b!.photoKeys.map(photoUrl),
      rules: b!.rules,
      timezone: b!.timezone,
      status: b!.status,
      visit: visit ?? null,
      policy: {
        advanceType: policy!.advanceType,
        advanceValue: policy!.advanceValue,
        cancelRefund: policy!.cancelRefund,
        cancelWindowHours: policy!.cancelWindowHours,
        noShowRefund: policy!.noShowRefund,
        recurringAllowed: policy!.recurringAllowed,
        allowUnpaidCash: policy!.allowUnpaidCash,
      },
      courts: courtRows.map((c) => ({
        id: c.id,
        name: c.name,
        surface: c.surface,
        slotMinutes: c.slotMinutes,
        active: c.active,
        sports: sportRows.filter((s) => s.courtId === c.id).map((s) => s.slug),
        hours: hourRows
          .filter((h) => h.courtId === c.id)
          .map((h) => ({ weekday: h.weekday, opensAt: hhmm(h.opensAt), closesAt: hhmm(h.closesAt) }))
          .sort((x, y) => x.weekday - y.weekday || x.opensAt.localeCompare(y.opensAt)),
        prices: priceRows
          .filter((p) => p.courtId === c.id)
          .map((p) => ({
            dayType: p.dayType,
            startTime: hhmm(p.startTime),
            endTime: hhmm(p.endTime),
            pricePerHour: p.pricePerHour,
          }))
          .sort((x, y) => x.dayType.localeCompare(y.dayType) || x.startTime.localeCompare(y.startTime)),
      })),
    };
  }

  private async listAccounts(vendorId: string) {
    const rows = await this.db
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.vendorId, vendorId))
      .orderBy(asc(paymentAccounts.createdAt));
    // Masked even for the owner: the full number is only needed by players paying, and by admins reviewing.
    return rows.map((a) => ({
      id: a.id,
      method: a.method,
      accountTitle: a.accountTitle,
      bankName: a.bankName,
      accountNumberEnding: a.accountNumberEncrypted
        ? this.crypto.decryptAccount(a.accountNumberEncrypted).slice(-4)
        : null,
      status: a.status,
      replacesAccountId: a.replacesAccountId,
    }));
  }

  private async sportIds(tx: Tx, slugs: string[]) {
    const rows = slugs.length
      ? await tx
          .select({ id: sports.id })
          .from(sports)
          .where(and(inArray(sports.slug, slugs), eq(sports.active, true)))
      : [];
    if (!slugs.length || rows.length !== new Set(slugs).size) {
      throw new VendorError('UNKNOWN_SPORT', 'Choose at least one sport from the list.');
    }
    return rows.map((r) => r.id);
  }

  private async assertNoFutureBookings(courtId: string, now: Date) {
    const [future] = await this.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.courtId, courtId), gt(bookings.endAt, now), inArray(bookings.status, [...ACTIVE_BOOKING])))
      .limit(1);
    if (future) {
      throw new VendorError('HAS_FUTURE_BOOKINGS', 'This court has upcoming bookings. Move or cancel them first.');
    }
  }

  private async ownVendor(userId: string) {
    const [v] = await this.db
      .select({ id: vendors.id, countryCode: vendors.countryCode, status: vendors.status })
      .from(vendors)
      .where(eq(vendors.ownerUserId, userId));
    if (!v) throw new VendorError('NOT_VENDOR', 'Apply as a venue first.');
    return v;
  }

  private async ownBranch(userId: string, branchId: string) {
    const [b] = await this.db
      .select({ id: branches.id, status: branches.status, vendorId: vendors.id, countryCode: vendors.countryCode })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(eq(branches.id, branchId), eq(vendors.ownerUserId, userId)));
    if (!b) throw new VendorError('NOT_FOUND', 'Venue not found.');
    return b;
  }

  private async ownCourt(userId: string, courtId: string) {
    const [c] = await this.db
      .select({ id: courts.id })
      .from(courts)
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(eq(courts.id, courtId), eq(vendors.ownerUserId, userId)));
    if (!c) throw new VendorError('NOT_FOUND', 'Court not found.');
    return c;
  }
}

function branchValues(input: BranchInput) {
  return {
    name: input.name.trim(),
    address: input.address.trim(),
    city: input.city.trim(),
    // WKT is longitude first. This is the venue's public business location, not a person's.
    location: `SRID=4326;POINT(${input.longitude} ${input.latitude})`,
    facilities: input.facilities,
    rules: input.rules?.trim() || null,
  };
}

/** True if every slot the court opens in the next two weeks has a price, using the booking engine's own pricing. */
function everySlotPriced(
  court: { hours: Hours[]; prices: Price[]; slotMinutes: number },
  timezone: string,
  holidaySet: ReadonlySet<string>,
  weekendDays: readonly number[],
  now: Date,
) {
  for (let i = 0; i < PRICE_CHECK_DAYS; i++) {
    const date = new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const [from, to] of slotTimes(weekday, court.hours, court.slotMinutes)) {
      try {
        calculatePrice(
          localToInstant(date, from, timezone),
          localToInstant(date, to, timezone),
          timezone,
          court.prices,
          holidaySet,
          weekendDays,
        );
      } catch {
        return false;
      }
    }
  }
  return true;
}
