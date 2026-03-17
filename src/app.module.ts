/** @author Shuja naqvi */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getConnectionOptions } from 'typeorm';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { HealthModule } from './health/health.module';
import { ItemModule } from './item/item.module';
import { QueryLogger } from './logger/query-logger';
import { loggerOptions } from './logger/logger';
import { WinstonModule } from 'nest-winston';

@Module({
  imports: [
    CoreModule,
    TypeOrmModule.forRootAsync({
      useFactory: async () =>
        Object.assign(await getConnectionOptions(), {
          logger: new QueryLogger(),
        }),
    }),
    WinstonModule.forRoot(loggerOptions),
    AuthModule,
    HealthModule,
    ItemModule,
  ],
})
export class AppModule {}
