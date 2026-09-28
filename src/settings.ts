import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';

// Defaults for every admin-configurable rule. The settings table overrides these,
// per country first, then global. Keys match docs/SPEC.md.
export const DEFAULTS = {
  'booking.hold_minutes': 15,
  'booking.payment_confirm_minutes': 60,
  'booking.slot_step_minutes': 15,
  'billing.count_manual_bookings': true,
  'calendar.weekend_days': [0, 6], // 0 = Sunday
  'auth.otp_ttl_seconds': 300,
  'auth.otp_resend_seconds': 60,
  'auth.otp_max_attempts': 5,
  'auth.otp_lockout_minutes': 30,
  'auth.otp_requests_per_hour': 5,
  'auth.access_token_minutes': 15,
  'auth.refresh_token_days': 30,
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export async function getSetting<K extends SettingKey>(
  db: Pick<Db, 'select'>,
  key: K,
  countryCode?: string,
): Promise<(typeof DEFAULTS)[K]> {
  const rows = await db
    .select({ countryCode: settings.countryCode, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, key),
        countryCode
          ? or(eq(settings.countryCode, countryCode), isNull(settings.countryCode))
          : isNull(settings.countryCode),
      ),
    );
  const row = rows.find((r) => r.countryCode === countryCode) ?? rows.find((r) => r.countryCode === null);
  return (row?.value as (typeof DEFAULTS)[K]) ?? DEFAULTS[key];
}
