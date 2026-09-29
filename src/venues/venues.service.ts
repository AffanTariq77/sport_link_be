import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, inArray, isNull, lt, or } from 'drizzle-orm';
import { calculatePrice, localToInstant, slotTimes, toLocal } from '../bookings/pricing.js';
import { DB } from '../db/db.module.js';
import { photoUrl } from '../vendors/photos.service.js';
import type { Db } from '../db/client.js';
import {
  bookings,
  branches,
  countries,
  courts,
  courtSports,
  holidays,
  openingHours,
  paymentAccounts,
  priceRules,
  sports,
  vendors,
  venuePolicies,
} from '../db/schema.js';
import { getSetting } from '../settings.js';

export class VenueError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID_DATE',
    message: string,
  ) {
    super(message);
  }
}

// Only live branches of approved vendors are visible to players (Foundation 5.1).
const visible = and(eq(branches.status, 'live'), eq(vendors.status, 'approved'));

@Injectable()
export class VenuesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  listSports() {
    return this.db
      .select({ slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(asc(sports.name));
  }

  /** Venues players can book, optionally filtered by sport and city. */
  async list(filter: { sport?: string; city?: string }) {
    const rows = await this.db
      .select({
        id: branches.id,
        name: branches.name,
        city: branches.city,
        address: branches.address,
        facilities: branches.facilities,
        photoKeys: branches.photoKeys,
        currency: countries.currency,
        sport: sports.name,
        sportSlug: sports.slug,
        courtId: courts.id,
      })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .innerJoin(courts, and(eq(courts.branchId, branches.id), eq(courts.active, true)))
      .innerJoin(courtSports, eq(courtSports.courtId, courts.id))
      .innerJoin(sports, eq(sports.id, courtSports.sportId))
      .where(and(visible, filter.city ? ilike(branches.city, filter.city) : undefined))
      .orderBy(asc(branches.name))
      .limit(500);

    const prices = rows.length
      ? await this.db
          .select({ courtId: priceRules.courtId, pricePerHour: priceRules.pricePerHour })
          .from(priceRules)
          .where(inArray(priceRules.courtId, [...new Set(rows.map((r) => r.courtId))]))
      : [];

    // ponytail: grouped in memory, fine for one launch city. Move to SQL with paging when venues number in the thousands.
    const venues = new Map<
      string,
      Omit<(typeof rows)[number], 'sport' | 'sportSlug' | 'courtId'> & {
        sports: Set<string>;
        slugs: Set<string>;
        courts: Set<string>;
        fromPricePerHour: number | null;
      }
    >();
    for (const { sport, sportSlug, courtId, ...v } of rows) {
      const venue = venues.get(v.id) ?? {
        ...v,
        sports: new Set(),
        slugs: new Set(),
        courts: new Set(),
        fromPricePerHour: null,
      };
      venue.sports.add(sport);
      venue.slugs.add(sportSlug);
      venue.courts.add(courtId);
      venues.set(v.id, venue);
    }
    const venueOfCourt = new Map(rows.map((r) => [r.courtId, r.id]));
    for (const p of prices) {
      const venue = venues.get(venueOfCourt.get(p.courtId)!)!;
      venue.fromPricePerHour = Math.min(venue.fromPricePerHour ?? Infinity, p.pricePerHour);
    }
    return [...venues.values()]
      .filter((v) => !filter.sport || v.slugs.has(filter.sport))
      .map((v) => ({
        id: v.id,
        name: v.name,
        city: v.city,
        address: v.address,
        facilities: v.facilities,
        photos: v.photoKeys.map(photoUrl),
        currency: v.currency,
        fromPricePerHour: v.fromPricePerHour,
        sports: [...v.sports].sort(),
        courtCount: v.courts.size,
      }));
  }

  /** Venue page: courts, the refund policy shown before paying (CLAUDE.md), and accepted payment methods. */
  async get(branchId: string) {
    const [branch] = await this.db
      .select({
        id: branches.id,
        vendorId: vendors.id,
        name: branches.name,
        city: branches.city,
        address: branches.address,
        facilities: branches.facilities,
        rules: branches.rules,
        photoKeys: branches.photoKeys,
        timezone: branches.timezone,
        currency: countries.currency,
      })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .where(and(eq(branches.id, branchId), visible));
    if (!branch) throw new VenueError('NOT_FOUND', 'This venue is not available.');

    const courtRows = await this.db
      .select({
        id: courts.id,
        name: courts.name,
        surface: courts.surface,
        slotMinutes: courts.slotMinutes,
        sport: sports.name,
      })
      .from(courts)
      .innerJoin(courtSports, eq(courtSports.courtId, courts.id))
      .innerJoin(sports, eq(sports.id, courtSports.sportId))
      .where(and(eq(courts.branchId, branchId), eq(courts.active, true)))
      .orderBy(asc(courts.name));
    const courtList = new Map<string, Omit<(typeof courtRows)[number], 'sport'> & { sports: string[] }>();
    for (const { sport, ...c } of courtRows) {
      const court = courtList.get(c.id) ?? { ...c, sports: [] };
      court.sports.push(sport);
      courtList.set(c.id, court);
    }

    const [policy] = await this.db
      .select({
        advanceType: venuePolicies.advanceType,
        advanceValue: venuePolicies.advanceValue,
        cancelRefund: venuePolicies.cancelRefund,
        cancelWindowHours: venuePolicies.cancelWindowHours,
        noShowRefund: venuePolicies.noShowRefund,
        recurringAllowed: venuePolicies.recurringAllowed,
      })
      .from(venuePolicies)
      .where(eq(venuePolicies.branchId, branchId));
    if (!policy) throw new VenueError('NOT_FOUND', 'This venue is not available.');

    // Methods only. Account details are shown when paying, and only approved accounts (Foundation 8.1).
    const methods = await this.db
      .selectDistinct({ method: paymentAccounts.method })
      .from(paymentAccounts)
      .where(and(eq(paymentAccounts.vendorId, branch.vendorId), eq(paymentAccounts.status, 'approved')));

    return {
      id: branch.id,
      name: branch.name,
      city: branch.city,
      address: branch.address,
      facilities: branch.facilities,
      photos: branch.photoKeys.map(photoUrl),
      rules: branch.rules,
      timezone: branch.timezone,
      currency: branch.currency,
      courts: [...courtList.values()],
      policy,
      paymentMethods: methods.map((m) => m.method).sort(),
    };
  }

  /** Bookable slots on a court for one local date at the venue. */
  async slots(courtId: string, date: string, now = new Date()) {
    const [court] = await this.db
      .select({
        slotMinutes: courts.slotMinutes,
        timezone: branches.timezone,
        countryCode: vendors.countryCode,
        currency: countries.currency,
      })
      .from(courts)
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .innerJoin(countries, eq(countries.code, vendors.countryCode))
      .where(and(eq(courts.id, courtId), eq(courts.active, true), visible));
    if (!court) throw new VenueError('NOT_FOUND', 'This court is not available.');
    if (date < toLocal(now, court.timezone).date) throw new VenueError('INVALID_DATE', 'Choose today or a later date.');

    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [hours, rules, hol, weekendDays, step] = await Promise.all([
      this.db.select().from(openingHours).where(eq(openingHours.courtId, courtId)),
      this.db.select().from(priceRules).where(eq(priceRules.courtId, courtId)),
      this.db.select({ day: holidays.day }).from(holidays).where(eq(holidays.countryCode, court.countryCode)),
      getSetting(this.db, 'calendar.weekend_days', court.countryCode),
      getSetting(this.db, 'booking.slot_step_minutes', court.countryCode),
    ]);
    const times = slotTimes(weekday, hours, court.slotMinutes);
    if (!times.length) return { currency: court.currency, slots: [] };

    const dayStart = localToInstant(date, times[0]![0], court.timezone);
    const dayEnd = localToInstant(date, times.at(-1)![1], court.timezone);
    // Same statuses the bookings_no_overlap constraint blocks, minus holds and payments past their deadline.
    const taken = await this.db
      .select({ startAt: bookings.startAt, endAt: bookings.endAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.courtId, courtId),
          lt(bookings.startAt, dayEnd),
          gt(bookings.endAt, dayStart),
          or(
            eq(bookings.status, 'confirmed'),
            and(eq(bookings.status, 'held'), gt(bookings.holdExpiresAt, now)),
            and(
              eq(bookings.status, 'pending_payment'),
              or(isNull(bookings.paymentDeadlineAt), gt(bookings.paymentDeadlineAt, now)),
            ),
          ),
        ),
      );

    const holidaySet = new Set(hol.map((h) => h.day));
    const slots = [];
    for (const [from, to] of times) {
      const startAt = localToInstant(date, from, court.timezone);
      const endAt = localToInstant(date, to, court.timezone);
      if (startAt <= now) continue;
      let price: number;
      try {
        price = calculatePrice(startAt, endAt, court.timezone, rules, holidaySet, weekendDays, step);
      } catch {
        continue; // no price set for this time: not bookable
      }
      const available = !taken.some((b) => b.startAt < endAt && b.endAt > startAt);
      slots.push({ startAt, endAt, price, available });
    }
    return { currency: court.currency, slots };
  }
}
