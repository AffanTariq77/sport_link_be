import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { AnalyticsError, AnalyticsService } from './analytics.service.js';

const STATUS: Record<AnalyticsError['code'], number> = {
  NOT_FOUND: 404,
  REVIEW_CLOSED: 409,
  ALREADY_REVIEWED: 409,
  INVALID_RANGE: 400,
};
const run = <T>(fn: () => Promise<T>) => withErrors(AnalyticsError, STATUS, fn);
const Id = z.uuid('Not found.');
const Ok = z.object({ ok: z.boolean() });
const Range = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
/** Default: the last 30 days. Dates are whole days, UTC. */
const range = (q: { from?: string; to?: string }) => {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date();
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
};

const VenueReviews = z
  .object({
    average: z.number().nullable(),
    count: z.int(),
    reviews: z.array(
      z.object({
        id: z.uuid(),
        stars: z.int(),
        comment: z.string().nullable(),
        reply: z.string().nullable(),
        createdAt: z.iso.datetime(),
        author: z.string(),
      }),
    ),
  })
  .meta({ id: 'VenueReviews' });
const VendorAnalytics = z
  .object({
    currency: z.string(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    bookings: z.object({ total: z.int(), app: z.int(), manual: z.int(), completed: z.int(), noShows: z.int() }),
    revenue: z.object({
      total: z.int(),
      app: z.int(),
      manual: z.int(),
      byCourt: z.array(
        z.object({ courtId: z.uuid(), court: z.string(), branch: z.string(), bookings: z.int(), revenue: z.int() }),
      ),
    }),
    occupancy: z.object({
      percent: z.number(),
      heatmap: z.array(z.array(z.number())).meta({ description: '[weekday, 0 = Sunday][local hour] = booked hours' }),
    }),
    cancellations: z.object({ total: z.int(), byPlayer: z.int(), byVenue: z.int() }),
    ratingTrend: z.array(z.object({ month: z.string(), average: z.number(), count: z.int() })),
    reviews: z.array(
      z.object({
        id: z.uuid(),
        branch: z.string(),
        stars: z.int(),
        comment: z.string().nullable(),
        reply: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'VendorAnalytics' });
const Calculator = z
  .object({
    occupancy: z.number(),
    projected: z.int(),
    fullMonth: z.int(),
    courts: z.array(
      z.object({ courtId: z.uuid(), court: z.string(), branch: z.string(), fullMonth: z.int(), projected: z.int() }),
    ),
  })
  .meta({ id: 'RevenueCalculator' });
const Platform = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    bookingValue: z.array(z.object({ currency: z.string(), source: z.string(), count: z.int(), amount: z.int() })),
    commission: z.object({ due: z.int(), collected: z.int() }),
    activeUsers: z.int(),
    newUsers: z.int(),
    retention: z
      .number()
      .nullable()
      .meta({ description: 'Percent of the previous period’s active users still active' }),
    topVenues: z.array(z.object({ branchId: z.uuid(), name: z.string(), city: z.string(), bookings: z.int() })),
    cities: z.array(z.object({ city: z.string(), bookings: z.int() })),
    sports: z.array(z.object({ sport: z.string(), bookings: z.int() })),
  })
  .meta({ id: 'PlatformAnalytics' });

@Controller()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get('venues/:id/reviews')
  @ApiOkResponse({ standardSchema: VenueReviews })
  venueReviews(@Param('id', { schema: Id }) id: string) {
    return this.analytics.venueReviews(id);
  }

  @UseGuards(AuthGuard, UnlockedGuard)
  @ApiBearerAuth()
  @Post('bookings/:id/review')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  review(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ stars: z.int().min(1, 'Give 1 to 5 stars.').max(5), comment: z.string().trim().max(500).optional() })
        .meta({ id: 'VenueReview' }),
    })
    body: { stars: number; comment?: string },
  ) {
    return run(() => this.analytics.reviewVenue(req.auth.user.id, id, body));
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Post('vendor/reviews/:id/reply')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  reply(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ reply: z.string().trim().min(1).max(500) }).meta({ id: 'ReviewReply' }) })
    body: {
      reply: string;
    },
  ) {
    return run(() => this.analytics.reply(req.auth.user.id, id, body.reply));
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('vendor/analytics')
  @ApiOkResponse({ standardSchema: VendorAnalytics })
  vendor(@Req() req: AuthedRequest, @Query({ schema: Range }) q: z.infer<typeof Range>) {
    return run(() => this.analytics.vendor(req.auth.user.id, range(q)));
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Get('vendor/analytics/calculator')
  @ApiOkResponse({ standardSchema: Calculator })
  calculator(
    @Req() req: AuthedRequest,
    @Query({ schema: z.object({ occupancy: z.coerce.number().min(0).max(100).optional() }) }) q: { occupancy?: number },
  ) {
    return run(() => this.analytics.calculator(req.auth.user.id, q.occupancy));
  }

  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @Permission('analytics.view')
  @Get('admin/analytics')
  @ApiOkResponse({ standardSchema: Platform })
  platform(@Query({ schema: Range }) q: z.infer<typeof Range>) {
    return run(() => this.analytics.platform(range(q)));
  }
}
