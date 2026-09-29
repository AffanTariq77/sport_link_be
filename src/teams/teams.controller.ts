import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { matchStatus, teamMemberStatus, teamRole } from '../db/schema.js';
import { TeamError, TeamsService } from './teams.service.js';

const STATUS: Record<TeamError['code'], number> = {
  NOT_FOUND: 404,
  NOT_CAPTAIN: 403,
  INVALID_TEAM: 400,
  ALREADY_MEMBER: 409,
  NOT_INVITED: 409,
  CAPTAIN_LEAVING: 409,
};
const run = <T>(fn: () => Promise<T>) => withErrors(TeamError, STATUS, fn);

const Id = z.uuid('Not found.');
const CreateBody = z
  .object({
    sport: z.string().max(40),
    name: z.string().trim().min(2, 'Enter a team name.').max(60),
    city: z.string().trim().max(80).optional(),
  })
  .meta({ id: 'CreateTeam' });
const TeamSummary = z
  .object({ id: z.uuid(), name: z.string(), sport: z.string(), city: z.string().nullable() })
  .meta({ id: 'TeamSummary' });
const MyTeam = TeamSummary.extend({
  role: z.enum(teamRole.enumValues),
  status: z.enum(teamMemberStatus.enumValues),
}).meta({ id: 'MyTeam' });
const Team = z
  .object({
    id: z.uuid(),
    name: z.string(),
    city: z.string().nullable(),
    sport: z.string(),
    sportSlug: z.string(),
    myRole: z.enum(teamRole.enumValues).nullable(),
    invited: z.boolean(),
    members: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        role: z.enum(teamRole.enumValues),
        status: z.enum(teamMemberStatus.enumValues),
      }),
    ),
    rating: z
      .object({ rating: z.int(), provisional: z.boolean(), tier: z.string().nullable(), games: z.int() })
      .nullable(),
    matches: z.array(
      z.object({
        id: z.uuid(),
        startAt: z.iso.datetime(),
        status: z.enum(matchStatus.enumValues),
        opponent: z.string().nullable(),
        result: z.enum(['won', 'lost', 'draw']).nullable(),
        score: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'Team' });
const Ok = z.object({ ok: z.boolean() });

@Controller('teams')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @UseGuards(UnlockedGuard)
  @Post()
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  create(@Req() req: AuthedRequest, @Body({ schema: CreateBody }) body: z.infer<typeof CreateBody>) {
    return run(() => this.teams.create(req.auth.user.id, body));
  }

  @Get()
  @ApiOkResponse({ standardSchema: z.array(TeamSummary) })
  list(
    @Query({ schema: z.object({ sport: z.string().max(40).optional(), q: z.string().max(60).optional() }) })
    q: {
      sport?: string;
      q?: string;
    },
  ) {
    return this.teams.list(q);
  }

  @Get('mine')
  @ApiOkResponse({ standardSchema: z.array(MyTeam) })
  mine(@Req() req: AuthedRequest) {
    return this.teams.mine(req.auth.user.id);
  }

  @Get(':id')
  @ApiOkResponse({ standardSchema: Team })
  get(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.teams.get(req.auth.user.id, id));
  }

  @UseGuards(UnlockedGuard)
  @Post(':id/invites')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  invite(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ phone: z.string().max(20) }).meta({ id: 'TeamInvite' }) }) body: { phone: string },
  ) {
    return run(() => this.teams.invite(req.auth.user.id, id, body.phone));
  }

  @UseGuards(UnlockedGuard)
  @Post(':id/invites/respond')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  respond(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ accept: z.boolean() }).meta({ id: 'TeamInviteAnswer' }) }) body: { accept: boolean },
  ) {
    return run(() => this.teams.respond(req.auth.user.id, id, body.accept));
  }

  @Post(':id/leave')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  leave(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.teams.leave(req.auth.user.id, id));
  }

  @Post(':id/members/:userId/remove')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  remove(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('userId', { schema: Id }) userId: string,
  ) {
    return run(() => this.teams.remove(req.auth.user.id, id, userId));
  }

  @Post(':id/members/:userId/role')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  setRole(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('userId', { schema: Id }) userId: string,
    @Body({ schema: z.object({ role: z.enum(teamRole.enumValues) }).meta({ id: 'TeamRole' }) })
    body: { role: 'captain' | 'vice_captain' | 'member' },
  ) {
    return run(() => this.teams.setRole(req.auth.user.id, id, userId, body.role));
  }
}

/** Admin assigns a captain when the captain is banned and there is no vice captain (spec 12.1). */
@Controller('admin/teams')
@UseGuards(AdminGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminTeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Get(':id')
  @Permission('reports.review')
  @ApiOkResponse({ standardSchema: Team })
  get(@Param('id', { schema: Id }) id: string) {
    return run(() => this.teams.get(null, id));
  }

  @Post(':id/captain')
  @HttpCode(200)
  @Permission('reports.review')
  @ApiOkResponse({ standardSchema: Ok })
  assignCaptain(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ userId: z.uuid() }).meta({ id: 'AssignCaptain' }) }) body: { userId: string },
  ) {
    return run(() => this.teams.assignCaptain(id, body.userId, { adminId: req.admin.admin.id, ip: req.ip ?? null }));
  }
}
