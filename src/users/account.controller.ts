import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { AuthError } from '../auth/auth.service.js';
import { AccountError, AccountService } from './account.service.js';

const STATUS: Record<AccountError['code'], number> = {
  INVALID_PHONE: 400,
  SAME_PHONE: 400,
  PHONE_TAKEN: 409,
  NOT_FOUND: 404,
  HAS_COMMITMENTS: 409,
};
const AUTH_STATUS: Record<AuthError['code'], number> = {
  INVALID_PHONE: 400,
  RATE_LIMITED: 429,
  LOCKED: 429,
  INVALID_CODE: 400, // already signed in: a wrong code is bad input, not a lost session
  ACCOUNT_BLOCKED: 403,
  INVALID_TOKEN: 401,
};
const run = <T>(fn: () => Promise<T>) => withErrors(AuthError, AUTH_STATUS, () => withErrors(AccountError, STATUS, fn));
const Ok = z.object({ ok: z.boolean() });
const Phone = z.string().max(32).meta({ example: '0300 1234567' });

@Controller()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Post('me/phone/start')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  start(
    @Req() req: AuthedRequest,
    @Body({ schema: z.object({ phone: Phone }).meta({ id: 'PhoneChangeStart' }) }) body: { phone: string },
  ) {
    return run(() => this.account.startPhoneChange(req.auth.user.id, body.phone));
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Post('me/phone/confirm')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  confirm(
    @Req() req: AuthedRequest,
    @Body({
      schema: z
        .object({ phone: Phone, oldCode: z.string().max(6), newCode: z.string().max(6) })
        .meta({ id: 'PhoneChangeConfirm' }),
    })
    body: { phone: string; oldCode: string; newCode: string },
  ) {
    return run(() =>
      this.account.confirmPhoneChange(req.auth.user.id, {
        newPhone: body.phone,
        oldCode: body.oldCode,
        newCode: body.newCode,
      }),
    );
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Post('me/phone/review')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  review(
    @Req() req: AuthedRequest,
    @Body({
      schema: z
        .object({
          phone: Phone,
          reason: z.string().trim().min(10, 'Tell us what happened to your old number.').max(500),
        })
        .meta({ id: 'PhoneChangeReview' }),
    })
    body: { phone: string; reason: string },
  ) {
    return run(() => this.account.requestPhoneReview(req.auth.user.id, { newPhone: body.phone, reason: body.reason }));
  }

  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Post('me/delete')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  delete(
    @Req() req: AuthedRequest,
    @Body({
      schema: z
        .object({ confirm: z.literal(true, 'Confirm that you want to delete your account.') })
        .meta({ id: 'DeleteAccount' }),
    })
    body: { confirm: true },
  ) {
    // The schema only accepts confirm: true, so a stray request cannot delete an account.
    return run(() => (body.confirm ? this.account.deleteAccount(req.auth.user.id) : Promise.resolve({ ok: false })));
  }

  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @Permission('users.ban')
  @Post('admin/users/:id/phone')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Ok })
  adminPhone(
    @Req() req: AdminRequest,
    @Param('id', { schema: z.uuid('Not found.') }) id: string,
    @Body({ schema: z.object({ phone: Phone }).meta({ id: 'AdminPhoneChange' }) }) body: { phone: string },
  ) {
    return run(() =>
      this.account.adminChangePhone(id, body.phone, { adminId: req.admin.admin.id, ip: req.ip ?? null }),
    );
  }
}
