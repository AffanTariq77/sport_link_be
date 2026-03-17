/** @author Shuja naqvi */
import { Logger, QueryRunner } from 'typeorm';
import baseLogger from './logger';

const logger = baseLogger.child({ type: 'database' });

export class QueryLogger implements Logger {
  logQuery(query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
    logger.debug({
      query,
      parameters,
      queryData: queryRunner?.data,
      type: 'QUERY',
    });
  }

  logQueryError(
    error: string,
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    logger.error({
      query,
      parameters,
      queryData: queryRunner?.data,
      error,
      type: 'QUERY_ERROR',
    });
  }

  logQuerySlow(
    time: number,
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    logger.warn({
      query,
      queryTimeMs: time,
      parameters,
      queryData: queryRunner?.data,
      type: 'SLOW_QUERY',
    });
  }

  logSchemaBuild(message: string): void {
    logger.info({ message, type: 'SCHEMA_BUILD' });
  }

  logMigration(message: string): void {
    logger.info({ message, type: 'MIGRATION' });
  }

  log(level: 'log' | 'info' | 'warn', message: unknown, queryRunner?: QueryRunner): void {
    logger.log(level, {
      message,
      queryData: queryRunner?.data,
    });
  }
}
