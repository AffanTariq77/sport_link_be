import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { Db } from '../db/client.js';
import {
  auditLog,
  billingModel,
  branches,
  courts,
  listingStatus,
  moderationActions,
  paymentAccounts,
  reports,
  reportStatus,
  sessions,
  siteVisits,
  users,
  vendors,
  verifications,
} from '../db/schema.js';
import { DocumentCrypto } from '../verification/document-crypto.js';
import { STORAGE, type FileStorage } from '../verification/storage.js';
import { audit } from './audit.js';

export class AdminError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_PENDING' | 'OWNER_NOT_VERIFIED' | 'INVALID_BILLING',
    message: string,
  ) {
    super(message);
  }
}

type Actor = { adminId: string; ip?: string | null };
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Detects the stored image format for the Content-Type header when an admin views a document.
const imageType = (b: Buffer) =>
  b[0] === 0xff
    ? 'image/jpeg'
    : b[0] === 0x89
      ? 'image/png'
      : b.subarray(8, 12).toString('latin1') === 'WEBP'
        ? 'image/webp'
        : 'application/octet-stream';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: FileStorage,
    @Inject(DocumentCrypto) private readonly crypto: DocumentCrypto,
    @Optional() @Inject(NotificationsService) private readonly notes?: NotificationsService,
  ) {}

  /** Counts for the dashboard queues. */
  async overview() {
    const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const n = sql<number>`count(*)::int`;
    const [verificationsPending, venuesPending, accountsPending, reportsOpen] = await Promise.all([
      count(this.db.select({ n }).from(verifications).where(eq(verifications.status, 'pending'))),
      count(this.db.select({ n }).from(branches).where(eq(branches.status, 'pending_visit'))),
      count(this.db.select({ n }).from(paymentAccounts).where(eq(paymentAccounts.status, 'pending'))),
      count(
        this.db
          .select({ n })
          .from(reports)
          .where(inArray(reports.status, ['open', 'in_review'])),
      ),
    ]);
    return { verificationsPending, venuesPending, accountsPending, reportsOpen };
  }

  // ---------- Identity documents ----------

  listVerifications(status: 'pending' | 'approved' | 'rejected') {
    return this.db
      .select({
        id: verifications.id,
        docType: verifications.docType,
        status: verifications.status,
        submittedAt: verifications.createdAt,
        user: { id: users.id, name: users.name, dob: users.dob, isMinor: users.isMinor, city: users.city },
      })
      .from(verifications)
      .innerJoin(users, eq(users.id, verifications.userId))
      .where(eq(verifications.status, status))
      .orderBy(verifications.createdAt)
      .limit(200);
  }

  /** The document number is decrypted for review, and that view is itself audit-logged (spec 14). */
  async verificationDetail(id: string, actor: Actor) {
    const [v] = await this.db
      .select({ v: verifications, name: users.name, dob: users.dob, isMinor: users.isMinor })
      .from(verifications)
      .innerJoin(users, eq(users.id, verifications.userId))
      .where(eq(verifications.id, id));
    if (!v) throw new AdminError('NOT_FOUND', 'Verification not found.');
    await audit(this.db, {
      actorId: actor.adminId,
      action: 'verification.view_number',
      targetType: 'verification',
      targetId: id,
      ip: actor.ip,
    });
    return {
      id,
      docType: v.v.docType,
      status: v.v.status,
      docNumber: this.crypto.decryptNumber(v.v.docNumberEncrypted),
      rejectionReason: v.v.rejectionReason,
      user: { id: v.v.userId, name: v.name, dob: v.dob, isMinor: v.isMinor },
    };
  }

  /** One side of the document, decrypted. Every view is audit-logged (CLAUDE.md, spec 16). */
  async verificationImage(id: string, side: 'front' | 'back', actor: Actor) {
    const [v] = await this.db
      .select({ frontKey: verifications.frontKey, backKey: verifications.backKey })
      .from(verifications)
      .where(eq(verifications.id, id));
    if (!v) throw new AdminError('NOT_FOUND', 'Verification not found.');
    const image = this.crypto.decryptImage(await this.storage.get(side === 'front' ? v.frontKey : v.backKey));
    await audit(this.db, {
      actorId: actor.adminId,
      action: 'verification.view_image',
      targetType: 'verification',
      targetId: id,
      after: { side },
      ip: actor.ip,
    });
    return { image, contentType: imageType(image) };
  }

  async decideVerification(
    id: string,
    decision: { approve: boolean; reason?: string },
    actor: Actor,
    now = new Date(),
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(verifications).where(eq(verifications.id, id)).for('update');
      if (!v) throw new AdminError('NOT_FOUND', 'Verification not found.');
      if (v.status !== 'pending') throw new AdminError('NOT_PENDING', 'This verification was already decided.');
      const after = decision.approve
        ? { status: 'approved' as const, rejectionReason: null }
        : { status: 'rejected' as const, rejectionReason: decision.reason ?? null };
      await tx
        .update(verifications)
        .set({ ...after, reviewedBy: actor.adminId, reviewedAt: now, updatedAt: now })
        .where(eq(verifications.id, id));
      if (decision.approve) {
        await tx
          .update(users)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(users.id, v.userId), eq(users.status, 'pending_verification')));
      }
      await audit(tx, {
        actorId: actor.adminId,
        action: decision.approve ? 'verification.approve' : 'verification.reject',
        targetType: 'verification',
        targetId: id,
        before: { status: v.status },
        after,
        ip: actor.ip,
      });
      return { id, status: after.status };
    });
    const [v] = await this.db
      .select({ userId: verifications.userId })
      .from(verifications)
      .where(eq(verifications.id, id));
    await this.notes?.notify(v?.userId, {
      kind: 'verification',
      title: decision.approve ? 'ID verified' : 'ID not approved',
      body: decision.approve
        ? 'Your ID has been verified. You can now use everything in SportsLink.'
        : `${decision.reason ?? 'We could not approve your document.'} Please upload it again.`,
      link: '/onboarding/verify',
      refId: id,
    });
    return result;
  }

  // ---------- Venues and site visits ----------

  async listBranches(status: (typeof listingStatus.enumValues)[number]) {
    const rows = await this.db
      .select({
        id: branches.id,
        name: branches.name,
        address: branches.address,
        city: branches.city,
        status: branches.status,
        updatedAt: branches.updatedAt,
        vendor: {
          id: vendors.id,
          businessName: vendors.businessName,
          status: vendors.status,
          billingModel: vendors.billingModel,
          commissionBps: vendors.commissionBps,
          monthlyFee: vendors.monthlyFee,
        },
        owner: { id: users.id, name: users.name },
        courtCount: sql<number>`(select count(*)::int from ${courts} where ${courts.branchId} = ${branches.id} and ${courts.active})`,
      })
      .from(branches)
      .innerJoin(vendors, eq(vendors.id, branches.vendorId))
      .innerJoin(users, eq(users.id, vendors.ownerUserId))
      .where(eq(branches.status, status))
      .orderBy(branches.updatedAt)
      .limit(200);
    const ownerIds = [...new Set(rows.map((r) => r.owner.id))];
    const checks = ownerIds.length
      ? await this.db
          .select({ userId: verifications.userId, status: verifications.status })
          .from(verifications)
          .where(and(inArray(verifications.userId, ownerIds), ne(verifications.status, 'rejected')))
      : [];
    const visits = rows.length
      ? await this.db
          .select()
          .from(siteVisits)
          .where(
            inArray(
              siteVisits.branchId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(siteVisits.createdAt))
      : [];
    return rows.map((r) => ({
      ...r,
      ownerVerification: checks.find((c) => c.userId === r.owner.id)?.status ?? 'none',
      visit: visits.find((v) => v.branchId === r.id) ?? null,
    }));
  }

  async scheduleVisit(branchId: string, scheduledAt: Date, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const visit = await this.openVisit(tx, branchId);
      await tx
        .update(siteVisits)
        .set({ scheduledAt, visitorAdminId: actor.adminId, updatedAt: new Date() })
        .where(eq(siteVisits.id, visit.id));
      await audit(tx, {
        actorId: actor.adminId,
        action: 'site_visit.schedule',
        targetType: 'branch',
        targetId: branchId,
        before: { scheduledAt: visit.scheduledAt },
        after: { scheduledAt },
        ip: actor.ip,
      });
      return { id: visit.id };
    });
  }

  /**
   * Records the visit. Passing makes the venue live and approves the vendor (Foundation 5.1), but only once the
   * owner's CNIC is approved. Failing sends the venue back to draft with the notes.
   */
  async recordVisit(branchId: string, input: { passed: boolean; notes: string }, actor: Actor, now = new Date()) {
    const result = await this.db.transaction(async (tx) => {
      const [branch] = await tx
        .select({
          status: branches.status,
          vendorId: branches.vendorId,
          vendorStatus: vendors.status,
          ownerId: vendors.ownerUserId,
        })
        .from(branches)
        .innerJoin(vendors, eq(vendors.id, branches.vendorId))
        .where(eq(branches.id, branchId))
        .for('update', { of: [branches] });
      if (!branch) throw new AdminError('NOT_FOUND', 'Venue not found.');
      if (branch.status !== 'pending_visit')
        throw new AdminError('NOT_PENDING', 'This venue is not waiting for a visit.');
      if (input.passed) {
        const [approvedId] = await tx
          .select({ id: verifications.id })
          .from(verifications)
          .where(and(eq(verifications.userId, branch.ownerId), eq(verifications.status, 'approved')))
          .limit(1);
        if (!approvedId)
          throw new AdminError('OWNER_NOT_VERIFIED', "Approve the owner's CNIC before passing the visit.");
      }
      const visit = await this.openVisit(tx, branchId);
      await tx
        .update(siteVisits)
        .set({
          result: input.passed ? 'passed' : 'failed',
          notes: input.notes,
          visitorAdminId: actor.adminId,
          updatedAt: now,
        })
        .where(eq(siteVisits.id, visit.id));
      const status = input.passed ? ('live' as const) : ('draft' as const);
      await tx.update(branches).set({ status, updatedAt: now }).where(eq(branches.id, branchId));
      if (input.passed && ['applied', 'under_review'].includes(branch.vendorStatus)) {
        await tx.update(vendors).set({ status: 'approved', updatedAt: now }).where(eq(vendors.id, branch.vendorId));
      }
      await audit(tx, {
        actorId: actor.adminId,
        action: input.passed ? 'site_visit.pass' : 'site_visit.fail',
        targetType: 'branch',
        targetId: branchId,
        before: { status: branch.status, vendorStatus: branch.vendorStatus },
        after: { status, notes: input.notes },
        ip: actor.ip,
      });
      return { id: branchId, status };
    });
    await this.notifyVendorOfBranch(
      branchId,
      input.passed ? 'Your venue is live' : 'Site visit not passed',
      input.passed ? 'Players can now find and book your venue.' : `${input.notes} Fix this and submit again.`,
    );
    return result;
  }

  /** Suspend, ban, hide or restore a venue (spec 6 admin areas). */
  async setBranchStatus(
    branchId: string,
    status: 'live' | 'hidden' | 'suspended' | 'banned',
    reason: string,
    actor: Actor,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [b] = await tx.select({ status: branches.status }).from(branches).where(eq(branches.id, branchId));
      if (!b) throw new AdminError('NOT_FOUND', 'Venue not found.');
      await tx.update(branches).set({ status, updatedAt: new Date() }).where(eq(branches.id, branchId));
      await tx.insert(moderationActions).values({
        adminId: actor.adminId,
        targetType: 'branch',
        targetId: branchId,
        action: status === 'live' ? 'restore' : status,
        reason,
      });
      await audit(tx, {
        actorId: actor.adminId,
        action: 'branch.set_status',
        targetType: 'branch',
        targetId: branchId,
        before: b,
        after: { status, reason },
        ip: actor.ip,
      });
      return { id: branchId, status };
    });
    await this.notifyVendorOfBranch(
      branchId,
      status === 'live' ? 'Your venue is live again' : `Your venue is ${status}`,
      reason,
    );
    return result;
  }

  /** Commission or monthly plan per vendor (Foundation 7). */
  async setBilling(
    vendorId: string,
    input: { billingModel: (typeof billingModel.enumValues)[number]; commissionBps?: number; monthlyFee?: number },
    actor: Actor,
  ) {
    if (input.billingModel === 'percentage' && input.commissionBps === undefined) {
      throw new AdminError('INVALID_BILLING', 'Set the commission percentage.');
    }
    if (input.billingModel === 'monthly' && input.monthlyFee === undefined) {
      throw new AdminError('INVALID_BILLING', 'Set the monthly fee.');
    }
    return this.db.transaction(async (tx) => {
      const [v] = await tx
        .select({
          billingModel: vendors.billingModel,
          commissionBps: vendors.commissionBps,
          monthlyFee: vendors.monthlyFee,
        })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      if (!v) throw new AdminError('NOT_FOUND', 'Vendor not found.');
      const after = {
        billingModel: input.billingModel,
        commissionBps: input.billingModel === 'percentage' ? input.commissionBps! : null,
        monthlyFee: input.billingModel === 'monthly' ? input.monthlyFee! : null,
      };
      await tx
        .update(vendors)
        .set({ ...after, updatedAt: new Date() })
        .where(eq(vendors.id, vendorId));
      await audit(tx, {
        actorId: actor.adminId,
        action: 'vendor.set_billing',
        targetType: 'vendor',
        targetId: vendorId,
        before: v,
        after,
        ip: actor.ip,
      });
      return { id: vendorId };
    });
  }

  // ---------- Payment accounts ----------

  /** Account details shown in full so the title can be checked against the owner's CNIC name. */
  async listAccounts(status: 'pending' | 'approved' | 'rejected') {
    const rows = await this.db
      .select({
        id: paymentAccounts.id,
        method: paymentAccounts.method,
        accountTitle: paymentAccounts.accountTitle,
        bankName: paymentAccounts.bankName,
        accountNumberEncrypted: paymentAccounts.accountNumberEncrypted,
        status: paymentAccounts.status,
        replacesAccountId: paymentAccounts.replacesAccountId,
        createdAt: paymentAccounts.createdAt,
        vendor: { id: vendors.id, businessName: vendors.businessName },
        ownerName: users.name,
      })
      .from(paymentAccounts)
      .innerJoin(vendors, eq(vendors.id, paymentAccounts.vendorId))
      .innerJoin(users, eq(users.id, vendors.ownerUserId))
      .where(eq(paymentAccounts.status, status))
      .orderBy(paymentAccounts.createdAt)
      .limit(200);
    return rows.map(({ accountNumberEncrypted, ...a }) => ({
      ...a,
      accountNumber: accountNumberEncrypted ? this.crypto.decryptAccount(accountNumberEncrypted) : null,
    }));
  }

  /** Approving a replacement retires the account it replaces; until then the old one stays in use. */
  async decideAccount(id: string, approve: boolean, actor: Actor, now = new Date()) {
    const result = await this.db.transaction(async (tx) => {
      const [a] = await tx.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).for('update');
      if (!a) throw new AdminError('NOT_FOUND', 'Account not found.');
      if (a.status !== 'pending') throw new AdminError('NOT_PENDING', 'This account was already decided.');
      const status = approve ? ('approved' as const) : ('rejected' as const);
      await tx
        .update(paymentAccounts)
        .set({ status, approvedBy: actor.adminId, approvedAt: approve ? now : null, updatedAt: now })
        .where(eq(paymentAccounts.id, id));
      if (approve && a.replacesAccountId) {
        await tx
          .update(paymentAccounts)
          .set({ status: 'rejected', updatedAt: now }) // retired: replaced by the account just approved
          .where(and(eq(paymentAccounts.id, a.replacesAccountId), eq(paymentAccounts.vendorId, a.vendorId)));
      }
      await audit(tx, {
        actorId: actor.adminId,
        action: approve ? 'payment_account.approve' : 'payment_account.reject',
        targetType: 'payment_account',
        targetId: id,
        before: { status: a.status },
        after: { status, replaced: approve ? a.replacesAccountId : null },
        ip: actor.ip,
      });
      return { id, status };
    });
    const [a] = await this.db
      .select({ vendorId: paymentAccounts.vendorId })
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, id));
    if (a && this.notes)
      await this.notes.notify(await this.notes.vendorRecipients(a.vendorId, 'owner'), {
        kind: 'vendor',
        title: approve ? 'Payment account approved' : 'Payment account rejected',
        body: approve ? 'Players can now pay you with this account.' : 'Check the details and add the account again.',
        link: '/vendor',
        refId: id,
      });
    return result;
  }

  // ---------- Users and moderation ----------

  /** Search by name or phone. Admins may see phone numbers; player-facing endpoints never return them. */
  searchUsers(q: string) {
    const term = `%${q.replace(/[%_]/g, '')}%`;
    return this.db
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        city: users.city,
        status: users.status,
        isMinor: users.isMinor,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(or(ilike(users.name, term), ilike(users.phone, term.replace(/\s/g, ''))))
      .orderBy(desc(users.createdAt))
      .limit(50);
  }

  /** Warning, suspension or ban with a reason (spec 14). Suspensions and bans end every session at once. */
  async moderateUser(
    userId: string,
    input: { action: 'warning' | 'suspension' | 'ban' | 'reinstate'; reason: string; days?: number },
    actor: Actor,
    now = new Date(),
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).for('update');
      if (!u) throw new AdminError('NOT_FOUND', 'User not found.');
      const status =
        input.action === 'ban'
          ? 'banned'
          : input.action === 'suspension'
            ? 'suspended'
            : input.action === 'reinstate'
              ? 'active'
              : u.status;
      if (status !== u.status) await tx.update(users).set({ status, updatedAt: now }).where(eq(users.id, userId));
      if (input.action === 'ban' || input.action === 'suspension') {
        await tx
          .update(sessions)
          .set({ revokedAt: now, updatedAt: now })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      }
      await tx.insert(moderationActions).values({
        adminId: actor.adminId,
        targetType: 'user',
        targetId: userId,
        action: input.action,
        reason: input.reason,
        expiresAt:
          input.action === 'suspension' && input.days ? new Date(now.getTime() + input.days * 86_400_000) : null,
      });
      await audit(tx, {
        actorId: actor.adminId,
        action: `user.${input.action}`,
        targetType: 'user',
        targetId: userId,
        before: { status: u.status },
        after: { status, reason: input.reason, days: input.days ?? null },
        ip: actor.ip,
      });
      return { id: userId, status };
    });
    const words = {
      warning: 'You have received a warning',
      suspension: 'Your account is suspended',
      ban: 'Your account is banned',
      reinstate: 'Your account is active again',
    };
    await this.notes?.notify(userId, {
      kind: 'moderation',
      title: words[input.action],
      body: input.reason,
      refId: userId,
    });
    return result;
  }

  // ---------- Reports and disputes ----------

  listReports(status: (typeof reportStatus.enumValues)[number][]) {
    return (
      this.db
        .select({
          id: reports.id,
          targetType: reports.targetType,
          targetId: reports.targetId,
          reason: reports.reason,
          details: reports.details,
          evidence: reports.evidence,
          involvesMinor: reports.involvesMinor,
          status: reports.status,
          createdAt: reports.createdAt,
          reporterName: users.name,
        })
        .from(reports)
        .leftJoin(users, eq(users.id, reports.reporterId)) // system reports have no reporter
        .where(inArray(reports.status, status))
        // Reports involving minors go to the top of the queue (Foundation 10.2).
        .orderBy(desc(reports.involvesMinor), reports.createdAt)
        .limit(200)
    );
  }

  async resolveReport(id: string, input: { status: 'actioned' | 'dismissed'; note: string }, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select({ status: reports.status }).from(reports).where(eq(reports.id, id));
      if (!r) throw new AdminError('NOT_FOUND', 'Report not found.');
      await tx.update(reports).set({ status: input.status, updatedAt: new Date() }).where(eq(reports.id, id));
      await audit(tx, {
        actorId: actor.adminId,
        action: 'report.resolve',
        targetType: 'report',
        targetId: id,
        before: r,
        after: input,
        ip: actor.ip,
      });
      return { id, status: input.status };
    });
  }

  listAudit(limit: number) {
    return this.db
      .select({
        id: auditLog.id,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        before: auditLog.before,
        after: auditLog.after,
        ip: auditLog.ip,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  private async notifyVendorOfBranch(branchId: string, title: string, body: string) {
    if (!this.notes) return;
    const [b] = await this.db
      .select({ vendorId: branches.vendorId, name: branches.name })
      .from(branches)
      .where(eq(branches.id, branchId));
    if (!b) return;
    await this.notes.notify(await this.notes.vendorRecipients(b.vendorId, 'owner', branchId), {
      kind: 'vendor',
      title: `${b.name}: ${title}`,
      body,
      link: '/vendor',
      refId: branchId,
    });
  }

  private async openVisit(tx: Tx, branchId: string) {
    const [visit] = await tx
      .select()
      .from(siteVisits)
      .where(and(eq(siteVisits.branchId, branchId), eq(siteVisits.result, 'scheduled')))
      .orderBy(desc(siteVisits.createdAt))
      .limit(1);
    if (visit) return visit;
    const [created] = await tx.insert(siteVisits).values({ branchId, requestedBy: 'admin' }).returning();
    return created!;
  }
}
