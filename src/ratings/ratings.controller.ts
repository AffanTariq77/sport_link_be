import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { resultOutcome, resultStatus } from '../db/schema.js';
import { PlayersService } from './players.service.js';
import { ResultError, ResultsService } from './results.service.js';

const STATUS: Record<ResultError['code'], number> = {
  NOT_FOUND: 404,
  NOT_FINISHED: 409,
  INVALID_SIDES: 400,
  ALREADY_SUBMITTED: 409,
  NOT_PENDING: 409,
  NOT_OTHER_SIDE: 403,
  NOTE_REQUIRED: 400,
  REVIEW_CLOSED: 409,
  ALREADY_REVIEWED: 409,
  INVALID_REVIEW: 400,
};
const run = <T>(fn: () => Promise<T>) => withErrors(ResultError, STATUS, fn);
const actor = (req: AdminRequest) => ({ adminId: req.admin.admin.id, ip: req.ip ?? null });

const Id = z.uuid('Not found.');
const Outcome = z.enum(resultOutcome.enumValues).meta({ description: 'a: side A won, b: side B won, or draw' });
const Player = z.object({ id: z.uuid(), name: z.string() });
const ResultState = z
  .object({
    finished: z.boolean(),
    participants: z.array(Player),
    result: z
      .object({
        id: z.uuid(),
        sideA: z.array(z.uuid()),
        sideB: z.array(z.uuid()),
        outcome: Outcome,
        score: z.string().nullable(),
        status: z.enum(resultStatus.enumValues),
        confirmBy: z.iso.datetime(),
        submittedBy: z.uuid(),
      })
      .nullable(),
    canSubmit: z.boolean(),
    canRespond: z.boolean(),
    reviewTags: z.array(z.string()),
    reviewable: z.array(Player.extend({ reviewed: z.boolean() })),
  })
  .meta({ id: 'MatchResultState' });
const SubmitBody = z
  .object({
    sideA: z.array(z.uuid()).min(1).max(40),
    sideB: z.array(z.uuid()).min(1).max(40),
    outcome: Outcome,
    score: z.string().trim().max(60).optional(),
  })
  .meta({ id: 'SubmitResult' });
const RespondBody = z
  .object({ agree: z.boolean(), note: z.string().trim().max(500).optional() })
  .meta({ id: 'RespondResult' });
const ReviewBody = z
  .object({
    toUserId: z.uuid(),
    stars: z.int().min(1, 'Give 1 to 5 stars.').max(5, 'Give 1 to 5 stars.'),
    tags: z.array(z.string().max(40)).max(6).default([]),
    comment: z.string().trim().max(300).optional(),
  })
  .meta({ id: 'ReviewPlayer' });
const Profile = z
  .object({
    id: z.uuid(),
    name: z.string(),
    city: z.string().nullable(),
    verified: z.boolean(),
    matchesPlayed: z.int(),
    ratings: z.array(
      z.object({
        sport: z.string(),
        slug: z.string(),
        rating: z.int(),
        provisional: z.boolean(),
        tier: z.string().nullable(),
        games: z.int(),
      }),
    ),
    behaviour: z.object({
      average: z.number().nullable(),
      count: z.int(),
      topTags: z.array(z.object({ tag: z.string(), count: z.int() })),
    }),
  })
  .meta({ id: 'PlayerProfile' });
const Leaderboard = z
  .array(
    z.object({
      rank: z.int(),
      id: z.uuid(),
      name: z.string(),
      city: z.string().nullable(),
      rating: z.int(),
      tier: z.string().nullable(),
      games: z.int(),
    }),
  )
  .meta({ id: 'Leaderboard' });
const Ok = z.object({ ok: z.boolean() });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class RatingsController {
  constructor(
    @Inject(ResultsService) private readonly results: ResultsService,
    @Inject(PlayersService) private readonly players: PlayersService,
  ) {}

  @Get('matches/:id/result')
  @ApiOkResponse({ standardSchema: ResultState })
  state(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.results.state(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post('matches/:id/result')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.enum(resultStatus.enumValues), confirmBy: z.iso.datetime() }) })
  submit(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: SubmitBody }) body: z.infer<typeof SubmitBody>,
  ) {
    return run(() => this.results.submit(req.auth.user.id, id, body));
  }

  @UseGuards(UnlockedGuard)
  @Post('matches/:id/result/respond')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ status: z.enum(resultStatus.enumValues) }) })
  respond(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: RespondBody }) body: z.infer<typeof RespondBody>,
  ) {
    return run(() => this.results.respond(req.auth.user.id, id, body));
  }

  @UseGuards(UnlockedGuard)
  @Post('matches/:id/reviews')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  review(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: ReviewBody }) body: z.infer<typeof ReviewBody>,
  ) {
    return run(() => this.results.review(req.auth.user.id, id, body));
  }

  @Get('players/:id')
  @ApiOkResponse({ standardSchema: Profile })
  profile(@Param('id', { schema: Id }) id: string) {
    return run(() => this.players.profile(id));
  }

  @Get('leaderboards/:sport')
  @ApiOkResponse({ standardSchema: Leaderboard })
  leaderboard(
    @Param('sport', { schema: z.string().max(40) }) sport: string,
    @Query({ schema: z.object({ city: z.string().max(80).optional() }) }) q: { city?: string },
  ) {
    return run(() => this.players.leaderboard(sport, q.city));
  }
}

const Disputed = z
  .array(
    z.object({
      id: z.uuid(),
      matchId: z.uuid(),
      sideA: z.array(z.uuid()),
      sideB: z.array(z.uuid()),
      outcome: Outcome,
      score: z.string().nullable(),
      disputeNote: z.string().nullable(),
      submittedBy: z.uuid(),
      startAt: z.iso.datetime(),
      createdAt: z.iso.datetime(),
    }),
  )
  .meta({ id: 'DisputedResults' });
const DecideBody = z
  .object({
    outcome: z.enum([...resultOutcome.enumValues, 'void']),
    note: z.string().trim().min(1, 'Explain the decision.').max(500),
  })
  .meta({ id: 'DecideResult' });

@Controller('admin/results')
@UseGuards(AdminGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminResultsController {
  constructor(@Inject(ResultsService) private readonly results: ResultsService) {}

  @Get('disputed')
  @Permission('disputes.resolve')
  @ApiOkResponse({ standardSchema: Disputed })
  disputed() {
    return this.results.listDisputed();
  }

  @Post(':id/decide')
  @HttpCode(200)
  @Permission('disputes.resolve')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid(), status: z.enum(resultStatus.enumValues) }) })
  decide(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: DecideBody }) body: z.infer<typeof DecideBody>,
  ) {
    return run(() => this.results.decide(id, body, actor(req)));
  }
}
