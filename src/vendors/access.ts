import { and, arrayContains, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { branches, vendors, vendorStaff } from '../db/schema.js';

/** Staff permissions a venue owner can grant (spec 13.2). Owners always have all of them. */
export const STAFF_PERMISSIONS = [
  'view_bookings',
  'create_bookings',
  'confirm_payments',
  'edit_prices',
  'view_revenue',
  'manage_staff',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

// A blocked or suspended vendor still sees and runs existing bookings (spec 13.3).
const WORKING = ['approved', 'suspended', 'blocked'] as const;

/**
 * Vendors and branches a user can act for with this permission: vendors they own, or staff rows that grant it,
 * limited to the staff member's branches (an empty list means every branch). Checked on every request, so
 * removing staff takes effect at once.
 */
export async function vendorAccess(db: Pick<Db, 'select'>, userId: string, permission: StaffPermission) {
  const owned = await db
    .select({ vendorId: vendors.id, businessName: vendors.businessName })
    .from(vendors)
    .where(and(eq(vendors.ownerUserId, userId), inArray(vendors.status, [...WORKING])));
  const staffed = await db
    .select({ vendorId: vendors.id, businessName: vendors.businessName, branchIds: vendorStaff.branchIds })
    .from(vendorStaff)
    .innerJoin(vendors, eq(vendors.id, vendorStaff.vendorId))
    .where(
      and(
        eq(vendorStaff.userId, userId),
        eq(vendorStaff.active, true),
        arrayContains(vendorStaff.permissions, [permission]),
        inArray(vendors.status, [...WORKING]),
      ),
    );
  const scopes = [...owned.map((o) => ({ ...o, branchIds: [] as string[] })), ...staffed];
  if (!scopes.length) return { vendors: [], branchIds: [] as string[] };
  const allBranches = await db
    .select({ id: branches.id, vendorId: branches.vendorId, name: branches.name, timezone: branches.timezone })
    .from(branches)
    .where(
      inArray(
        branches.vendorId,
        scopes.map((s) => s.vendorId),
      ),
    );
  const allowed = allBranches.filter((b) =>
    scopes.some((s) => s.vendorId === b.vendorId && (!s.branchIds.length || s.branchIds.includes(b.id))),
  );
  return {
    vendors: scopes.map((s) => ({
      id: s.vendorId,
      businessName: s.businessName,
      branches: allowed
        .filter((b) => b.vendorId === s.vendorId)
        .map((b) => ({ id: b.id, name: b.name, timezone: b.timezone })),
    })),
    branchIds: allowed.map((b) => b.id),
  };
}
