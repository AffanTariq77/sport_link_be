import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { adminSessions, adminUsers } from '../db/schema.js';
import { getSetting } from '../settings.js';
import { DocumentCrypto } from '../verification/document-crypto.js';
import { audit } from './audit.js';
import { verifyPassword } from './password.js';
import { verifyTotp } from './totp.js';

export const DEV_TOTP = Symbol('DEV_TOTP');

export class AdminAuthError extends Error {
  constructor(
    public readonly code: 'INVALID_LOGIN' | 'LOCKED',
    message: string,
  ) {
    super(message);
  }
}

export interface AdminContext {
  sessionId: string;
  admin: { id: string; name: string; email: string; role: string };
  permissions: string[];
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
    @Optional() @Inject(DEV_TOTP) private readonly devCode?: string,
  ) {}

  /** Password and two-factor code together, both mandatory (spec 14). Lockout after repeated failures. */
  async login(input: { email: string; password: string; code: string; ip?: string; now?: Date }) {
    const now = input.now ?? new Date();
    const [admin] = await this.db
      .select()
      .from(adminUsers)
      .where(eq(sql`lower(${adminUsers.email})`, input.email.trim().toLowerCase()));
    const invalid = new AdminAuthError('INVALID_LOGIN', 'Email, password or code is wrong.');
    if (!admin || !admin.active) {
      await verifyPassword(input.password, DUMMY_HASH);
      throw invalid;
    }
    if (admin.lockedUntil && admin.lockedUntil > now) {
      throw new AdminAuthError('LOCKED', 'Too many failed attempts. Try again later.');
    }

    const passwordOk = await verifyPassword(input.password, admin.passwordHash);
    const codeOk = this.devCode
      ? input.code === this.devCode
      : !!admin.totpSecretEncrypted && verifyTotp(this.crypto.decryptTotp(admin.totpSecretEncrypted), input.code, now);
    if (!passwordOk || !codeOk) {
      const max = await getSetting(this.db, 'admin.max_failed_logins');
      const failed = admin.failedLoginCount + 1;
      const lock = failed >= max ? await getSetting(this.db, 'admin.lockout_minutes') : 0;
      await this.db
        .update(adminUsers)
        .set({
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(now.getTime() + lock * 60_000) : admin.lockedUntil,
        })
        .where(eq(adminUsers.id, admin.id));
      throw invalid;
    }

    const token = randomBytes(32).toString('base64url');
    const hours = await getSetting(this.db, 'admin.session_hours');
    const expiresAt = new Date(now.getTime() + hours * 3_600_000);
    await this.db.transaction(async (tx) => {
      await tx.update(adminUsers).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(adminUsers.id, admin.id));
      await tx
        .insert(adminSessions)
        .values({ adminId: admin.id, tokenHash: hash(token), expiresAt, ip: input.ip ?? null });
      await audit(tx, {
        actorId: admin.id,
        action: 'admin.login',
        targetType: 'admin',
        targetId: admin.id,
        ip: input.ip,
      });
    });
    return { token, expiresAt, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } };
  }

  async authenticate(token: string, now = new Date()): Promise<AdminContext | null> {
    const [row] = await this.db
      .select({
        sessionId: adminSessions.id,
        admin: { id: adminUsers.id, name: adminUsers.name, email: adminUsers.email, role: adminUsers.role },
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminId))
      .where(
        and(
          eq(adminSessions.tokenHash, hash(token)),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.expiresAt, now),
          eq(adminUsers.active, true),
        ),
      );
    if (!row) return null;
    const roles = await getSetting(this.db, 'admin.role_permissions');
    return { ...row, permissions: [...(roles[row.admin.role] ?? [])] };
  }

  async logout(sessionId: string, now = new Date()) {
    await this.db.update(adminSessions).set({ revokedAt: now }).where(eq(adminSessions.id, sessionId));
  }
}
