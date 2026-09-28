import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { paymentMethod, refundStatus } from '../db/schema.js';
import { RefundError, RefundsService } from './refunds.service.js';

const STATUS: Record<RefundError['code'], number> = {
  NOT_FOUND: 404,
  NOT_CANCELLABLE: 409,
  NOT_DUE: 409,
  NOT_SENT: 409,
};
const run = <T>(fn: () => Promise<T>) => withErrors(RefundError, STATUS, fn);
const Id = z.uuid('Not found.');

const Cancelled = z
  .object({ id: z.uuid(), status: z.literal('cancelled'), refunds: z.int() })
  .meta({ id: 'Cancelled' });
const VendorRefund = z
  .object({
    id: z.uuid(),
    amount: z.int(),
    currency: z.string(),
    reason: z.string(),
    status: z.enum(refundStatus.enumValues),
    playerName: z.string().nullable(),
    paidMethod: z.enum(paymentMethod.enumValues).nullable(),
    booking: z.object({
      id: z.uuid(),
      startAt: z.iso.datetime(),
      court: z.string(),
      branch: z.string(),
      timezone: z.string(),
    }),
  })
  .meta({ id: 'VendorRefund' });
const PlayerRefund = z
  .object({
    id: z.uuid(),
    bookingId: z.uuid(),
    amount: z.int(),
    currency: z.string(),
    reason: z.string(),
    status: z.enum(refundStatus.enumValues),
    vendorReference: z.string().nullable(),
    sentAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PlayerRefund' });
const RefundState = z.object({ id: z.uuid(), status: z.enum(refundStatus.enumValues) }).meta({ id: 'RefundState' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class RefundsController {
  constructor(@Inject(RefundsService) private readonly refunds: RefundsService) {}

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Cancelled })
  cancel(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.refunds.cancelByPlayer(req.auth.user.id, id));
  }

  @Post('vendor/bookings/:id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Cancelled })
  vendorCancel(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ reason: z.string().trim().min(3, 'Give a reason for the player.').max(300) })
        .meta({ id: 'VendorCancel' }),
    })
    body: { reason: string },
  ) {
    return run(() => this.refunds.cancelByVendor(req.auth.user.id, id, body.reason));
  }

  @Get('vendor/refunds')
  @ApiOkResponse({ standardSchema: z.array(VendorRefund) })
  due(@Req() req: AuthedRequest) {
    return this.refunds.dueForVendor(req.auth.user.id);
  }

  @Post('vendor/refunds/:id/sent')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: RefundState })
  sent(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ reference: z.string().trim().min(3, 'Enter the transfer reference.').max(60) })
        .meta({ id: 'RefundSent' }),
    })
    body: { reference: string },
  ) {
    return run(() => this.refunds.markSent(req.auth.user.id, id, body.reference));
  }

  @Get('refunds/mine')
  @ApiOkResponse({ standardSchema: z.array(PlayerRefund) })
  mine(@Req() req: AuthedRequest) {
    return this.refunds.forPlayer(req.auth.user.id);
  }

  @Post('refunds/:id/received')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: RefundState })
  received(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.refunds.confirm(req.auth.user.id, id, true, undefined));
  }

  @Post('refunds/:id/dispute')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: RefundState })
  dispute(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ details: z.string().max(1000).optional() }).meta({ id: 'RefundDispute' }) })
    body: { details?: string },
  ) {
    return run(() => this.refunds.confirm(req.auth.user.id, id, false, body.details));
  }
}
