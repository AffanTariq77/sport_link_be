import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { validationPipe } from './api-error.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { DEV_OTP, FakeSmsSender, SMS } from './auth/sms.js';
import { BookingsService } from './bookings/bookings.service.js';
import { loadEnv } from './config.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DbModule],
  controllers: [HealthController, AuthController],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    BookingsService,
    AuthService,
    AuthGuard,
    // SMS_PROVIDER only allows 'fake' until a provider is chosen; config refuses it in production.
    { provide: SMS, useClass: FakeSmsSender },
    { provide: DEV_OTP, useFactory: () => loadEnv().DEV_OTP_CODE },
  ],
})
export class AppModule {}
