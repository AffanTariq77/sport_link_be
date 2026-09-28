import { z } from 'zod';

// Fails fast on startup if required environment variables are missing. Secrets come from env only.
const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    // Real providers are added here once chosen (spec section 2, OPEN).
    SMS_PROVIDER: z.enum(['fake']).default('fake'),
    // Development only: every OTP is this code instead of a random one. Refused in production.
    DEV_OTP_CODE: z
      .string()
      .regex(/^\d{6}$/, 'DEV_OTP_CODE must be 6 digits')
      .optional(),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.SMS_PROVIDER === 'fake'), {
    message: 'SMS_PROVIDER=fake is not allowed in production',
    path: ['SMS_PROVIDER'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.DEV_OTP_CODE), {
    message: 'DEV_OTP_CODE is not allowed in production',
    path: ['DEV_OTP_CODE'],
  });

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
