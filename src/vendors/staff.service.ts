import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { normalisePhone } from '../auth/phone.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { branches, users, vendorStaff } from '../db/schema.js';
import { type StaffPermission, vendorAccess } from './access.js';
import { VendorError } from './vendors.service.js';

/** Owners (and staff with manage_staff) add and remove staff with limited permissions (Foundation 5.4). */
@Injectable()
export class StaffService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(userId: string, vendorId: string) {
    await this.assertManager(userId, vendorId);
    return this.db
      .select({
        userId: vendorStaff.userId,
        name: users.name,
        permissions: vendorStaff.permissions,
        branchIds: vendorStaff.branchIds,
        active: vendorStaff.active,
      })
      .from(vendorStaff)
      .innerJoin(users, eq(users.id, vendorStaff.userId))
      .where(eq(vendorStaff.vendorId, vendorId))
      .orderBy(asc(users.name));
  }

  /** The staff member needs a SportsLink account; the owner adds them by the phone number they signed up with. */
  async add(
    userId: string,
    vendorId: string,
    input: { phone: string; permissions: StaffPermission[]; branchIds: string[] },
  ) {
    await this.assertManager(userId, vendorId);
    const parsed = normalisePhone(input.phone);
    if (!parsed) throw new VendorError('NOT_FOUND', 'Enter a Pakistani mobile number, for example 0300 1234567.');
    const [staff] = await this.db.select({ id: users.id }).from(users).where(eq(users.phone, parsed.phone));
    if (!staff)
      throw new VendorError('NOT_FOUND', 'No SportsLink account uses this number. Ask them to sign up first.');
    if (input.branchIds.length) {
      const own = await this.db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.vendorId, vendorId), inArray(branches.id, input.branchIds)));
      if (own.length !== new Set(input.branchIds).size) throw new VendorError('NOT_FOUND', 'Venue not found.');
    }
    const values = {
      permissions: [...new Set(input.permissions)],
      branchIds: input.branchIds,
      active: true,
      updatedAt: new Date(),
    };
    await this.db
      .insert(vendorStaff)
      .values({ vendorId, userId: staff.id, ...values })
      .onConflictDoUpdate({ target: [vendorStaff.vendorId, vendorStaff.userId], set: values });
    return { userId: staff.id };
  }

  /** Takes effect on the staff member's next request: access is checked every time (spec 13.3). */
  async remove(userId: string, vendorId: string, staffUserId: string) {
    await this.assertManager(userId, vendorId);
    await this.db
      .update(vendorStaff)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(vendorStaff.vendorId, vendorId), eq(vendorStaff.userId, staffUserId)));
    return { userId: staffUserId };
  }

  private async assertManager(userId: string, vendorId: string) {
    const { vendors } = await vendorAccess(this.db, userId, 'manage_staff');
    if (!vendors.some((v) => v.id === vendorId)) throw new VendorError('NOT_VENDOR', 'You cannot manage staff here.');
  }
}
