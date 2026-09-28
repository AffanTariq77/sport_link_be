import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { gender, matchPlayerStatus, matchStatus, paymentMethod, shareStatus } from '../db/schema.js';
import { MatchError, MatchesService } from './matches.service.js';

const STATUS: Record<MatchError['code'], number> = {
  NOT_FOUND: 404,
  NOT_HOST: 403,
  BOOKING_NOT_READY: 409,
  ALREADY_A_MATCH: 409,
  INVALID_MATCH: 400,
  UNLISTED_WARNING_REQUIRED: 400,
  NOT_ELIGIBLE: 403,
  CLOSED: 409,
  OVERLAPPING: 409,
  ALREADY_REQUESTED: 409,
  FULL: 409,
  NOT_APPROVED: 409,
  INVALID_REFERENCE: 400,
  METHOD_NOT_ACCEPTED: 400,
  DUPLICATE_TRANSACTION: 409,
};
const run = <T>(fn: () => Promise<T>) => withErrors(MatchError, STATUS, fn);

const Id = z.uuid('Not found.');
const Filters = z
  .object({
    minAge: z.int().min(5).max(100).optional(),
    maxAge: z.int().min(5).max(100).optional(),
    gender: z.enum(gender.enumValues).nullable().optional().meta({ description: 'female for women-only' }),
    verifiedOnly: z.boolean().optional(),
  })
  .meta({ id: 'MatchFilters' });
const CreateBody = z
  .object({
    sport: z.string().max(40),
    bookingId: z.uuid().optional(),
    unlisted: z
      .object({
        name: z.string().trim().min(1, 'Enter the venue name.').max(120),
        address: z.string().trim().min(1, 'Enter the address.').max(200),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        startAt: z.iso.datetime({ offset: true }),
        endAt: z.iso.datetime({ offset: true }),
      })
      .optional(),
    acceptedUnlistedWarning: z.boolean().optional(),
    slotsTotal: z.int().min(2).max(40),
    hostBrings: z.int().min(1).max(39),
    filters: Filters.default({}),
  })
  .meta({ id: 'CreateMatch' });
const Summary = z
  .object({
    id: z.uuid(),
    status: z.enum(matchStatus.enumValues),
    sport: z.string(),
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    joinCutoffAt: z.iso.datetime(),
    timezone: z.string(),
    slotsTotal: z.int(),
    slotsFilled: z.int(),
    filters: Filters,
    host: z.object({ id: z.uuid(), name: z.string().nullable() }),
    listed: z.boolean(),
    bookingId: z.uuid().nullable(),
    venue: z.object({ name: z.string(), detail: z.string() }),
    pricePerPlayer: z.int().nullable(),
    currency: z.string().nullable(),
  })
  .meta({ id: 'MatchSummary' });
const Detail = Summary.extend({
  isHost: z.boolean(),
  canJoin: z.boolean(),
  me: z
    .object({
      status: z.enum(matchPlayerStatus.enumValues),
      shareStatus: z.enum(shareStatus.enumValues).nullable(),
      shareAmount: z.int().nullable(),
    })
    .nullable(),
  players: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string().nullable(),
      status: z.enum(matchPlayerStatus.enumValues),
      shareStatus: z.enum(shareStatus.enumValues).nullable(),
    }),
  ),
}).meta({ id: 'MatchDetail' });
const PlayerStatus = z.object({ status: z.enum(matchPlayerStatus.enumValues) }).meta({ id: 'MatchPlayerStatus' });
const MatchPay = z
  .object({
    amount: z.int().nullable(),
    currency: z.string(),
    shareStatus: z.enum(shareStatus.enumValues).nullable(),
    accounts: z.array(
      z.object({
        method: z.enum(paymentMethod.enumValues),
        accountTitle: z.string(),
        bankName: z.string().nullable(),
        accountNumber: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'MatchPayInfo' });

@Controller('matches')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class MatchesController {
  constructor(@Inject(MatchesService) private readonly matches: MatchesService) {}

  @UseGuards(UnlockedGuard)
  @Post()
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  create(@Req() req: AuthedRequest, @Body({ schema: CreateBody }) body: z.infer<typeof CreateBody>) {
    return run(() =>
      this.matches.create(req.auth.user.id, {
        ...body,
        unlisted: body.unlisted && {
          ...body.unlisted,
          startAt: new Date(body.unlisted.startAt),
          endAt: new Date(body.unlisted.endAt),
        },
      }),
    );
  }

  @Get()
  @ApiOkResponse({ standardSchema: z.array(Summary) })
  list(
    @Req() req: AuthedRequest,
    @Query({ schema: z.object({ sport: z.string().max(40).optional() }) }) q: { sport?: string },
  ) {
    return this.matches.list(req.auth.user.id, q);
  }

  @Get('mine')
  @ApiOkResponse({ standardSchema: z.array(Summary) })
  mine(@Req() req: AuthedRequest) {
    return this.matches.mine(req.auth.user.id);
  }

  @Get(':id')
  @ApiOkResponse({ standardSchema: Detail })
  get(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.matches.get(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post(':id/join')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: PlayerStatus })
  join(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ acceptedUnlistedWarning: z.boolean().optional() }).meta({ id: 'JoinMatch' }) })
    body: { acceptedUnlistedWarning?: boolean },
  ) {
    return run(() => this.matches.join(req.auth.user.id, id, body));
  }

  @Post(':id/requests/:userId/:decision')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: PlayerStatus })
  decide(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('userId', { schema: Id }) userId: string,
    @Param('decision', { schema: z.enum(['approve', 'decline']) }) decision: 'approve' | 'decline',
  ) {
    return run(() => this.matches.decide(req.auth.user.id, id, userId, decision === 'approve'));
  }

  @Post(':id/players/:userId/remove')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: PlayerStatus })
  remove(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('userId', { schema: Id }) userId: string,
  ) {
    return run(() => this.matches.remove(req.auth.user.id, id, userId));
  }

  @Post(':id/leave')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: PlayerStatus })
  leave(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.matches.leave(req.auth.user.id, id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.enum(matchStatus.enumValues) }) })
  cancel(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.matches.cancel(req.auth.user.id, id));
  }

  @Get(':id/pay')
  @ApiOkResponse({ standardSchema: MatchPay })
  payInfo(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.matches.payInfo(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post(':id/pay')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ shareStatus: z.enum(shareStatus.enumValues) }) })
  pay(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ method: z.enum(paymentMethod.enumValues), txnReference: z.string().max(60) })
        .meta({ id: 'PayShare' }),
    })
    body: { method: 'jazzcash' | 'easypaisa' | 'bank_transfer' | 'cash'; txnReference: string },
  ) {
    return run(() => this.matches.payShare(req.auth.user.id, id, body));
  }
}
