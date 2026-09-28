import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import { userStatus } from '../db/schema.js';
import { AuthGuard, type AuthedRequest } from './auth.guard.js';
import { AuthError, AuthService } from './auth.service.js';

const STATUS: Record<AuthError['code'], number> = {
  INVALID_PHONE: 400,
  RATE_LIMITED: 429,
  LOCKED: 429,
  INVALID_CODE: 401,
  ACCOUNT_BLOCKED: 403,
  INVALID_TOKEN: 401,
};

// Request schemas validate input (global StandardSchemaValidationPipe). Response schemas document the
// API for the generated frontend client. Both end up in the OpenAPI spec.
const PhoneBody = z.object({ phone: z.string().max(32).meta({ example: '0300 1234567' }) }).meta({ id: 'OtpRequest' });
const VerifyBody = z
  .object({ phone: z.string().max(32), code: z.string().max(16).meta({ example: '123456' }) })
  .meta({ id: 'OtpVerify' });
const RefreshBody = z.object({ refreshToken: z.string().max(128) }).meta({ id: 'RefreshRequest' });

export const User = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    status: z.enum(userStatus.enumValues),
    isMinor: z.boolean(),
    countryCode: z.string(),
  })
  .meta({ id: 'User' });
const Tokens = z
  .object({
    accessToken: z.string(),
    accessExpiresAt: z.iso.datetime(),
    refreshToken: z.string(),
    refreshExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'Tokens' });
const SignedIn = Tokens.extend({ isNewUser: z.boolean(), user: User }).meta({ id: 'SignedIn' });
const OtpSent = z.object({ resendInSeconds: z.int() }).meta({ id: 'OtpSent' });

const run = <T>(fn: () => Promise<T>) => withErrors(AuthError, STATUS, fn);

@Controller('auth')
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: OtpSent })
  requestOtp(@Body({ schema: PhoneBody }) body: z.infer<typeof PhoneBody>) {
    return run(() => this.auth.requestOtp(body));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: SignedIn })
  verifyOtp(@Body({ schema: VerifyBody }) body: z.infer<typeof VerifyBody>) {
    return run(() => this.auth.verifyOtp(body));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: Tokens })
  refresh(@Body({ schema: RefreshBody }) body: z.infer<typeof RefreshBody>) {
    return run(() => this.auth.refresh(body));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Signed out' })
  async logout(@Req() req: AuthedRequest) {
    await this.auth.logout(req.auth.sessionId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ standardSchema: User })
  me(@Req() req: AuthedRequest) {
    return req.auth.user;
  }
}
