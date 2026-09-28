import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AdminAuthService, DEV_TOTP } from './admin/admin-auth.service.js';
import { AdminAuthController, AdminController } from './admin/admin.controller.js';
import { AdminGuard } from './admin/admin.guard.js';
import { AdminService } from './admin/admin.service.js';
import { validationPipe } from './api-error.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { DEV_OTP, FakeSmsSender, SMS } from './auth/sms.js';
import { BookingsController } from './bookings/bookings.controller.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { BookingsService } from './bookings/bookings.service.js';
import { loadEnv } from './config.js';
import { MatchesController } from './matches/matches.controller.js';
import { MatchesService } from './matches/matches.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { MeController } from './users/me.controller.js';
import { CalendarController } from './vendors/calendar.controller.js';
import { CalendarService } from './vendors/calendar.service.js';
import { StaffService } from './vendors/staff.service.js';
import { VendorsController } from './vendors/vendors.controller.js';
import { VendorsService } from './vendors/vendors.service.js';
import { ProfileService } from './users/profile.service.js';
import { DocumentCrypto } from './verification/document-crypto.js';
import { LocalDiskStorage, STORAGE } from './verification/storage.js';
import { VerificationService } from './verification/verification.service.js';
import { VenuesController } from './venues/venues.controller.js';
import { VenuesService } from './venues/venues.service.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DbModule],
  controllers: [
    HealthController,
    AuthController,
    MeController,
    VenuesController,
    BookingsController,
    PaymentsController,
    VendorsController,
    CalendarController,
    MatchesController,
    ChatController,
    AdminAuthController,
    AdminController,
  ],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    BookingsService,
    VenuesService,
    PaymentsService,
    VendorsService,
    CalendarService,
    MatchesService,
    ChatService,
    StaffService,
    AdminAuthService,
    AdminService,
    AdminGuard,
    { provide: DEV_TOTP, useFactory: () => loadEnv().DEV_TOTP_CODE },
    AuthService,
    AuthGuard,
    // SMS_PROVIDER only allows 'fake' until a provider is chosen; config refuses it in production.
    { provide: SMS, useClass: FakeSmsSender },
    { provide: DEV_OTP, useFactory: () => loadEnv().DEV_OTP_CODE },
    ProfileService,
    VerificationService,
    { provide: DocumentCrypto, useFactory: () => new DocumentCrypto(loadEnv().DOCUMENT_KEY) },
    // STORAGE_DRIVER only allows 'local' until S3 is added; config refuses it in production.
    { provide: STORAGE, useFactory: () => new LocalDiskStorage(loadEnv().STORAGE_DIR) },
  ],
})
export class AppModule {}
