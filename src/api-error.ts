import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';
import { z } from 'zod';

/** Shape of every error body the API returns. `message` is safe to show to users. */
export const ApiError = z.object({ code: z.string(), message: z.string() }).meta({ id: 'ApiError' });

/** Validates every `@Body({ schema })` and friends, with errors in the ApiError shape. */
export const validationPipe = new StandardSchemaValidationPipe({
  exceptionFactory: (issues) =>
    new BadRequestException({ code: 'INVALID_INPUT', message: issues[0]?.message ?? 'Invalid input.' }),
});
