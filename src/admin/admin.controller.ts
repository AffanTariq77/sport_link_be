import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiDefaultResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError, withErrors } from '../api-error.js';
import {
  billingModel,
  docType,
  listingStatus,
  paymentMethod,
  reportStatus,
  reviewStatus,
  userStatus,
  vendorStatus,
} from '../db/schema.js';
import { AdminAuthError, AdminAuthService } from './admin-auth.service.js';
import { AdminGuard, type AdminRequest, Permission } from './admin.guard.js';
import { AdminError, AdminService } from './admin.service.js';

const AUTH_STATUS: Record<AdminAuthError['code'], number> = { INVALID_LOGIN: 401, LOCKED: 429 };
const STATUS: Record<AdminError['code'], number> = {
  NOT_FOUND: 404,
  NOT_PENDING: 409,
  OWNER_NOT_VERIFIED: 409,
  INVALID_BILLING: 400,
};
const run = <T>(fn: () => Promise<T>) => withErrors(AdminError, STATUS, fn);
const actor = (req: AdminRequest) => ({ adminId: req.admin.admin.id, ip: req.ip ?? null });

const Id = z.uuid('Not found.');
const Reason = z.string().trim().min(3, 'Give a reason.').max(500);
const LoginBody = z
  .object({ email: z.string().max(200), password: z.string().max(200), code: z.string().max(10) })
  .meta({ id: 'AdminLogin' });
const Admin = z.object({ id: z.uuid(), name: z.string(), email: z.string(), role: z.string() });
const LoginResult = z
  .object({ token: z.string(), expiresAt: z.iso.datetime(), admin: Admin })
  .meta({ id: 'AdminSession' });
const Me = z.object({ admin: Admin, permissions: z.array(z.string()) }).meta({ id: 'AdminMe' });
const Overview = z
  .object({ verificationsPending: z.int(), venuesPending: z.int(), accountsPending: z.int(), reportsOpen: z.int() })
  .meta({ id: 'AdminOverview' });
const Done = z.object({ id: z.uuid(), status: z.string() }).meta({ id: 'AdminDone' });
const Status = <T extends readonly [string, ...string[]]>(values: T) =>
  z.object({ status: z.enum(values).default(values[0]) });

const VerificationRow = z.object({
  id: z.uuid(),
  docType: z.enum(docType.enumValues),
  status: z.enum(reviewStatus.enumValues),
  submittedAt: z.iso.datetime(),
  user: z.object({
    id: z.uuid(),
    name: z.string().nullable(),
    dob: z.string().nullable(),
    isMinor: z.boolean(),
    city: z.string().nullable(),
  }),
});
const VerificationDetail = z
  .object({
    id: z.uuid(),
    docType: z.enum(docType.enumValues),
    status: z.enum(reviewStatus.enumValues),
    docNumber: z.string(),
    rejectionReason: z.string().nullable(),
    user: z.object({ id: z.uuid(), name: z.string().nullable(), dob: z.string().nullable(), isMinor: z.boolean() }),
  })
  .meta({ id: 'AdminVerification' });
