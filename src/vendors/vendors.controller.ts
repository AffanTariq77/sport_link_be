import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { advanceType, dayType, listingStatus, paymentMethod, reviewStatus, vendorStatus } from '../db/schema.js';
import { VendorError, VendorsService } from './vendors.service.js';

const STATUS: Record<VendorError['code'], number> = {
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
};
const run = <T>(fn: () => Promise<T>) => withErrors(VendorError, STATUS, fn);

const Id = z.uuid('Not found.');
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 07:00.');
const Text = (label: string, max = 120) => z.string().trim().min(1, `Enter the ${label}.`).max(max);

const ApplyBody = z.object({ businessName: Text('business name') }).meta({ id: 'VendorApplication' });
const BranchBody = z
  .object({
    name: Text('venue name'),
    address: Text('address', 200),
    city: Text('city', 80),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    facilities: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    rules: z.string().max(2000).nullable().default(null),
  })
  .meta({ id: 'BranchInput' });
const PolicyShape = z.object({
  advanceType: z.enum(advanceType.enumValues),
  advanceValue: z
    .int()
    .min(0)
    .max(100_000_000)
    .meta({ description: 'Basis points if percentage, minor units if fixed' }),
  cancelRefund: z.boolean(),
  cancelWindowHours: z
    .int()
    .min(0)
    .max(24 * 14),
  noShowRefund: z.boolean(),
  recurringAllowed: z.boolean(),
  allowUnpaidCash: z.boolean(),
});
const PolicyBody = PolicyShape.refine((p) => p.advanceType !== 'percentage' || p.advanceValue <= 10_000, {
  message: 'The advance cannot be more than 100%.',
  path: ['advanceValue'],
}).meta({ id: 'PolicyInput' });
const CourtBody = z
  .object({
    name: Text('court name', 60),
    surface: z.string().max(60).nullable().default(null),
    slotMinutes: z
      .int()
      .min(15)
      .max(240)
      .refine((m) => m % 15 === 0, 'Slots must be in 15-minute steps.'),
    sports: z.array(z.string().max(40)).min(1, 'Choose at least one sport.').max(10),
  })
  .meta({ id: 'CourtInput' });
const CourtUpdateBody = CourtBody.extend({ active: z.boolean() }).meta({ id: 'CourtUpdate' });
const HoursBody = z
  .object({
    hours: z
      .array(z.object({ weekday: z.int().min(0).max(6), opensAt: Time, closesAt: Time }))
      .max(28)
      .meta({ description: 'weekday 0 = Sunday. A closing time earlier than opening means after midnight.' }),
  })
  .meta({ id: 'HoursInput' });
const PricesBody = z
  .object({
    prices: z
      .array(
        z.object({
          dayType: z.enum(dayType.enumValues),
          startTime: Time,
          endTime: Time.meta({ description: '00:00 means midnight at the end of the day' }),
          pricePerHour: z.int().min(1).max(100_000_000).meta({ description: 'Minor units' }),
        }),
      )
      .max(40),
  })
  .meta({ id: 'PricesInput' });
const AccountBody = z
  .object({
    method: z.enum(paymentMethod.enumValues),
    accountTitle: Text('account title, as on your CNIC'),
    accountNumber: z.string().max(40).optional(),
    bankName: z.string().max(80).optional(),
    replacesAccountId: z.uuid().optional(),
  })
  .meta({ id: 'PaymentAccountInput' });

const Hours = z.object({ weekday: z.int(), opensAt: z.string(), closesAt: z.string() });
const Price = z.object({
  dayType: z.enum(dayType.enumValues),
  startTime: z.string(),
  endTime: z.string(),
  pricePerHour: z.int(),
});
const Setup = z
  .object({
    vendor: z
      .object({
        id: z.uuid(),
        businessName: z.string(),
        status: z.enum(vendorStatus.enumValues),
        countryCode: z.string(),
        currency: z.string(),
      })
      .nullable(),
    branches: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        address: z.string(),
        city: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        facilities: z.array(z.string()),
        rules: z.string().nullable(),
        timezone: z.string(),
        status: z.enum(listingStatus.enumValues),
        policy: PolicyShape,
        courts: z.array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            surface: z.string().nullable(),
            slotMinutes: z.int(),
            active: z.boolean(),
            sports: z.array(z.string()),
            hours: z.array(Hours),
            prices: z.array(Price),
          }),
        ),
        checklist: z.array(z.object({ key: z.string(), done: z.boolean(), label: z.string() })),
      }),
    ),
    paymentAccounts: z.array(
      z.object({
        id: z.uuid(),
        method: z.enum(paymentMethod.enumValues),
        accountTitle: z.string(),
        bankName: z.string().nullable(),
        accountNumberEnding: z.string().nullable(),
        status: z.enum(reviewStatus.enumValues),
        replacesAccountId: z.uuid().nullable(),
      }),
    ),
  })
  .meta({ id: 'VendorSetup' });
