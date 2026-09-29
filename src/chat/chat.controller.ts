import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { UnlockedGuard } from '../auth/unlocked.guard.js';
import { conversationType } from '../db/schema.js';
import { ChatError, ChatService } from './chat.service.js';

const STATUS: Record<ChatError['code'], number> = { NOT_FOUND: 404, PHONE_WARNING: 409, EMPTY: 400, BLOCKED: 400 };
const run = <T>(fn: () => Promise<T>) => withErrors(ChatError, STATUS, fn);
const Id = z.uuid('Not found.');

const Opened = z.object({ id: z.uuid() }).meta({ id: 'ConversationRef' });
const ConversationRow = z
  .object({
    id: z.uuid(),
    type: z.enum(conversationType.enumValues),
    title: z.string(),
    lastMessage: z.string().nullable(),
    lastAt: z.iso.datetime().nullable(),
    unread: z.int(),
  })
  .meta({ id: 'ConversationSummary' });
const Thread = z
  .object({
    id: z.uuid(),
    type: z.enum(conversationType.enumValues),
    messages: z.array(
      z.object({
        id: z.uuid(),
        kind: z.string(),
        body: z.string().nullable(),
        createdAt: z.iso.datetime(),
        senderId: z.uuid().nullable(),
        senderName: z.string().nullable(),
        flaggedPhone: z.boolean(),
        mine: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ChatThread' });
const SendBody = z
  .object({
    body: z.string().max(2000),
    confirmPhone: z.boolean().optional().meta({ description: 'Send even though it contains a phone number' }),
  })
  .meta({ id: 'SendMessage' });
const ReportBody = z
  .object({ reason: z.string().trim().min(3, 'Choose a reason.').max(80), details: z.string().max(1000).optional() })
  .meta({ id: 'ReportChat' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get('conversations')
  @ApiOkResponse({ standardSchema: z.array(ConversationRow) })
  list(@Req() req: AuthedRequest) {
    return this.chat.list(req.auth.user.id);
  }

  @UseGuards(UnlockedGuard)
  @Post('conversations/match/:matchId')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Opened })
  openMatch(@Req() req: AuthedRequest, @Param('matchId', { schema: Id }) matchId: string) {
    return run(() => this.chat.openMatch(req.auth.user.id, matchId));
  }
  @UseGuards(UnlockedGuard)
  @Post('conversations/find/:requestId')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Opened })
  openFind(@Req() req: AuthedRequest, @Param('requestId', { schema: Id }) requestId: string) {
    return run(() => this.chat.openFind(req.auth.user.id, requestId));
  }

  @UseGuards(UnlockedGuard)
  @Post('conversations/team/:teamId')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Opened })
  openTeam(@Req() req: AuthedRequest, @Param('teamId', { schema: Id }) teamId: string) {
    return run(() => this.chat.openTeam(req.auth.user.id, teamId));
  }

  @UseGuards(UnlockedGuard)
  @Post('conversations/booking/:bookingId')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Opened })
  openBooking(@Req() req: AuthedRequest, @Param('bookingId', { schema: Id }) bookingId: string) {
    return run(() => this.chat.openBooking(req.auth.user.id, bookingId));
  }

  @Get('conversations/:id/messages')
  @ApiOkResponse({ standardSchema: Thread })
  messages(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Query({ schema: z.object({ after: z.iso.datetime({ offset: true }).optional() }) }) q: { after?: string },
  ) {
    return run(() => this.chat.messages(req.auth.user.id, id, q.after ? new Date(q.after) : undefined));
  }

  @UseGuards(UnlockedGuard)
  @Post('conversations/:id/messages')
  @HttpCode(200)
  @ApiOkResponse({
    standardSchema: z.object({ id: z.uuid(), createdAt: z.iso.datetime() }).meta({ id: 'SentMessage' }),
  })
  send(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: SendBody }) body: z.infer<typeof SendBody>,
  ) {
    return run(() => this.chat.send(req.auth.user.id, id, body));
  }

  @Post('conversations/:id/report')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  report(
    @Req() req: AuthedRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: ReportBody }) body: z.infer<typeof ReportBody>,
  ) {
    return run(() => this.chat.report(req.auth.user.id, id, body));
  }

  @Post('users/:id/block')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: z.object({ blocked: z.boolean() }) })
  block(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.chat.block(req.auth.user.id, id));
  }

  @Delete('users/:id/block')
  @ApiOkResponse({ standardSchema: z.object({ blocked: z.boolean() }) })
  unblock(@Req() req: AuthedRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.chat.unblock(req.auth.user.id, id));
  }
}
