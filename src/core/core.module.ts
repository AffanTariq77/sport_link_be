/** @author Shuja naqvi */
import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

@Global()
@Module({
  imports: [HttpModule.register({ timeout: 5000 }), ScheduleModule.forRoot()],
  exports: [HttpModule, ScheduleModule],
})
export class CoreModule {}
