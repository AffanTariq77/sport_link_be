import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { BookingError } from '../bookings/bookings.service.js';
import { bookingSource, bookingStatus } from '../db/schema.js';
import { STAFF_PERMISSIONS } from './access.js';
import { CalendarService } from './calendar.service.js';
import { StaffService } from './staff.service.js';
import { VendorError } from './vendors.service.js';

const VENDOR_STATUS: Record<VendorError['code'], number> = {
  NOT_VENDOR: 403,
  NOT_FOUND: 404,
  ALREADY_APPLIED: 409,
  VERIFY_FIRST: 409,
  INVALID_HOURS: 400,
  INVALID_PRICES: 400,
  UNKNOWN_SPORT: 400,
  HAS_FUTURE_BOOKINGS: 409,
  INCOMPLETE: 409,
  ALREADY_SUBMITTED: 409,
  INVALID_ACCOUNT: 400,
  TOO_MANY_PHOTOS: 409,
  INVALID_IMAGE: 400,
};
const BOOKING_STATUS: Record<BookingError['code'], number> = {
  SLOT_TAKEN: 409,
  INVALID_TIME: 400,
  IN_PAST: 400,
  OUTSIDE_OPENING_HOURS: 400,
  NO_PRICE: 400,
  COURT_UNAVAILABLE: 404,
  RECURRING_NOT_ALLOWED: 409,
  NOT_FOUND: 404,
};
const run = <T>(fn: () => Promise<T>) =>
  withErrors(VendorError, VENDOR_STATUS, () => withErrors(BookingError, BOOKING_STATUS, fn));

const Id = z.uuid('Not found.');
const When = z.iso.datetime({ offset: true });
const Slot = z.object({ startAt: z.iso.datetime(), endAt: z.iso.datetime() });
const CalendarDay = z
  .object({
    branch: z.object({ id: z.uuid(), name: z.string(), timezone: z.string() }),
    date: z.string(),
    courts: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        slots: z.array(Slot),
        bookings: z.array(
          Slot.extend({
            id: z.uuid(),
            source: z.enum(bookingSource.enumValues),
            status: z.enum(bookingStatus.enumValues),
            currency: z.string(),
            total: z.int(),
            advanceDue: z.int(),
            name: z.string().nullable(),
            customerPhone: z.string().nullable().meta({ description: 'Manual bookings only, private to the vendor' }),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'CalendarDay' });
const ManualBody = z
  .object({
    courtId: z.uuid(),
    startAt: When,
    endAt: When,
    customerName: z.string().trim().min(1, 'Enter the customer name.').max(80),
    customerPhone: z.string().max(20).optional(),
  })
  .meta({ id: 'ManualBooking' });
const BlockBody = z
  .object({
    courtId: z.uuid(),
    startAt: When,
    endAt: When,
    reason: z.string().trim().min(1, 'Give a reason.').max(120),
  })
  .meta({ id: 'CourtBlock' });
const Created = z.object({ id: z.uuid(), status: z.enum(bookingStatus.enumValues) }).meta({ id: 'CalendarEntry' });
const Staff = z
  .object({
    userId: z.uuid(),
    name: z.string().nullable(),
    permissions: z.array(z.string()),
    branchIds: z.array(z.uuid()),
    active: z.boolean(),
  })
  .meta({ id: 'StaffMember' });
const StaffBody = z
  .object({
    phone: z.string().max(32),
    permissions: z.array(z.enum(STAFF_PERMISSIONS)).min(1, 'Choose at least one permission.'),
    branchIds: z.array(z.uuid()).default([]).meta({ description: 'Empty means every branch' }),
  })
  .meta({ id: 'StaffInput' });

@Controller('vendor')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class CalendarController {
  constructor(
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(StaffService) private readonly staff: StaffService,
  ) {}

  @Get('calendar')
  @ApiOkResponse({ standardSchema: CalendarDay })
  day(
    @Req() req: AuthedRequest,
    @Query({ schema: z.object({ branchId: z.uuid(), date: z.iso.date() }) }) q: { branchId: string; date: string },
  ) {
    return run(() => this.calendar.day(req.auth.user.id, q.branchId, q.date));
  }

  @Post('bookings/manual')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Created })
  manual(@Req() req: AuthedRequest, @Body({ schema: ManualBody }) body: z.infer<typeof ManualBody>) {
    return run(() =>
      this.calendar.manual(req.auth.user.id, { ...body, startAt: new Date(body.startAt), endAt: new Date(body.endAt) }),
    );
  }

  @Post('blocks')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Created })
  block(@Req() req: AuthedRequest, @Body({ schema: BlockBody }) body: z.infer<typeof BlockBody>) {
    return run(() =>
      this.calendar.block(req.auth.user.id, { ...body, startAt: new Date(body.startAt), endAt: new Date(body.endAt) }),
    );
  }

  @Post('bookings/:id/no-show')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Created })
  noShow(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.calendar.noShow(req.auth.user.id, id));
  }

  @Get(':vendorId/staff')
  @ApiOkResponse({ standardSchema: z.array(Staff) })
  listStaff(@Req() req: AuthedRequest, @Param('vendorId', { schema: Id }) vendorId: string) {
    return run(() => this.staff.list(req.auth.user.id, vendorId));
  }

  @Post(':vendorId/staff')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ userId: z.uuid() }) })
  addStaff(
    @Req() req: AuthedRequest,
    @Param('vendorId', { schema: Id }) vendorId: string,
    @Body({ schema: StaffBody }) body: z.infer<typeof StaffBody>,
  ) {
    return run(() => this.staff.add(req.auth.user.id, vendorId, body));
  }

  @Delete(':vendorId/staff/:userId')
  @ApiOkResponse({ standardSchema: z.object({ userId: z.uuid() }) })
  removeStaff(
    @Req() req: AuthedRequest,
    @Param('vendorId', { schema: Id }) vendorId: string,
    @Param('userId', { schema: Id }) userId: string,
  ) {
    return run(() => this.staff.remove(req.auth.user.id, vendorId, userId));
  }
}
