import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthedRequest } from './auth.guard.js';

/**
 * For actions a minor cannot take until a guardian has consented (spec 5): booking, paying, matches, chat,
 * applying as a vendor. Use after AuthGuard.
 */
@Injectable()
export class UnlockedGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth.user.locked) {
      throw new ForbiddenException({
        code: 'GUARDIAN_CONSENT_NEEDED',
        message: 'A parent or guardian needs to approve your account before you can do this.',
      });
    }
    return true;
  }
}
