import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service.js';
import { loadEnv } from '../config.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { auditLog, moderationActions, users } from '../db/schema.js';
import { GuardianService } from '../users/guardian.service.js';

const EVERY_MS = 5 * 60_000;
const LOCK_KEY = 7_411_203; // any constant shared by every API instance

/**
 * Scheduled work: complete finished bookings, issue monthly invoices, run the overdue ladder, end expired
 * suspensions. Each job is idempotent, and a Postgres advisory lock lets only one instance run them at a time.
 * ponytail: an in-process timer; move to BullMQ (spec 2) when jobs need retries, spreading or their own workers.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Jobs');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(GuardianService) private readonly guardians: GuardianService,
  ) {}

  onApplicationBootstrap() {
    if (loadEnv().NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runAll(), EVERY_MS);
    setTimeout(() => void this.runAll(), 10_000);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async runAll(now = new Date()) {
    try {
      return await this.db.transaction(async (tx) => {
        const [lock] = await tx
          .execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`)
          .then((r) => r.rows);
        if (!lock?.ok) return null; // another instance is running them
        const result = {
          ...(await this.billing.completeFinishedBookings(now)),
          ...(await this.billing.issueMonthlyInvoices(now)),
          ladder: (await this.billing.runOverdueLadder(now)).done.length,
          ...(await this.endExpiredSuspensions(now)),
          ...(await this.guardians.endGuardianshipAt18(now)),
        };
        if (result.completed || result.issued || result.ladder || result.reinstated || result.turned18)
          this.log.log(JSON.stringify(result));
        return result;
      });
    } catch (err) {
      this.log.error(err);
      return null;
    }
  }

  /** Temporary suspensions end on their expiry date (spec 14: bans need a reason and optional expiry). */
  async endExpiredSuspensions(now = new Date()) {
    const suspended = await this.db.select({ id: users.id }).from(users).where(eq(users.status, 'suspended'));
    let reinstated = 0;
    for (const u of suspended) {
      const [latest] = await this.db
        .select({ action: moderationActions.action, expiresAt: moderationActions.expiresAt })
        .from(moderationActions)
        .where(and(eq(moderationActions.targetType, 'user'), eq(moderationActions.targetId, u.id)))
        .orderBy(desc(moderationActions.createdAt))
        .limit(1);
      if (latest?.action === 'suspension' && latest.expiresAt && latest.expiresAt <= now) {
        await this.db
          .update(users)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(users.id, u.id), eq(users.status, 'suspended')));
        await this.db
          .insert(auditLog)
          .values({ actorType: 'system', action: 'user.suspension_ended', targetType: 'user', targetId: u.id });
        reinstated++;
      }
    }
    return { reinstated };
  }
}