const BranchRow = z
  .object({
    id: z.uuid(),
    name: z.string(),
    address: z.string(),
    city: z.string(),
    status: z.enum(listingStatus.enumValues),
    updatedAt: z.iso.datetime(),
    vendor: z.object({
      id: z.uuid(),
      businessName: z.string(),
      status: z.enum(vendorStatus.enumValues),
      billingModel: z.enum(billingModel.enumValues),
      commissionBps: z.int().nullable(),
      monthlyFee: z.int().nullable(),
    }),
    owner: z.object({ id: z.uuid(), name: z.string().nullable() }),
    courtCount: z.int(),
    ownerVerification: z.string(),
    visit: z
      .object({
        id: z.uuid(),
        scheduledAt: z.iso.datetime().nullable(),
        result: z.string(),
        notes: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'AdminBranch' });
const AccountRow = z
  .object({
    id: z.uuid(),
    method: z.enum(paymentMethod.enumValues),
    accountTitle: z.string(),
    bankName: z.string().nullable(),
    accountNumber: z.string().nullable(),
    status: z.enum(reviewStatus.enumValues),
    replacesAccountId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    vendor: z.object({ id: z.uuid(), businessName: z.string() }),
    ownerName: z.string().nullable(),
  })
  .meta({ id: 'AdminPaymentAccount' });
const UserRow = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    phone: z.string(),
    city: z.string().nullable(),
    status: z.enum(userStatus.enumValues),
    isMinor: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminUser' });
const ReportRow = z
  .object({
    id: z.uuid(),
    targetType: z.string(),
    targetId: z.uuid(),
    reason: z.string(),
    details: z.string().nullable(),
    evidence: z.unknown(),
    involvesMinor: z.boolean(),
    status: z.enum(reportStatus.enumValues),
    createdAt: z.iso.datetime(),
    reporterName: z.string().nullable(),
  })
  .meta({ id: 'AdminReport' });
const AuditRow = z
  .object({
    id: z.uuid(),
    actorType: z.string(),
    actorId: z.uuid().nullable(),
    action: z.string(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    before: z.unknown(),
    after: z.unknown(),
    ip: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditEntry' });

@ApiTags('Admin')
@Controller('admin')
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: LoginResult })
  login(@Req() req: { ip?: string }, @Body({ schema: LoginBody }) body: z.infer<typeof LoginBody>) {
    return withErrors(AdminAuthError, AUTH_STATUS, () => this.auth.login({ ...body, ip: req.ip }));
  }

  @Post('auth/logout')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  async logout(@Req() req: AdminRequest) {
    await this.auth.logout(req.admin.sessionId);
  }

  @Get('me')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ standardSchema: Me })
  me(@Req() req: AdminRequest) {
    return { admin: req.admin.admin, permissions: req.admin.permissions };
  }
}

