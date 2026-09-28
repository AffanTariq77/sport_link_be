import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { bookingStatus, paymentMethod, shareStatus } from '../db/schema.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { vendorAccess } from '../vendors/access.js';
import { PaymentError, PaymentsService } from './payments.service.js';

const STATUS: Record<PaymentError['code'], number> = {
  NOT_FOUND: 404,
  NOT_PAYABLE: 409,
  METHOD_NOT_ACCEPTED: 400,
  CASH_NOT_ALLOWED: 400,
  INVALID_REFERENCE: 400,
  DUPLICATE_TRANSACTION: 409,
  ALREADY_SUBMITTED: 409,
  NOT_SUBMITTED: 409,
  BOOKING_EXPIRED: 409,
};
const run = <T>(fn: () => Promise<T>) => withErrors(PaymentError, STATUS, fn);

const Method = z.enum(paymentMethod.enumValues);
const Status = z.enum(bookingStatus.enumValues);
const Id = z.uuid('Not found.');

const PayInfo = z
  .object({
    status: Status,
    currency: z.string(),
    timezone: z.string(),
    total: z.int(),
    advanceDue: z.int(),
    holdExpiresAt: z.iso.datetime().nullable(),
    paymentDeadlineAt: z.iso.datetime().nullable(),
    payAtVenueAllowed: z.boolean(),
    accounts: z.array(
      z.object({
        method: Method,
        accountTitle: z.string(),
        accountNumber: z.string().nullable(),
        bankName: z.string().nullable(),
      }),
    ),
    payments: z.array(
      z.object({
        status: z.enum(shareStatus.enumValues),
        method: Method.nullable(),
        txnReference: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'PayInfo' });
const PaymentResult = z
  .object({ status: Status, paymentDeadlineAt: z.iso.datetime().nullable() })
  .meta({ id: 'PaymentResult' });
const PaymentBody = z
  .object({ method: Method, txnReference: z.string().max(60).optional() })
  .meta({ id: 'PaymentSubmission' });

const VendorAccess = z
  .object({
    vendors: z.array(
      z.object({
        id: z.uuid(),
        businessName: z.string(),
        branches: z.array(z.object({ id: z.uuid(), name: z.string(), timezone: z.string() })),
      }),
    ),
  })
  .meta({ id: 'VendorAccess' });
const QueueItem = z
  .object({
    id: z.uuid(),
    method: Method.nullable(),
    txnReference: z.string().nullable(),
    advanceAmount: z.int(),
    submittedAt: z.iso.datetime(),
    playerName: z.string().nullable(),
    court: z.string(),
    branch: z.object({ name: z.string(), timezone: z.string() }),
    booking: z.object({
      id: z.uuid(),
      status: Status,
      startAt: z.iso.datetime(),
      endAt: z.iso.datetime(),
      currency: z.string(),
      total: z.int(),
      holdExpiresAt: z.iso.datetime().nullable(),
      paymentDeadlineAt: z.iso.datetime().nullable(),
    }),
  })
  .meta({ id: 'PaymentToCheck' });
const RejectBody = z
  .object({ reason: z.string().trim().min(3, 'Say why the payment was not accepted.').max(300) })
  .meta({ id: 'RejectPayment' });
const Handled = z.object({ id: z.uuid() }).meta({ id: 'PaymentHandled' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('bookings/:id/payment')
  @ApiOkResponse({ standardSchema: PayInfo })
  payInfo(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.payments.payInfo(id, req.auth.user.id));
  }

  @Post('bookings/:id/payment')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: PaymentResult })
  submit(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: PaymentBody }) body: z.infer<typeof PaymentBody>,
  ) {
    return run(() => this.payments.submit(id, req.auth.user.id, body));
  }

  /** Vendors and branches the user can act for. Empty for players; the apps show Vendor mode when not. */
  @Get('vendor/access')
  @ApiOkResponse({ standardSchema: VendorAccess })
  async access(@Req() req: AuthedRequest) {
    const [bookingsAccess, paymentsAccess] = await Promise.all([
      vendorAccess(this.db, req.auth.user.id, 'view_bookings'),
      this.payments.vendorAccess(req.auth.user.id),
    ]);
    const merged = new Map([...paymentsAccess.vendors, ...bookingsAccess.vendors].map((v) => [v.id, v]));
    return { vendors: [...merged.values()] };
  }

  @Get('vendor/payments')
  @ApiOkResponse({ standardSchema: z.array(QueueItem) })
  queue(@Req() req: AuthedRequest) {
    return this.payments.queue(req.auth.user.id);
  }

  @Post('vendor/payments/:id/confirm')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Handled })
  confirm(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.payments.confirm(id, req.auth.user.id));
  }

  @Post('vendor/payments/:id/reject')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Handled })
  reject(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: RejectBody }) body: z.infer<typeof RejectBody>,
  ) {
    return run(() => this.payments.reject(id, req.auth.user.id, body.reason));
  }
}
