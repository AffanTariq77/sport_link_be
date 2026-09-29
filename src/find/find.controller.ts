import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { findRequestStatus, findResponseStatus, gender } from '../db/schema.js';
import { FindError, FindService } from './find.service.js';

const STATUS: Record<FindError['code'], number> = {
  NOT_FOUND: 404,
  NO_LOCATION: 409,
  INVALID_REQUEST: 400,
  RATE_LIMITED: 429,
  NOT_ELIGIBLE: 403,
  CLOSED: 409,
  NOT_ACCEPTED: 400,
};
const run = <T>(fn: () => Promise<T>) => withErrors(FindError, STATUS, fn);

const Id = z.uuid('Not found.');
const Ok = z.object({ ok: z.boolean() });
const AlertMode = z.enum(['always', 'available', 'off']);
const Availability = z
  .object({
    alertMode: AlertMode,
    available: z.boolean(),
    quietHoursOk: z.boolean(),
    sports: z.array(z.string()),
    hasLocation: z.boolean(),
  })
  .meta({ id: 'Availability' });
const AvailabilityBody = z
  .object({
    alertMode: AlertMode.optional(),
    available: z.boolean().optional(),
    quietHoursOk: z.boolean().optional(),
    sports: z.array(z.string().max(40)).max(20).optional(),
  })
  .meta({ id: 'SetAvailability' });
const LocationBody = z
  .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
  .meta({ id: 'SetLocation', description: 'Rounded to about 500 m before it is stored' });
const CreateBody = z
  .object({
    sport: z.string().max(40),
    playersNeeded: z.int().min(1).max(20),
    radiusKm: z.int().min(1).max(100),
    window: z.enum(['now', 'today', 'custom']),
    startAt: z.iso.datetime({ offset: true }).optional(),
    endAt: z.iso.datetime({ offset: true }).optional(),
    filters: z
      .object({
        minAge: z.int().min(5).max(100).optional(),
        maxAge: z.int().min(5).max(100).optional(),
        gender: z.enum(gender.enumValues).nullable().optional(),
        verifiedOnly: z.boolean().optional(),
        minRating: z.int().min(0).max(4000).optional(),
        maxRating: z.int().min(0).max(4000).optional(),
      })
      .default({}),
  })
  .meta({ id: 'CreateFindRequest' });
const Request = z
  .object({
    id: z.uuid(),
    sport: z.string(),
    playersNeeded: z.int(),
    radiusKm: z.int(),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    status: z.enum(findRequestStatus.enumValues),
    matchId: z.uuid().nullable(),
    requester: z.object({ id: z.uuid(), name: z.string() }),
    mine: z.boolean(),
    myStatus: z.enum(findResponseStatus.enumValues).nullable(),
    distance: z.string().nullable().meta({ description: 'Distance band only, never coordinates' }),
    notified: z.int(),
    players: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        status: z.enum(findResponseStatus.enumValues),
        distance: z.string(),
        rating: z.int().nullable(),
        provisional: z.boolean(),
        behaviour: z.number().nullable(),
      }),
    ),
  })
  .meta({ id: 'FindRequest' });
const Mine = z
  .object({
    sent: z.array(
      z.object({
        id: z.uuid(),
        sport: z.string(),
        status: z.enum(findRequestStatus.enumValues),
        windowEnd: z.iso.datetime(),
      }),
    ),
    incoming: z.array(
      z.object({
        id: z.uuid(),
        sport: z.string(),
        status: z.enum(findRequestStatus.enumValues),
        windowStart: z.iso.datetime(),
        windowEnd: z.iso.datetime(),
        myStatus: z.enum(findResponseStatus.enumValues),
        requester: z.string(),
        distance: z.string(),
      }),
    ),
  })
  .meta({ id: 'MyFindRequests' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class FindController {
  constructor(@Inject(FindService) private readonly find: FindService) {}

  @Put('me/location')
  @ApiOkResponse({ standardSchema: Ok })
  location(@Req() req: AuthedRequest, @Body({ schema: LocationBody }) body: z.infer<typeof LocationBody>) {
    return this.find.setLocation(req.auth.user.id, body.latitude, body.longitude);
  }

  @Get('me/availability')
  @ApiOkResponse({ standardSchema: Availability })
  availability(@Req() req: AuthedRequest) {
    return this.find.availability(req.auth.user.id);
  }

  @Put('me/availability')
  @ApiOkResponse({ standardSchema: Availability })
  setAvailability(
    @Req() req: AuthedRequest,
    @Body({ schema: AvailabilityBody }) body: z.infer<typeof AvailabilityBody>,
  ) {
    return this.find.setAvailability(req.auth.user.id, body);
  }

  @Post('me/wards/:id/find-players')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  guardianSwitch(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ allowAdults: z.boolean() }).meta({ id: 'WardFindPlayers' }) })
    body: {
      allowAdults: boolean;
    },
  ) {
    return run(() => this.find.setGuardianAllowsAdults(req.auth.user.id, id, body.allowAdults));
  }

  @UseGuards(UnlockedGuard)
  @Post('find-players')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid(), notified: z.int() }) })
  create(@Req() req: AuthedRequest, @Body({ schema: CreateBody }) body: z.infer<typeof CreateBody>) {
    return run(() =>
      this.find.create(req.auth.user.id, {
        ...body,
        startAt: body.startAt ? new Date(body.startAt) : undefined,
        endAt: body.endAt ? new Date(body.endAt) : undefined,
      }),
    );
  }

  @Get('find-players')
  @ApiOkResponse({ standardSchema: Mine })
  mine(@Req() req: AuthedRequest) {
    return this.find.mine(req.auth.user.id);
  }

  @Get('find-players/:id')
  @ApiOkResponse({ standardSchema: Request })
  get(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.find.get(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post('find-players/:id/respond')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  respond(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ accept: z.boolean() }).meta({ id: 'FindAnswer' }) }) body: { accept: boolean },
  ) {
    return run(() => this.find.respond(req.auth.user.id, id, body.accept));
  }

  @Post('find-players/:id/select')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  select(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ userIds: z.array(z.uuid()).min(1).max(20) }).meta({ id: 'FindSelect' }) })
    body: {
      userIds: string[];
    },
  ) {
    return run(() => this.find.select(req.auth.user.id, id, body.userIds));
  }

  @Post('find-players/:id/players/:userId/remove')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  remove(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('userId', { schema: Id }) userId: string,
  ) {
    return run(() => this.find.remove(req.auth.user.id, id, userId));
  }

  @Post('find-players/:id/close')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  close(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.find.close(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post('find-players/:id/convert')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ ok: z.boolean(), added: z.int() }) })
  convert(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ matchId: z.uuid() }).meta({ id: 'FindConvert' }) }) body: { matchId: string },
  ) {
    return run(() => this.find.convert(req.auth.user.id, id, body.matchId));
  }
}
