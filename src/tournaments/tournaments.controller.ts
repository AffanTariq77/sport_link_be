import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { entryStatus, fixtureStatus, gender, paymentMethod, tournamentFormat, tournamentStatus } from '../db/schema.js';
import { TournamentError, TournamentsService } from './tournaments.service.js';

const STATUS: Record<TournamentError['code'], number> = {
  NOT_FOUND: 404,
  INVALID_TOURNAMENT: 400,
  CLOSED: 409,
  FULL: 409,
  NOT_ELIGIBLE: 403,
  ALREADY_ENTERED: 409,
  NOT_PENDING: 409,
  DUPLICATE_TRANSACTION: 409,
  NOT_READY: 409,
  INVALID_RESULT: 400,
};
const run = <T>(fn: () => Promise<T>) => withErrors(TournamentError, STATUS, fn);
const actor = (req: AdminRequest) => ({ adminId: req.admin.admin.id, ip: req.ip ?? null });

const Id = z.uuid('Not found.');
const Ok = z.object({ ok: z.boolean() });
const Eligibility = z
  .object({
    minAge: z.int().min(5).max(100).optional(),
    maxAge: z.int().min(5).max(100).optional(),
    gender: z.enum(gender.enumValues).nullable().optional(),
    verifiedOnly: z.boolean().optional(),
    minRating: z.int().min(0).max(4000).optional(),
    maxRating: z.int().min(0).max(4000).optional(),
  })
  .meta({ id: 'TournamentEligibility' });
const Summary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    sport: z.string(),
    format: z.enum(tournamentFormat.enumValues),
    teamEntry: z.boolean(),
    entryFee: z.int().meta({ description: 'Minor units' }),
    currency: z.string(),
    venue: z.string(),
    startsAt: z.iso.datetime(),
    registrationDeadline: z.iso.datetime(),
    status: z.enum(tournamentStatus.enumValues),
    programme: z.string().nullable(),
  })
  .meta({ id: 'TournamentSummary' });
const TableRow = z.object({
  entryId: z.uuid(),
  name: z.string(),
  played: z.int(),
  won: z.int(),
  drawn: z.int(),
  lost: z.int(),
  for: z.int(),
  against: z.int(),
  difference: z.int(),
  points: z.int(),
});
const Detail = z
  .object({
    id: z.uuid(),
    name: z.string(),
    sport: z.string(),
    format: z.enum(tournamentFormat.enumValues),
    teamEntry: z.boolean(),
    entryFee: z.int(),
    currency: z.string(),
    prize: z.string().nullable(),
    venue: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    registrationDeadline: z.iso.datetime(),
    maxEntries: z.int(),
    eligibility: Eligibility,
    programme: z.string().nullable(),
    status: z.enum(tournamentStatus.enumValues),
    payTo: z.string().nullable().meta({ description: 'Shown to entrants only' }),
    feePayee: z.enum(['venue', 'sportslink']),
    registrationOpen: z.boolean(),
    entries: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        status: z.enum(entryStatus.enumValues),
        seed: z.int().nullable(),
        groupNo: z.int().nullable(),
        teamId: z.uuid().nullable(),
      }),
    ),
    mine: z.array(
      z.object({ id: z.uuid(), name: z.string(), status: z.enum(entryStatus.enumValues), teamId: z.uuid().nullable() }),
    ),
    fixtures: z.array(
      z.object({
        id: z.uuid(),
        stage: z.string(),
        round: z.int(),
        groupNo: z.int().nullable(),
        a: z.string().nullable(),
        b: z.string().nullable(),
        entryA: z.uuid().nullable(),
        entryB: z.uuid().nullable(),
        scoreA: z.int().nullable(),
        scoreB: z.int().nullable(),
        winner: z.string().nullable(),
        status: z.enum(fixtureStatus.enumValues),
        scheduledAt: z.iso.datetime().nullable(),
      }),
    ),
    tables: z.array(z.object({ group: z.int().nullable(), rows: z.array(TableRow) })),
  })
  .meta({ id: 'Tournament' });
const PayBody = z
  .object({
    method: z.enum(paymentMethod.enumValues.filter((m) => m !== 'cash') as ['jazzcash', 'easypaisa', 'bank_transfer']),
    txnReference: z.string().trim().min(4, 'Enter the transaction ID from your receipt.').max(40),
  })
  .meta({ id: 'TournamentPay' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class TournamentsController {
  constructor(@Inject(TournamentsService) private readonly tournaments: TournamentsService) {}

  /** Future programmes (spec 12.2): government trials are a placeholder until they launch. */
  @Get('programmes')
  @ApiOkResponse({
    standardSchema: z.array(z.object({ key: z.string(), name: z.string(), status: z.enum(['coming_soon', 'live']) })),
  })
  programmes() {
    return [{ key: 'government_trials', name: 'Government trials', status: 'coming_soon' as const }];
  }

  @Get('tournaments')
  @ApiOkResponse({ standardSchema: z.array(Summary) })
  list(@Query({ schema: z.object({ sport: z.string().max(40).optional() }) }) q: { sport?: string }) {
    return this.tournaments.list(q);
  }

  @Get('tournaments/:id')
  @ApiOkResponse({ standardSchema: Detail })
  get(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.tournaments.get(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post('tournaments/:id/entries')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid(), status: z.enum(entryStatus.enumValues) }) })
  enter(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ teamId: z.uuid().optional() }).meta({ id: 'TournamentEntry' }) })
    body: { teamId?: string },
  ) {
    return run(() => this.tournaments.enter(req.auth.user.id, id, body));
  }

  @UseGuards(UnlockedGuard)
  @Post('tournaments/:id/entries/:entryId/pay')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.enum(entryStatus.enumValues) }) })
  pay(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('entryId', { schema: Id }) entryId: string,
    @Body({ schema: PayBody }) body: z.infer<typeof PayBody>,
  ) {
    return run(() => this.tournaments.pay(req.auth.user.id, id, entryId, body));
  }

  @Post('tournaments/:id/entries/:entryId/withdraw')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  withdraw(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('entryId', { schema: Id }) entryId: string,
  ) {
    return run(() => this.tournaments.withdraw(req.auth.user.id, id, entryId));
  }
}

