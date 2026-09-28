import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiDefaultResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest, Permission } from '../admin/admin.guard.js';
import { ApiError, withErrors } from '../api-error.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { DB } from '../db/db.module.js';
import type { Db } from '../db/client.js';
import { billingModel, invoiceStatus, vendorStatus } from '../db/schema.js';
import { JobsService } from '../jobs/jobs.service.js';
import { getSetting } from '../settings.js';
import { vendorAccess } from '../vendors/access.js';
import { BillingError, BillingService } from './billing.service.js';

const STATUS: Record<BillingError['code'], number> = { NOT_FOUND: 404, NOT_OPEN: 409, INVALID_IMAGE: 400 };
const run = <T>(fn: () => Promise<T>) => withErrors(BillingError, STATUS, fn);
const Id = z.uuid('Not found.');

const Invoice = z
  .object({
    id: z.uuid(),
    periodStart: z.string(),
    periodEnd: z.string(),
    currency: z.string(),
    amount: z.int(),
    status: z.enum(invoiceStatus.enumValues),
    issuedAt: z.iso.datetime().nullable(),
    dueAt: z.iso.datetime().nullable(),
    paidAt: z.iso.datetime().nullable(),
    proofUploaded: z.boolean(),
    lines: z.array(z.object({ description: z.string(), amount: z.int() })),
  })
  .meta({ id: 'Invoice' });
const Running = z
  .object({
    currency: z.string(),
    periodStart: z.string(),
    bookings: z.int(),
    amount: z.int(),
    billingModel: z.enum(billingModel.enumValues),
    commissionBps: z.int().nullable(),
    monthlyFee: z.int().nullable(),
  })
  .meta({ id: 'BillingRunningTotal' });
const VendorBilling = z
  .object({ vendorId: z.uuid(), running: Running, invoices: z.array(Invoice), payTo: z.string() })
  .meta({ id: 'VendorBillingSummary' });
const AdminInvoice = z
  .object({
    id: z.uuid(),
    vendor: z.object({ id: z.uuid(), businessName: z.string(), status: z.enum(vendorStatus.enumValues) }),
    periodStart: z.string(),
    currency: z.string(),
    amount: z.int(),
    status: z.enum(invoiceStatus.enumValues),
    issuedAt: z.iso.datetime().nullable(),
    dueAt: z.iso.datetime().nullable(),
    proofUploaded: z.boolean(),
  })
  .meta({ id: 'AdminInvoice' });

@Controller('vendor/billing')
@UseGuards(AuthGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class VendorBillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Running total this month and past invoices (spec 13.2). Owners, or staff with view_revenue. */
  @Get()
  @ApiOkResponse({ standardSchema: z.array(VendorBilling) })
  async list(@Req() req: AuthedRequest) {
    const { vendors } = await vendorAccess(this.db, req.auth.user.id, 'view_revenue');
    return Promise.all(
      vendors.map(async (v) => ({
        vendorId: v.id,
        running: await this.billing.runningTotal(v.id),
        invoices: await this.billing.listForVendor(v.id),
        payTo: await getSetting(this.db, 'billing.pay_to'),
      })),
    );
  }

  @Post(':vendorId/invoices/:id/proof')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('proof', { limits: { fileSize: 6_000_000, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', required: ['proof'], properties: { proof: { type: 'string', format: 'binary' } } },
  })
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid() }) })
  async proof(
    @Req() req: AuthedRequest,
    @Param('vendorId', { schema: Id }) vendorId: string,
    @Param('id', { schema: Id }) id: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    const { vendors } = await vendorAccess(this.db, req.auth.user.id, 'view_revenue');
    return run(async () => {
      if (!vendors.some((v) => v.id === vendorId)) throw new BillingError('NOT_FOUND', 'Invoice not found.');
      if (!file) throw new BillingError('INVALID_IMAGE', 'Attach a photo or screenshot of your payment.');
      return this.billing.uploadProof(vendorId, id, file);
    });
  }
}

@Controller('admin/invoices')
@UseGuards(AdminGuard)
@ApiBearerAuth()
@ApiDefaultResponse({ description: 'Error', standardSchema: ApiError })
export class AdminBillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  @Get()
  @Permission('billing.view')
  @ApiOkResponse({ standardSchema: z.array(AdminInvoice) })
  list(
    @Query({ schema: z.object({ status: z.enum(['issued', 'overdue', 'paid', 'written_off']).default('issued') }) })
    q: {
      status: 'issued' | 'overdue' | 'paid' | 'written_off';
    },
  ) {
    return this.billing.listForAdmin(q.status);
  }

  /** Runs the scheduled jobs now (they also run every few minutes): completes bookings, issues invoices, ladder. */
  @Post('run')
  @HttpCode(200)
  @Permission('billing.manage')
  @ApiOkResponse({
    standardSchema: z
      .object({ completed: z.int(), issued: z.int(), ladder: z.int(), reinstated: z.int(), turned18: z.int() })
      .nullable(),
  })
  runNow() {
    return this.jobs.runAll();
  }

  @Get(':id/proof')
  @Permission('billing.view')
  @Header('Cache-Control', 'no-store')
  async proof(@Param('id', { schema: Id }) id: string) {
    return new StreamableFile(await run(() => this.billing.proof(id)), { type: 'image/jpeg', disposition: 'inline' });
  }

  @Post(':id/paid')
  @HttpCode(200)
  @Permission('billing.manage')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid(), status: z.enum(invoiceStatus.enumValues) }) })
  paid(@Req() req: AdminRequest, @Param('id', { schema: Id }) id: string) {
    return run(() => this.billing.settle(id, { paid: true }, { adminId: req.admin.admin.id, ip: req.ip ?? null }));
  }

  @Post(':id/write-off')
  @HttpCode(200)
  @Permission('billing.manage')
  @ApiOkResponse({ standardSchema: z.object({ id: z.uuid(), status: z.enum(invoiceStatus.enumValues) }) })
  writeOff(
    @Req() req: AdminRequest,
    @Param('id', { schema: Id }) id: string,
    @Body({
      schema: z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) }).meta({ id: 'WriteOff' }),
    })
    body: { reason: string },
  ) {
    return run(() =>
      this.billing.settle(
        id,
        { paid: false, reason: body.reason },
        { adminId: req.admin.admin.id, ip: req.ip ?? null },
      ),
    );
  }
}
