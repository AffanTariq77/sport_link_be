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
import { AdminBillingController, VendorBillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { BookingsController } from './bookings/bookings.controller.js';
import { JobsService } from './jobs/jobs.service.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { BookingsService } from './bookings/bookings.service.js';
import { loadEnv } from './config.js';
import { MatchesController } from './matches/matches.controller.js';
import { MatchesService } from './matches/matches.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { ExpoPushSender, LogPushSender, PUSH } from './notifications/push.js';
import { PaymentsController } from './payments/payments.controller.js';
import { RefundsController } from './refunds/refunds.controller.js';
import { RefundsService } from './refunds/refunds.service.js';
import { PaymentsService } from './payments/payments.service.js';
import { GuardianController } from './users/guardian.controller.js';
import { GuardianService } from './users/guardian.service.js';
import { MeController } from './users/me.controller.js';
import { CalendarController } from './vendors/calendar.controller.js';
import { CalendarService } from './vendors/calendar.service.js';
import { StaffService } from './vendors/staff.service.js';
import { PhotosService } from './vendors/photos.service.js';
import { PlayersService } from './ratings/players.service.js';
import { AdminResultsController, RatingsController } from './ratings/ratings.controller.js';
import { ResultsService } from './ratings/results.service.js';
import { AdminTeamsController, TeamsController } from './teams/teams.controller.js';
import { TeamsService } from './teams/teams.service.js';
import { FindController } from './find/find.controller.js';
import { FindService } from './find/find.service.js';
import { AdminTournamentsController, TournamentsController } from './tournaments/tournaments.controller.js';
import { TournamentsService } from './tournaments/tournaments.service.js';
import { AnalyticsController } from './analytics/analytics.controller.js';
import { AnalyticsService } from './analytics/analytics.service.js';
import { AccountController } from './users/account.controller.js';
import { AccountService } from './users/account.service.js';
import { VendorsController, VenuePhotosController } from './vendors/vendors.controller.js';
import { VendorsService } from './vendors/vendors.service.js';
import { ProfileService } from './users/profile.service.js';
import { DocumentCrypto } from './verification/document-crypto.js';
import { LocalDiskStorage, S3Storage, STORAGE } from './verification/storage.js';
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
    GuardianController,
    VenuesController,
    BookingsController,
    PaymentsController,
    VendorsController,
    VenuePhotosController,
    RatingsController,
    AdminResultsController,
    TeamsController,
    AdminTeamsController,
    FindController,
    TournamentsController,
    AdminTournamentsController,
    AnalyticsController,
    AccountController,
    CalendarController,
    MatchesController,
    ChatController,
    NotificationsController,
    RefundsController,
    VendorBillingController,
    AdminBillingController,
    AdminAuthController,
    AdminController,
  ],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    BookingsService,
    VenuesService,
    PaymentsService,
    VendorsService,
    PhotosService,
    ResultsService,
    PlayersService,
    TeamsService,
    FindService,
    TournamentsService,
    AnalyticsService,
    AccountService,
    CalendarService,
    MatchesService,
    ChatService,
    NotificationsService,
    {
      provide: PUSH,
      useFactory: () => {
        const env = loadEnv();
        return env.PUSH_PROVIDER === 'expo' ? new ExpoPushSender(env.EXPO_ACCESS_TOKEN) : new LogPushSender();
      },
    },
    RefundsService,
    BillingService,
    JobsService,
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
    GuardianService,
    VerificationService,
    { provide: DocumentCrypto, useFactory: () => new DocumentCrypto(loadEnv().DOCUMENT_KEY) },
    // Config refuses the local folder in production.
    {
      provide: STORAGE,
      useFactory: () => {
        const env = loadEnv();
        return env.STORAGE_DRIVER === 's3'
          ? new S3Storage(env.S3_BUCKET!, { region: env.S3_REGION, endpoint: env.S3_ENDPOINT })
          : new LocalDiskStorage(env.STORAGE_DIR);
      },
    },
  ],
})
export class AppModule {}