const Created = z.object({ id: z.uuid() }).meta({ id: 'Created' });
const Vendor = z
  .object({ id: z.uuid(), businessName: z.string(), status: z.enum(vendorStatus.enumValues) })
  .meta({ id: 'Vendor' });
const Account = z
  .object({ id: z.uuid(), status: z.enum(reviewStatus.enumValues) })
  .meta({ id: 'PaymentAccountCreated' });
const Submitted = z.object({ id: z.uuid(), status: z.enum(listingStatus.enumValues) }).meta({ id: 'BranchSubmitted' });

// Owner-only for now. Staff permissions such as edit_prices (spec 13.2) come with staff management.
@Controller('vendor')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class VendorsController {
  constructor(@Inject(VendorsService) private readonly vendors: VendorsService) {}

  @Get('setup')
  @ApiOkResponse({ standardSchema: Setup })
  setup(@Req() req: AuthedRequest) {
    return this.vendors.setup(req.auth.user.id);
  }

  @Post('apply')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Vendor })
  apply(@Req() req: AuthedRequest, @Body({ schema: ApplyBody }) body: z.infer<typeof ApplyBody>) {
    return run(() => this.vendors.apply(req.auth.user.id, body.businessName));
  }

  @Post('branches')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Created })
  createBranch(@Req() req: AuthedRequest, @Body({ schema: BranchBody }) body: z.infer<typeof BranchBody>) {
    return run(() => this.vendors.createBranch(req.auth.user.id, body));
  }

  @Patch('branches/:id')
  @ApiOkResponse({ standardSchema: Created })
  updateBranch(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: BranchBody }) body: z.infer<typeof BranchBody>,
  ) {
    return run(() => this.vendors.updateBranch(req.auth.user.id, id, body));
  }

  @Put('branches/:id/policy')
  @ApiOkResponse({ standardSchema: Created })
  setPolicy(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: PolicyBody }) body: z.infer<typeof PolicyBody>,
  ) {
    return run(() => this.vendors.setPolicy(req.auth.user.id, id, body));
  }

  @Post('branches/:id/courts')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Created })
  createCourt(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: CourtBody }) body: z.infer<typeof CourtBody>,
  ) {
    return run(() => this.vendors.createCourt(req.auth.user.id, id, body));
  }

  @Post('branches/:id/submit')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Submitted })
  submit(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.vendors.submit(req.auth.user.id, id));
  }

  @Patch('courts/:id')
  @ApiOkResponse({ standardSchema: Created })
  updateCourt(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: CourtUpdateBody }) body: z.infer<typeof CourtUpdateBody>,
  ) {
    return run(() => this.vendors.updateCourt(req.auth.user.id, id, body));
  }

  @Put('courts/:id/hours')
  @ApiOkResponse({ standardSchema: Created })
  setHours(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: HoursBody }) body: z.infer<typeof HoursBody>,
  ) {
    return run(() => this.vendors.setHours(req.auth.user.id, id, body.hours));
  }

  @Put('courts/:id/prices')
  @ApiOkResponse({ standardSchema: Created })
  setPrices(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: PricesBody }) body: z.infer<typeof PricesBody>,
  ) {
    return run(() => this.vendors.setPrices(req.auth.user.id, id, body.prices));
  }

  @Post('payment-accounts')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Account })
  addAccount(@Req() req: AuthedRequest, @Body({ schema: AccountBody }) body: z.infer<typeof AccountBody>) {
    return run(() => this.vendors.addAccount(req.auth.user.id, body));
  }
}
