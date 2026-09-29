import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { advanceType, bookingStatus } from '../db/schema.js';
import { BookingError, BookingsService, effectiveStatus } from './bookings.service.js';

const STATUS: Record<BookingError['code'], number> = {
  SLOT_TAKEN: 409,
  INVALID_TIME: 400,
  IN_PAST: 400,
  OUTSIDE_OPENING_HOURS: 400,
  NO_PRICE: 400,
  COURT_UNAVAILABLE: 404,
  RECURRING_NOT_ALLOWED: 409,
  NOT_FOUND: 404,
};

const HoldBody = z
  .object({ courtId: z.uuid(), startAt: z.iso.datetime({ offset: true }), endAt: z.iso.datetime({ offset: true }) })
  .meta({ id: 'HoldRequest' });

const PolicySnapshot = z.object({
  advanceType: z.enum(advanceType.enumValues),
  advanceValue: z.int(),
  cancelRefund: z.boolean(),
  cancelWindowHours: z.int(),
  noShowRefund: z.boolean(),
});
const BookingBase = z.object({
  id: z.uuid(),
  status: z.enum(bookingStatus.enumValues),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  currency: z.string(),
  total: z.int().meta({ description: 'Minor units' }),
  advanceDue: z.int().meta({ description: 'Minor units' }),
  holdExpiresAt: z.iso.datetime().nullable(),
  policy: PolicySnapshot,
});
const Hold = BookingBase.meta({ id: 'Hold' });
const MyBooking = BookingBase.extend({
  paymentDeadlineAt: z.iso.datetime().nullable(),
  court: z.object({ id: z.uuid(), name: z.string() }),
  venue: z.object({ id: z.uuid(), name: z.string(), city: z.string(), timezone: z.string() }),
  seriesId: z.uuid().nullable().meta({ description: 'Weekly booking series' }),
  extendsBookingId: z.uuid().nullable(),
}).meta({ id: 'MyBooking' });
const SeriesBody = HoldBody.extend({
  weeks: z.int().min(2).max(52),
  skip: z
    .array(z.iso.datetime({ offset: true }))
    .max(52)
    .optional()
    .meta({ description: 'Start times of weeks to leave out' }),
}).meta({ id: 'RecurringRequest' });
const SeriesWeeks = z
  .array(z.object({ startAt: z.iso.datetime(), endAt: z.iso.datetime(), free: z.boolean() }))
  .meta({ id: 'RecurringWeeks' });

@Controller('bookings')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class BookingsController {
  constructor(@Inject(BookingsService) private readonly bookings: BookingsService) {}

  /** Holds a slot for the player (setting booking.hold_minutes) while they pay the advance. */
  @UseGuards(UnlockedGuard)
  @Post()
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Hold })
  hold(@Req() req: AuthedRequest, @Body({ schema: HoldBody }) body: z.infer<typeof HoldBody>) {
    return withErrors(BookingError, STATUS, async () => {
      const b = await this.bookings.createHold({
        courtId: body.courtId,
        startAt: new Date(body.startAt),
        endAt: new Date(body.endAt),
        userId: req.auth.user.id,
      });
      return {
        id: b.id,
        status: effectiveStatus(b, new Date()),
        startAt: b.startAt,
        endAt: b.endAt,
        currency: b.currency,
        total: b.total,
        advanceDue: b.advanceDue,
        holdExpiresAt: b.holdExpiresAt,
        policy: b.policySnapshot,
      };
    });
  }

  /** Weekly booking: every week checked together, so taken weeks can be skipped (spec 6.2). */
  @Post('recurring/check')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: SeriesWeeks })
  checkSeries(@Body({ schema: SeriesBody }) body: z.infer<typeof SeriesBody>) {
    return withErrors(BookingError, STATUS, () =>
      this.bookings.checkSeries({
        courtId: body.courtId,
        startAt: new Date(body.startAt),
        endAt: new Date(body.endAt),
        weeks: body.weeks,
      }),
    );
  }

  @UseGuards(UnlockedGuard)
  @Post('recurring')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ seriesId: z.uuid(), weeks: z.int(), advanceTotal: z.int() }) })
  createSeries(@Req() req: AuthedRequest, @Body({ schema: SeriesBody }) body: z.infer<typeof SeriesBody>) {
    return withErrors(BookingError, STATUS, async () => {
      const r = await this.bookings.createSeries({
        courtId: body.courtId,
        startAt: new Date(body.startAt),
        endAt: new Date(body.endAt),
        weeks: body.weeks,
        skip: body.skip?.map((x) => new Date(x).toISOString()),
        userId: req.auth.user.id,
      });
      return {
        seriesId: r.seriesId,
        weeks: r.bookings.length,
        advanceTotal: r.bookings.reduce((s, b) => s + b.advanceDue, 0),
      };
    });
  }

  @UseGuards(UnlockedGuard)
  @Post(':id/extend')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Hold })
  extend(
    @Req() req: AuthedRequest,
    @Param('id', { schema: z.uuid('Not found.') }) id: string,
    @Body({ schema: z.object({ minutes: z.int().min(15).max(240).optional() }).meta({ id: 'ExtendBooking' }) })
    body: { minutes?: number },
  ) {
    return withErrors(BookingError, STATUS, async () => {
      const b = await this.bookings.extend(req.auth.user.id, id, body.minutes);
      return {
        id: b.id,
        status: effectiveStatus(b, new Date()),
        startAt: b.startAt,
        endAt: b.endAt,
        currency: b.currency,
        total: b.total,
        advanceDue: b.advanceDue,
        holdExpiresAt: b.holdExpiresAt,
        policy: b.policySnapshot,
      };
    });
  }

  @Get('mine')
  @ApiOkResponse({ standardSchema: z.array(MyBooking) })
  mine(@Req() req: AuthedRequest) {
    return this.bookings.listForUser(req.auth.user.id);
  }
}
