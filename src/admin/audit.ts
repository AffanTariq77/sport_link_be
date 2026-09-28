import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/** Every admin action (spec 14). The table is append-only, enforced by a trigger. */
export function audit(
  db: Pick<Db, 'insert'>,
  entry: {
    actorId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
) {
  return db.insert(auditLog).values({ actorType: 'admin', ...entry, ip: entry.ip ?? null });
}
