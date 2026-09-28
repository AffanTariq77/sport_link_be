import { BadRequestException, HttpException, StandardSchemaValidationPipe } from '@nestjs/common';
import { z } from 'zod';

/** Shape of every error body the API returns. `message` is safe to show to users. */
export const ApiError = z.object({ code: z.string(), message: z.string() }).meta({ id: 'ApiError' });

/** Validates every `@Body({ schema })` and friends, with errors in the ApiError shape. */
export const validationPipe = new StandardSchemaValidationPipe({
  exceptionFactory: (issues) =>
    new BadRequestException({ code: 'INVALID_INPUT', message: issues[0]?.message ?? 'Invalid input.' }),
});

/** Runs a service call, turning its domain error (an Error with a `code`) into an HTTP error with that status. */
export async function withErrors<T, C extends string>(
  ErrorClass: new (...args: never[]) => Error & { code: C },
  status: Record<C, number>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ErrorClass) throw new HttpException({ code: e.code, message: e.message }, status[e.code]);
    throw e;
  }
}