const CreateBody = z
  .object({
    sport: z.string().max(40),
    name: z.string().trim().min(3).max(100),
    format: z.enum(tournamentFormat.enumValues),
    teamEntry: z.boolean(),
    entryFee: z.int().min(0).meta({ description: 'Minor units' }),
    prize: z.string().trim().max(200).optional(),
    venue: z.string().trim().min(2).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    registrationDeadline: z.iso.datetime({ offset: true }),
    maxEntries: z.int().min(2).max(256),
    groupSize: z.int().min(3).max(8).optional(),
    eligibility: Eligibility.default({}),
    payTo: z.string().trim().max(300).optional().meta({ description: 'Where entrants send the fee' }),
    programme: z.enum(['government_trials']).optional(),
  })
  .meta({ id: 'CreateTournament' });
const ResultBody = z
  .object({
    scoreA: z.int().min(0).max(999).optional(),
    scoreB: z.int().min(0).max(999).optional(),
    winner: z.enum(['a', 'b']).optional(),
    walkover: z.boolean().optional(),
  })
  .meta({ id: 'TournamentResult' });
const AdminEntries = z
  .array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(entryStatus.enumValues),
      method: z.enum(paymentMethod.enumValues).nullable(),
      txnReference: z.string().nullable(),
      seed: z.int().nullable(),
      rosterUnlocked: z.boolean(),
    }),
  )
  .meta({ id: 'TournamentAdminEntries' });

@Controller('admin/tournaments')
@UseGuards(AdminGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminTournamentsController {
  constructor(@Inject(TournamentsService) private readonly tournaments: TournamentsService) {}

  @Post()
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  create(@Req() req: AdminRequest, @Body({ schema: CreateBody }) body: z.infer<typeof CreateBody>) {
    return run(() =>
      this.tournaments.create(
        {
          ...body,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          registrationDeadline: new Date(body.registrationDeadline),
        },
        actor(req),
      ),
    );
  }

  @Get()
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: z.array(Summary) })
  list() {
    return this.tournaments.list({});
  }

  @Get(':id')
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: Detail })
  get(@Param('id', { schema: Id }) id: string) {
    return run(() => this.tournaments.get(null, id));
  }

  @Get(':id/entries')
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: AdminEntries })
  entries(@Param('id', { schema: Id }) id: string) {
    return this.tournaments.adminEntries(id);
  }

  @Post(':id/entries/:entryId/:decision')
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: Ok })
  decide(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('entryId', { schema: Id }) entryId: string,
    @Param('decision', { schema: z.enum(['confirm', 'reject', 'withdraw', 'unlock', 'lock']) }) decision: string,
    @Body({ schema: z.object({ reason: z.string().trim().max(300).optional() }).meta({ id: 'EntryDecision' }) })
    body: { reason?: string },
  ) {
    return run(() => {
      if (decision === 'withdraw')
        return this.tournaments.adminWithdraw(id, entryId, body.reason ?? 'Withdrawn by SportsLink', actor(req));
      if (decision === 'unlock' || decision === 'lock')
        return this.tournaments.setRosterUnlocked(id, entryId, decision === 'unlock', actor(req));
      return this.tournaments.decideEntry(id, entryId, decision === 'confirm', actor(req));
    });
  }

  @Post(':id/draw')
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: z.object({ ok: z.boolean(), entries: z.int() }) })
  draw(@Req() req: AdminRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.tournaments.draw(id, actor(req)));
  }

  @Post(':id/knockout')
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: Ok })
  knockout(@Req() req: AdminRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.tournaments.startKnockout(id, actor(req)));
  }

  @Post(':id/fixtures/:fixtureId/result')
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: Ok })
  result(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('fixtureId', { schema: Id }) fixtureId: string,
    @Body({ schema: ResultBody }) body: z.infer<typeof ResultBody>,
  ) {
    return run(() => this.tournaments.result(id, fixtureId, body, actor(req)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Permission('tournaments.manage')
  @ApiOkResponse({ standardSchema: Ok })
  cancel(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ reason: z.string().trim().min(3).max(300) }).meta({ id: 'CancelTournament' }) })
    body: { reason: string },
  ) {
    return run(() => this.tournaments.cancel(id, body.reason, actor(req)));
  }
}
