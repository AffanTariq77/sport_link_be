import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { NotificationsService } from './notifications.service.js';

const List = z
  .object({
    unread: z.int(),
    items: z.array(
      z.object({
        id: z.uuid(),
        kind: z.string(),
        title: z.string(),
        body: z.string(),
        link: z.string().nullable(),
        readAt: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'NotificationList' });
const Ok = z.object({ ok: z.boolean() }).meta({ id: 'Ok' });

@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @ApiOkResponse({ standardSchema: List })
  list(@Req() req: AuthedRequest) {
    return this.notifications.list(req.auth.user.id);
  }

  @Post('notifications/read')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  read(
    @Req() req: AuthedRequest,
    @Body({ schema: z.object({ ids: z.array(z.uuid()).max(200).optional() }).meta({ id: 'MarkRead' }) })
    body: { ids?: string[] },
  ) {
    return this.notifications.markRead(req.auth.user.id, body.ids);
  }

  @Post('me/devices')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  device(
    @Req() req: AuthedRequest,
    @Body({
      schema: z
        .object({
          fingerprint: z.string().min(8).max(100),
          platform: z.enum(['ios', 'android', 'web']),
          pushToken: z.string().max(300).optional(),
        })
        .meta({ id: 'DeviceRegistration' }),
    })
    body: { fingerprint: string; platform: 'ios' | 'android' | 'web'; pushToken?: string },
  ) {
    return this.notifications.registerDevice(req.auth.user.id, body);
  }
}
