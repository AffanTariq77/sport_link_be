import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, arrayContains, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { devices, notifications, vendors, vendorStaff } from '../db/schema.js';
import type { StaffPermission } from '../vendors/access.js';
import { PUSH, type PushSender } from './push.js';

export interface NotificationInput {
  kind:
    | 'booking'
    | 'payment'
    | 'match'
    | 'chat'
    | 'refund'
    | 'verification'
    | 'vendor'
    | 'billing'
    | 'guardian'
    | 'moderation';
  title: string;
  body: string;
  link?: string;
  refId?: string;
  /** Skip if the person already has an unread notification of this kind for the same refId (chat). */
  collapse?: boolean;
}

/**
 * One notification service (spec 15): stores every notification (in-app list and delivery log) and pushes it to
 * the person's devices. Sending never fails the action that caused it.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PUSH) private readonly push: PushSender,
  ) {}

  async notify(userIds: string | null | undefined | (string | null | undefined)[], n: NotificationInput) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter((x): x is string => !!x))];
    if (!ids.length) return;
    try {
      let targets = ids;
      if (n.collapse && n.refId) {
        const unread = await this.db
          .select({ userId: notifications.userId })
          .from(notifications)
          .where(
            and(
              inArray(notifications.userId, ids),
              eq(notifications.kind, n.kind),
              eq(notifications.refId, n.refId),
              isNull(notifications.readAt),
            ),
          );
        const skip = new Set(unread.map((u) => u.userId));
        targets = ids.filter((id) => !skip.has(id));
      }
      if (!targets.length) return;
      const rows = await this.db
        .insert(notifications)
        .values(
          targets.map((userId) => ({
            userId,
            kind: n.kind,
            title: n.title,
            body: n.body,
            link: n.link ?? null,
            refId: n.refId ?? null,
          })),
        )
        .returning({ id: notifications.id, userId: notifications.userId });
      const tokens = await this.db
        .select({ userId: devices.userId, token: devices.pushToken })
        .from(devices)
        .where(and(inArray(devices.userId, targets), isNotNull(devices.pushToken)));
      if (tokens.length) {
        await this.push.send(
          tokens.map((t) => ({
            to: t.token!,
            title: n.title,
            body: n.body,
            data: n.link ? { link: n.link } : undefined,
          })),
        );
        await this.db
          .update(notifications)
          .set({ pushedAt: new Date() })
          .where(
            inArray(
              notifications.id,
              rows.filter((r) => tokens.some((t) => t.userId === r.userId)).map((r) => r.id),
            ),
          );
      }
    } catch (err) {
      this.log.error(err);
    }
  }

  /** The vendor owner plus active staff with this permission (and access to the branch, when given). */
  async vendorRecipients(vendorId: string, permission: StaffPermission | 'owner', branchId?: string) {
    const [owner] = await this.db.select({ id: vendors.ownerUserId }).from(vendors).where(eq(vendors.id, vendorId));
    if (permission === 'owner') return owner ? [owner.id] : [];
    const staff = await this.db
      .select({ id: vendorStaff.userId })
      .from(vendorStaff)
      .where(
        and(
          eq(vendorStaff.vendorId, vendorId),
          eq(vendorStaff.active, true),
          arrayContains(vendorStaff.permissions, [permission]),
          branchId
            ? sql`(cardinality(${vendorStaff.branchIds}) = 0 or ${branchId} = any(${vendorStaff.branchIds}))`
            : undefined,
        ),
      );
    return [owner?.id, ...staff.map((s) => s.id)].filter((x): x is string => !!x);
  }

  async list(userId: string) {
    const rows = await this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    const [unread] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return { unread: Number(unread!.n), items: rows };
  }

  async markRead(userId: string, ids?: string[], now = new Date()) {
    await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          ids?.length ? inArray(notifications.id, ids) : undefined,
        ),
      );
    return { ok: true };
  }

  /** Saves or refreshes the device's push token (spec 5: devices are also recorded for bans later). */
  async registerDevice(
    userId: string,
    input: { fingerprint: string; platform: 'ios' | 'android' | 'web'; pushToken?: string },
  ) {
    await this.db
      .insert(devices)
      .values({
        userId,
        deviceFingerprint: input.fingerprint,
        platform: input.platform,
        pushToken: input.pushToken ?? null,
      })
      .onConflictDoUpdate({
        target: [devices.userId, devices.deviceFingerprint],
        set: { pushToken: input.pushToken ?? null, platform: input.platform, lastSeenAt: new Date() },
      });
    return { ok: true };
  }
}
