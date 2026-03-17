/** @author Shuja naqvi */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { first, isArray } from 'lodash';
import baseLogger from '../logger/logger';

const logger = baseLogger.child({ type: 'exception', source: 'GlobalExceptionFilter' });

interface IErrorResponse {
  statusCode: number;
  timestamp: string;
  message: string;
  error?: string;
  messages?: string[];
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: Error, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const type = exception instanceof HttpException ? 'APIError' : 'exception';

    logger.child({ type }).error({
      requestId: response.getHeader('X-Request-ID'),
      exception: exception.message,
      stack: exception.stack,
    });

    const error = this.formatError(exception);
    response.status(error.statusCode).json(error);
  }

  private formatError(exception: Error): IErrorResponse {
    const timestamp = new Date().toISOString();
    if (!(exception instanceof HttpException)) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        timestamp,
        message: exception.message || 'Unknown Error',
      };
    }

    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    const baseError = { statusCode, timestamp };

    if (typeof response === 'string') {
      return { ...baseError, message: response };
    }

    const { error, message } = response as { error: string; message: string | string[] };

    if (isArray(message)) {
      return {
        ...baseError,
        error,
        message: first(message) ?? 'Validation failed',
        ...(message.length > 1 && { messages: message }),
      };
    }

    return {
      ...baseError,
      error,
      message: message ?? 'Unknown error',
    };
  }
}
