import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';

export const ADMIN_PERMISSIONS = [
  'admins.manage',
  'venues.approve',
  'venues.ban',
  'payment_accounts.approve',
  'billing.manage',
  'billing.view',
  'verification.review',
  'users.ban',
  'reports.review',
  'disputes.resolve',
  'audit.view',
  'settings.manage',
  'analytics.view',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

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
  // OPEN (spec 5): CNIC at sign-up, or only before creating, joining or using Find Players.
  'verification.required_at': 'signup' as 'signup' | 'before_participation',
  'verification.max_image_bytes': 5_000_000,
  // Spec 8.1: join requests close this long before the start.
  'match.join_cutoff_minutes': 120,
  'admin.session_hours': 8,
  'admin.max_failed_logins': 5,
  'admin.lockout_minutes': 15,
  // Granular admin permissions per role (spec 14). Change here or in the settings table, not in code paths.
  'admin.role_permissions': {
    owner: [...ADMIN_PERMISSIONS],
    super_admin: [...ADMIN_PERMISSIONS], // except managing owners, enforced where admins are managed
    operations: [
      'venues.approve',
      'venues.ban',
      'payment_accounts.approve',
      'billing.view',
      'verification.review',
      'disputes.resolve',
      'analytics.view',
    ],
    finance: ['payment_accounts.approve', 'billing.manage', 'billing.view', 'disputes.resolve', 'analytics.view'],
    moderation: [
      'verification.review',
      'users.ban',
      'venues.ban',
      'reports.review',
      'disputes.resolve',
      'analytics.view',
    ],
  } as Record<string, readonly string[]>,
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
