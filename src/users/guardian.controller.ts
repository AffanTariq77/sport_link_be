import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { bookingStatus } from '../db/schema.js';
import { GuardianError, GuardianService } from './guardian.service.js';

const STATUS: Record<GuardianError['code'], number> = {
  NOT_MINOR: 400,
  NOT_FOUND: 404,
  GUARDIAN_NOT_VERIFIED: 409,
  WRONG_VERSION: 409,
};
const run = <T>(fn: () => Promise<T>) => withErrors(GuardianError, STATUS, fn);
const Id = z.uuid('Not found.');

const MyGuardian = z
  .object({ status: z.enum(['not_needed', 'none', 'pending', 'accepted']), guardianName: z.string().nullable() })
  .meta({ id: 'MyGuardian' });
const Ward = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    dob: z.string().nullable(),
    consentAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Ward' });
const Activity = z
  .object({
    minor: z.object({ id: z.uuid(), name: z.string().nullable() }),
    bookings: z.array(
      z.object({
        id: z.uuid(),
        startAt: z.iso.datetime(),
        status: z.enum(bookingStatus.enumValues),
        venue: z.string(),
        court: z.string(),
        timezone: z.string(),
      }),
    ),
    matches: z.array(z.object({ id: z.uuid(), startAt: z.iso.datetime(), sport: z.string(), role: z.string() })),
  })
  .meta({ id: 'WardActivity' });

@Controller('me')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class GuardianController {
  constructor(@Inject(GuardianService) private readonly guardians: GuardianService) {}

  @Get('guardian')
  @ApiOkResponse({ standardSchema: MyGuardian })
  mine(@Req() req: AuthedRequest) {
    return this.guardians.myGuardian(req.auth.user.id);
  }

  @Post('guardian')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.literal('pending') }) })
  request(
    @Req() req: AuthedRequest,
    @Body({ schema: z.object({ phone: z.string().max(32) }).meta({ id: 'GuardianRequest' }) }) body: { phone: string },
  ) {
    return run(() => this.guardians.requestGuardian(req.auth.user.id, body.phone));
  }

  @Get('guardian/consent-text')
  @ApiOkResponse({ standardSchema: z.object({ version: z.string(), text: z.string() }).meta({ id: 'ConsentText' }) })
  consentText() {
    return this.guardians.consentText();
  }

  @Get('wards')
  @ApiOkResponse({ standardSchema: z.array(Ward) })
  wards(@Req() req: AuthedRequest) {
    return this.guardians.wards(req.auth.user.id);
  }

  @Post('wards/:id/consent')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.enum(['accepted', 'declined']) }) })
  consent(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ accept: z.boolean(), version: z.string().max(40).optional() })
        .meta({ id: 'GuardianDecision' }),
    })
    body: { accept: boolean; version?: string },
  ) {
    return run(() => this.guardians.decide(req.auth.user.id, id, body));
  }

  @Get('wards/:id/activity')
  @ApiOkResponse({ standardSchema: Activity })
  activity(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.guardians.wardActivity(req.auth.user.id, id));
  }
}
