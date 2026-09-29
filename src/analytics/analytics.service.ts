import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { calculatePrice, localToInstant, slotTimes, toLocal } from '../bookings/pricing.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { hasPgCode } from '../db/errors.js';
import {
  bookings,
  branches,
  courts,
  courtSports,
  holidays,
  invoices,
  matches,
  matchPlayers,
  openingHours,
  priceRules,
  sports,
  users,
  vendors,
  venueReviews,
} from '../db/schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { getSetting } from '../settings.js';
import { vendorAccess } from '../vendors/access.js';

export class AnalyticsError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'REVIEW_CLOSED' | 'ALREADY_REVIEWED' | 'INVALID_RANGE',
    message: string,
  ) {
    super(message);
  }
}

const DAY = 86_400_000;
const COUNTED = ['confirmed', 'completed', 'no_show'] as const; // bookings that made money for the venue

/**
 * Venue reviews, vendor analytics and the revenue calculator (spec 13.2), and platform analytics for admins
 * (Foundation 7). Figures are computed on request from the live tables.
 */
// ponytail: computed per request; add rollup tables or a read replica once venues have years of bookings.
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  // ---------- venue reviews ----------

  /** The booker reviews the venue once, after playing, within review.venue_window_days. */
  async reviewVenue(userId: string, bookingId: string, input: { stars: number; comment?: string }, now = new Date()) {
    const [b] = await this.db
      .select({
        createdBy: bookings.createdBy,
        source: bookings.source,
        status: bookings.status,
        endAt: bookings.endAt,
        branchId: courts.branchId,
        vendorId: branches.vendorId,
      })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(eq(bookings.id, bookingId));
    if (!b || b.createdBy !== userId || b.source !== 'app') throw new AnalyticsError('NOT_FOUND', 'Booking not found.');
    const days = await getSetting(this.db, 'review.venue_window_days');
    if (
      !['confirmed', 'completed'].includes(b.status) ||
      b.endAt > now ||
      now.getTime() > b.endAt.getTime() + days * DAY
    )
      throw new AnalyticsError('REVIEW_CLOSED', `You can review a venue for ${days} days after you play there.`);
    try {
      await this.db.insert(venueReviews).values({
        bookingId,
        branchId: b.branchId,
        userId,
        stars: input.stars,
        comment: input.comment?.trim() || null,
      });
    } catch (err) {
      if (hasPgCode(err, '23505'))
        throw new AnalyticsError('ALREADY_REVIEWED', 'You have already reviewed this booking.');
      throw err;
    }
    if (this.notes)
      await this.notes.notify(await this.notes.vendorRecipients(b.vendorId, 'view_bookings', b.branchId), {
        kind: 'vendor',
        title: 'New review',
        body: `A player gave your venue ${input.stars} ${input.stars === 1 ? 'star' : 'stars'}.`,
        link: '/vendor/analytics',
        refId: bookingId,
      });
    return { ok: true };
  }

  /** Public reviews for a venue page, newest first, with the venue's replies. Reviewer first names only. */
  async venueReviews(branchId: string) {
    const [summary] = await this.db
      .select({ average: sql<number | null>`avg(${venueReviews.stars})::float`, count: sql<number>`count(*)::int` })
      .from(venueReviews)
      .where(eq(venueReviews.branchId, branchId));
    const rows = await this.db
      .select({
        id: venueReviews.id,
        stars: venueReviews.stars,
        comment: venueReviews.comment,
        reply: venueReviews.reply,
        createdAt: venueReviews.createdAt,
        name: users.name,
      })
      .from(venueReviews)
      .innerJoin(users, eq(users.id, venueReviews.userId))
      .where(eq(venueReviews.branchId, branchId))
      .orderBy(desc(venueReviews.createdAt))
      .limit(30);
    return {
      average:
        summary?.average === null || summary?.average === undefined ? null : Math.round(summary.average * 10) / 10,
      count: Number(summary?.count ?? 0),
      reviews: rows.map(({ name, ...r }) => ({ ...r, author: (name ?? 'Player').split(' ')[0]! })),
    };
  }

  async reply(userId: string, reviewId: string, reply: string, now = new Date()) {
    const [r] = await this.db
      .select({ branchId: venueReviews.branchId })
      .from(venueReviews)
      .where(eq(venueReviews.id, reviewId));
    const { branchIds } = await vendorAccess(this.db, userId, 'view_bookings');
    if (!r || !branchIds.includes(r.branchId)) throw new AnalyticsError('NOT_FOUND', 'Review not found.');
    await this.db
      .update(venueReviews)
      .set({ reply: reply.trim(), repliedBy: userId, repliedAt: now })
      .where(eq(venueReviews.id, reviewId));
    return { ok: true };
  }

  // ---------- vendor analytics ----------

  /** Bookings, occupancy by weekday and hour, revenue by court and source, cancellations, rating trend (13.2). */
  async vendor(userId: string, range: { from: Date; to: Date }) {
    this.checkRange(range);
    const { branchIds } = await vendorAccess(this.db, userId, 'view_revenue');
    if (!branchIds.length) throw new AnalyticsError('NOT_FOUND', 'No venues to show.');
    const courtRows = await this.db
      .select({
        id: courts.id,
        name: courts.name,
        branch: branches.name,
        branchId: branches.id,
        timezone: branches.timezone,
        slotMinutes: courts.slotMinutes,
      })
      .from(courts)
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(inArray(courts.branchId, branchIds));
    const courtIds = courtRows.map((c) => c.id);
    const rows = courtIds.length
      ? await this.db
          .select({
            courtId: bookings.courtId,
            source: bookings.source,
            status: bookings.status,
            cancelledBy: bookings.cancelledBy,
            startAt: bookings.startAt,
            endAt: bookings.endAt,
            total: bookings.total,
            currency: bookings.currency,
          })
          .from(bookings)
          .where(
            and(
              inArray(bookings.courtId, courtIds),
              ne(bookings.source, 'block'),
              gte(bookings.startAt, range.from),
              lt(bookings.startAt, range.to),
            ),
          )
      : [];
    const counted = rows.filter((r) => (COUNTED as readonly string[]).includes(r.status));
    const currency = rows[0]?.currency ?? 'PKR';
    const tz = courtRows[0]?.timezone ?? 'Asia/Karachi';

    // Occupancy: booked hours per weekday and local hour, and overall against open hours in the range.
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    let bookedMinutes = 0;
    for (const b of counted) {
      const c = courtRows.find((x) => x.id === b.courtId)!;
      for (let t = b.startAt.getTime(); t < b.endAt.getTime(); t += 30 * 60_000) {
        const local = toLocal(new Date(t), c.timezone);
        heat[local.weekday]![Math.floor(local.minutes / 60)]! += 0.5;
        bookedMinutes += 30;
      }
    }
    const hours = courtIds.length
      ? await this.db.select().from(openingHours).where(inArray(openingHours.courtId, courtIds))
      : [];
    let openMinutes = 0;
    for (let d = range.from.getTime(); d < range.to.getTime(); d += DAY) {
      const weekday = toLocal(new Date(d), tz).weekday;
      for (const c of courtRows)
        for (const [a, b] of slotTimes(
          weekday,
          hours.filter((h) => h.courtId === c.id),
          c.slotMinutes,
        ))
          openMinutes += b - a;
    }
    const byCourt = courtRows.map((c) => {
      const mine = counted.filter((b) => b.courtId === c.id);
      return {
        courtId: c.id,
        court: c.name,
        branch: c.branch,
        bookings: mine.length,
        revenue: mine.reduce((s, b) => s + b.total, 0),
      };
    });
    const cancelled = rows.filter((r) => r.status === 'cancelled');
    const trend = await this.db
      .select({
        month: sql<string>`to_char(${venueReviews.createdAt} at time zone ${tz}, 'YYYY-MM')`,
        average: sql<number>`avg(${venueReviews.stars})::float`,
        count: sql<number>`count(*)::int`,
      })
      .from(venueReviews)
      .where(
        and(
          inArray(venueReviews.branchId, branchIds),
          gte(venueReviews.createdAt, new Date(range.to.getTime() - 365 * DAY)),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const latest = await this.db
      .select({
        id: venueReviews.id,
        branch: branches.name,
        stars: venueReviews.stars,
        comment: venueReviews.comment,
        reply: venueReviews.reply,
        createdAt: venueReviews.createdAt,
      })
      .from(venueReviews)
      .innerJoin(branches, eq(branches.id, venueReviews.branchId))
      .where(inArray(venueReviews.branchId, branchIds))
      .orderBy(desc(venueReviews.createdAt))
      .limit(20);
    return {
      currency,
      from: range.from,
      to: range.to,
      bookings: {
        total: rows.length,
        app: rows.filter((r) => r.source === 'app').length,
        manual: rows.filter((r) => r.source === 'manual').length,
        completed: rows.filter((r) => r.status === 'completed').length,
        noShows: rows.filter((r) => r.status === 'no_show').length,
      },
      revenue: {
        total: counted.reduce((s, b) => s + b.total, 0),
        app: counted.filter((b) => b.source === 'app').reduce((s, b) => s + b.total, 0),
        manual: counted.filter((b) => b.source === 'manual').reduce((s, b) => s + b.total, 0),
        byCourt,
      },
      occupancy: {
        percent: openMinutes ? Math.round((bookedMinutes / openMinutes) * 1000) / 10 : 0,
        heatmap: heat, // [weekday 0 = Sunday][local hour] = booked hours
      },
      cancellations: {
        total: cancelled.length,
        byPlayer: cancelled.filter((r) => r.cancelledBy === 'player').length,
        byVenue: cancelled.filter((r) => r.cancelledBy === 'vendor').length,
      },
      ratingTrend: trend.map((t) => ({
        month: t.month,
        average: Math.round(t.average * 10) / 10,
        count: Number(t.count),
      })),
      reviews: latest,
    };
  }

  /**
   * Revenue calculator (spec 13.2): what the next 30 days of open hours would earn at the price rules, at a given
   * occupancy (default: the last 30 days' occupancy).
   */
  async calculator(userId: string, occupancy: number | undefined, now = new Date()) {
    const { branchIds } = await vendorAccess(this.db, userId, 'view_revenue');
    if (!branchIds.length) throw new AnalyticsError('NOT_FOUND', 'No venues to show.');
    const rate =
      occupancy ?? (await this.vendor(userId, { from: new Date(now.getTime() - 30 * DAY), to: now })).occupancy.percent;
    const courtRows = await this.db
      .select({
        id: courts.id,
        name: courts.name,
        branch: branches.name,
        timezone: branches.timezone,
        slotMinutes: courts.slotMinutes,
        countryCode: vendors.countryCode,
      })
      .from(courts)
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .where(and(inArray(courts.branchId, branchIds), eq(courts.active, true)));
    const out = [];
    for (const c of courtRows) {
      const [hours, rules, hol, weekendDays, step] = await Promise.all([
        this.db.select().from(openingHours).where(eq(openingHours.courtId, c.id)),
        this.db.select().from(priceRules).where(eq(priceRules.courtId, c.id)),
        this.db.select({ day: holidays.day }).from(holidays).where(eq(holidays.countryCode, c.countryCode)),
        getSetting(this.db, 'calendar.weekend_days', c.countryCode),
        getSetting(this.db, 'booking.slot_step_minutes', c.countryCode),
      ]);
      const holidaySet = new Set(hol.map((h) => h.day));
      let full = 0;
      for (let d = 0; d < 30; d++) {
        const date = toLocal(new Date(now.getTime() + d * DAY), c.timezone).date;
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        for (const [from, to] of slotTimes(weekday, hours, c.slotMinutes)) {
          try {
            full += calculatePrice(
              localToInstant(date, from, c.timezone),
              localToInstant(date, to, c.timezone),
              c.timezone,
              rules,
              holidaySet,
              weekendDays,
              step,
            );
          } catch {
            // no price for this hour: it cannot be booked, so it earns nothing
          }
        }
      }
      out.push({
        courtId: c.id,
        court: c.name,
        branch: c.branch,
        fullMonth: full,
        projected: Math.round((full * rate) / 100),
      });
    }
    return {
      occupancy: rate,
      courts: out,
      projected: out.reduce((s, c) => s + c.projected, 0),
      fullMonth: out.reduce((s, c) => s + c.fullMonth, 0),
    };
  }

  // ---------- platform analytics (admin) ----------

  async platform(range: { from: Date; to: Date }) {
    this.checkRange(range);
    const inRange = and(
      gte(bookings.startAt, range.from),
      lt(bookings.startAt, range.to),
      ne(bookings.source, 'block'),
    );
    const value = await this.db
      .select({
        currency: bookings.currency,
        source: bookings.source,
        count: sql<number>`count(*)::int`,
        amount: sql<number>`coalesce(sum(${bookings.total}), 0)::bigint`,
      })
      .from(bookings)
      .where(and(inRange, inArray(bookings.status, [...COUNTED])))
      .groupBy(bookings.currency, bookings.source);
    const [due] = await this.db
      .select({ amount: sql<number>`coalesce(sum(${invoices.amount}), 0)::bigint` })
      .from(invoices)
      .where(inArray(invoices.status, ['issued', 'overdue']));
    const [collected] = await this.db
      .select({ amount: sql<number>`coalesce(sum(${invoices.amount}), 0)::bigint` })
      .from(invoices)
      .where(and(eq(invoices.status, 'paid'), gte(invoices.paidAt, range.from), lt(invoices.paidAt, range.to)));
    const active = async (from: Date, to: Date) => {
      const booked = await this.db
        .selectDistinct({ id: bookings.createdBy })
        .from(bookings)
        .where(
          and(
            eq(bookings.source, 'app'),
            isNotNull(bookings.createdBy),
            gte(bookings.createdAt, from),
            lt(bookings.createdAt, to),
          ),
        );
      const played = await this.db
        .selectDistinct({ id: matchPlayers.userId })
        .from(matchPlayers)
        .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
        .where(and(gte(matches.startAt, from), lt(matches.startAt, to)));
      return new Set([...booked, ...played].map((x) => x.id!));
    };
    const length = range.to.getTime() - range.from.getTime();
    const [now, before] = await Promise.all([
      active(range.from, range.to),
      active(new Date(range.from.getTime() - length), range.from),
    ]);
    const retained = [...before].filter((id) => now.has(id)).length;
    const [newUsers] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(gte(users.createdAt, range.from), lt(users.createdAt, range.to)));
    const top = await this.db
      .select({ branchId: branches.id, name: branches.name, city: branches.city, bookings: sql<number>`count(*)::int` })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(and(inRange, inArray(bookings.status, [...COUNTED])))
      .groupBy(branches.id)
      .orderBy(desc(sql`count(*)`))
      .limit(10);
    const cities = await this.db
      .select({ city: branches.city, bookings: sql<number>`count(*)::int` })
      .from(bookings)
      .innerJoin(courts, eq(courts.id, bookings.courtId))
      .innerJoin(branches, eq(branches.id, courts.branchId))
      .where(and(inRange, inArray(bookings.status, [...COUNTED])))
      .groupBy(branches.city)
      .orderBy(desc(sql`count(*)`));
    // A court can host several sports, so a booking counts once for each of its court's sports.
    const bySport = await this.db
      .select({ sport: sports.name, bookings: sql<number>`count(distinct ${bookings.id})::int` })
      .from(bookings)
      .innerJoin(courtSports, eq(courtSports.courtId, bookings.courtId))
      .innerJoin(sports, eq(sports.id, courtSports.sportId))
      .where(and(inRange, inArray(bookings.status, [...COUNTED])))
      .groupBy(sports.name)
      .orderBy(desc(sql`count(distinct ${bookings.id})`));
    return {
      from: range.from,
      to: range.to,
      bookingValue: value.map((v) => ({ ...v, count: Number(v.count), amount: Number(v.amount) })),
      commission: { due: Number(due?.amount ?? 0), collected: Number(collected?.amount ?? 0) },
      activeUsers: now.size,
      newUsers: Number(newUsers?.n ?? 0),
      retention: before.size ? Math.round((retained / before.size) * 1000) / 10 : null,
      topVenues: top.map((t) => ({ ...t, bookings: Number(t.bookings) })),
      cities: cities.map((c) => ({ city: c.city, bookings: Number(c.bookings) })),
      sports: bySport.map((s) => ({ sport: s.sport, bookings: Number(s.bookings) })),
    };
  }

  private checkRange(range: { from: Date; to: Date }) {
    if (!(range.to > range.from) || range.to.getTime() - range.from.getTime() > 400 * DAY)
      throw new AnalyticsError('INVALID_RANGE', 'Choose a range of up to about a year.');
  }
}
