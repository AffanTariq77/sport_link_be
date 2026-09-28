import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import { loadEnv } from '../config.js';
import { createDb } from './client.js';

export const DB = Symbol('DB');
const POOL = Symbol('POOL');

@Global()
@Module({
  providers: [
    { provide: 'DB_BUNDLE', useFactory: () => createDb(loadEnv().DATABASE_URL) },
    { provide: DB, inject: ['DB_BUNDLE'], useFactory: (b: ReturnType<typeof createDb>) => b.db },
    { provide: POOL, inject: ['DB_BUNDLE'], useFactory: (b: ReturnType<typeof createDb>) => b.pool },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
