import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminPermission } from '../settings.js';
import { type AdminContext, AdminAuthService } from './admin-auth.service.js';

export type AdminRequest = { headers: Record<string, string | undefined>; ip?: string; admin: AdminContext };

const PERMISSION = 'admin:permission';
/** Marks an admin endpoint with the permission it needs. */
export const Permission = (permission: AdminPermission) => SetMetadata(PERMISSION, permission);

/** Admin bearer token plus the endpoint's permission, if it declares one. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const admin = token ? await this.auth.authenticate(token) : null;
    if (!admin) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    const needed = this.reflector.get<string | undefined>(PERMISSION, ctx.getHandler());
    if (needed && !admin.permissions.includes(needed)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Your role cannot do this.' });
    }
    req.admin = admin;
    return true;
  }
}
