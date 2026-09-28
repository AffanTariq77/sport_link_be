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
    // Master key for CNIC and B-Form data (base64, 32 bytes). Separate keys for numbers, images and the
    // duplicate-check hash are derived from it. Generate with: openssl rand -base64 32
    DOCUMENT_KEY: z.base64().refine((k) => Buffer.from(k, 'base64').length === 32, 'DOCUMENT_KEY must be 32 bytes'),
    // Where uploaded documents are stored. 'local' is a folder for development; S3 is added once hosting is chosen.
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_DIR: z.string().default('.storage'),
    // Development only: a fixed admin two-factor code, like DEV_OTP_CODE. Refused in production.
    DEV_TOTP_CODE: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.STORAGE_DRIVER === 'local'), {
    message: 'STORAGE_DRIVER=local is not allowed in production',
    path: ['STORAGE_DRIVER'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.SMS_PROVIDER === 'fake'), {
    message: 'SMS_PROVIDER=fake is not allowed in production',
    path: ['SMS_PROVIDER'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.DEV_TOTP_CODE), {
    message: 'DEV_TOTP_CODE is not allowed in production',
    path: ['DEV_TOTP_CODE'],
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.DEV_OTP_CODE), {
    message: 'DEV_OTP_CODE is not allowed in production',
    path: ['DEV_OTP_CODE'],
  });

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
