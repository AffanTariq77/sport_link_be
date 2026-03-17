/** @author Shuja naqvi */
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './controller/health.controller';

@Module({
  controllers: [HealthController],
  imports: [TerminusModule],
})
export class HealthModule {}
