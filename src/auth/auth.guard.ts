import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type AuthContext, AuthService } from './auth.service.js';

export type AuthedRequest = { headers: Record<string, string | undefined>; auth: AuthContext };

/** Requires `Authorization: Bearer <access token>`. Puts the session and user on `req.auth`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const auth = token ? await this.auth.authenticate(token) : null;
    if (!auth) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    req.auth = auth;
    return true;
  }
}