@ApiTags('Admin')
@Controller('admin')
@UseGuards(AdminGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('overview')
  @Permission('analytics.view')
  @ApiOkResponse({ standardSchema: Overview })
  overview() {
    return this.admin.overview();
  }

  @Get('verifications')
  @Permission('verification.review')
  @ApiOkResponse({ standardSchema: z.array(VerificationRow) })
  verifications(
    @Query({ schema: Status(reviewStatus.enumValues) }) q: { status: 'pending' | 'approved' | 'rejected' },
  ) {
    return this.admin.listVerifications(q.status);
  }

  @Get('verifications/:id')
  @Permission('verification.review')
  @ApiOkResponse({ standardSchema: VerificationDetail })
  verification(@Req() req: AdminRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.admin.verificationDetail(id, actor(req)));
  }

  @Get('verifications/:id/:side')
  @Permission('verification.review')
  @Header('Cache-Control', 'no-store')
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  async verificationImage(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('side', { schema: z.enum(['front', 'back']) }) side: 'front' | 'back',
  ) {
    const { image, contentType } = await run(() => this.admin.verificationImage(id, side, actor(req)));
    return new StreamableFile(image, { type: contentType, disposition: 'inline' });
  }

  @Post('verifications/:id/approve')
  @HttpCode(200)
  @Permission('verification.review')
  @ApiOkResponse({ standardSchema: Done })
  approveVerification(@Req() req: AdminRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.admin.decideVerification(id, { approve: true }, actor(req)));
  }

  @Post('verifications/:id/reject')
  @HttpCode(200)
  @Permission('verification.review')
  @ApiOkResponse({ standardSchema: Done })
  rejectVerification(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ reason: Reason }).meta({ id: 'RejectVerification' }) }) body: { reason: string },
  ) {
    return run(() => this.admin.decideVerification(id, { approve: false, reason: body.reason }, actor(req)));
  }

  @Get('branches')
  @Permission('venues.approve')
  @ApiOkResponse({ standardSchema: z.array(BranchRow) })
  branches(
    @Query({
      schema: Status(['pending_visit', ...listingStatus.enumValues.filter((s) => s !== 'pending_visit')] as const),
    })
    q: {
      status: (typeof listingStatus.enumValues)[number];
    },
  ) {
    return this.admin.listBranches(q.status);
  }

  @Post('branches/:id/visit/schedule')
  @HttpCode(200)
  @Permission('venues.approve')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  scheduleVisit(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ scheduledAt: z.iso.datetime({ offset: true }) }).meta({ id: 'ScheduleVisit' }) })
    body: { scheduledAt: string },
  ) {
    return run(() => this.admin.scheduleVisit(id, new Date(body.scheduledAt), actor(req)));
  }

  @Post('branches/:id/visit/result')
  @HttpCode(200)
  @Permission('venues.approve')
  @ApiOkResponse({ standardSchema: Done })
  visitResult(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({ schema: z.object({ passed: z.boolean(), notes: z.string().trim().max(2000) }).meta({ id: 'VisitResult' }) })
    body: { passed: boolean; notes: string },
  ) {
    return run(() => this.admin.recordVisit(id, body, actor(req)));
  }

  @Post('branches/:id/status')
  @HttpCode(200)
  @Permission('venues.ban')
  @ApiOkResponse({ standardSchema: Done })
  branchStatus(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({ status: z.enum(['live', 'hidden', 'suspended', 'banned']), reason: Reason })
        .meta({ id: 'BranchStatus' }),
    })
    body: { status: 'live' | 'hidden' | 'suspended' | 'banned'; reason: string },
  ) {
    return run(() => this.admin.setBranchStatus(id, body.status, body.reason, actor(req)));
  }

  @Put('vendors/:id/billing')
  @Permission('billing.manage')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  billing(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({
          billingModel: z.enum(billingModel.enumValues),
          commissionBps: z.int().min(0).max(10_000).optional(),
          monthlyFee: z.int().min(0).optional().meta({ description: 'Minor units' }),
        })
        .meta({ id: 'VendorBilling' }),
    })
    body: { billingModel: 'percentage' | 'monthly'; commissionBps?: number; monthlyFee?: number },
  ) {
    return run(() => this.admin.setBilling(id, body, actor(req)));
  }

  @Get('payment-accounts')
  @Permission('payment_accounts.approve')
  @ApiOkResponse({ standardSchema: z.array(AccountRow) })
  accounts(@Query({ schema: Status(reviewStatus.enumValues) }) q: { status: 'pending' | 'approved' | 'rejected' }) {
    return this.admin.listAccounts(q.status);
  }

  @Post('payment-accounts/:id/:decision')
  @HttpCode(200)
  @Permission('payment_accounts.approve')
  @ApiOkResponse({ standardSchema: Done })
  decideAccount(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Param('decision', { schema: z.enum(['approve', 'reject']) }) decision: 'approve' | 'reject',
  ) {
    return run(() => this.admin.decideAccount(id, decision === 'approve', actor(req)));
  }

  @Get('users')
  @Permission('users.ban')
  @ApiOkResponse({ standardSchema: z.array(UserRow) })
  users(
    @Query({ schema: z.object({ q: z.string().trim().min(2, 'Type at least 2 characters.').max(80) }) })
    q: {
      q: string;
    },
  ) {
    return this.admin.searchUsers(q.q);
  }

  @Post('users/:id/moderate')
  @HttpCode(200)
  @Permission('users.ban')
  @ApiOkResponse({ standardSchema: Done })
  moderate(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z
        .object({
          action: z.enum(['warning', 'suspension', 'ban', 'reinstate']),
          reason: Reason,
          days: z.int().min(1).max(365).optional(),
        })
        .meta({ id: 'ModerateUser' }),
    })
    body: { action: 'warning' | 'suspension' | 'ban' | 'reinstate'; reason: string; days?: number },
  ) {
    return run(() => this.admin.moderateUser(id, body, actor(req)));
  }

  @Get('reports')
  @Permission('reports.review')
  @ApiOkResponse({ standardSchema: z.array(ReportRow) })
  reports() {
    return this.admin.listReports(['open', 'in_review']);
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  @Permission('reports.review')
  @ApiOkResponse({ standardSchema: Done })
  resolve(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z.object({ status: z.enum(['actioned', 'dismissed']), note: Reason }).meta({ id: 'ResolveReport' }),
    })
    body: { status: 'actioned' | 'dismissed'; note: string },
  ) {
    return run(() => this.admin.resolveReport(id, body, actor(req)));
  }

  @Get('audit')
  @Permission('audit.view')
  @ApiOkResponse({ standardSchema: z.array(AuditRow) })
  audit() {
    return this.admin.listAudit(200);
  }
}
