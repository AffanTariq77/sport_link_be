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
  'tournaments.manage',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

// Defaults for every admin-configurable rule. The settings table overrides these,
// per country first, then global. Keys match docs/SPEC.md.
export const DEFAULTS = {
  'booking.hold_minutes': 15,
  'booking.payment_confirm_minutes': 60,
  'booking.slot_step_minutes': 15,
  // OPEN (spec 6.3): a vendor cancelling a confirmed booking refunds the player in full, whatever the policy.
  'booking.vendor_cancel_full_refund': true,
  'billing.count_manual_bookings': true,
  // OPEN (spec 7.4): whether no-shows are billed like completed bookings.
  'billing.count_no_shows': true,
  'billing.due_days': 7,
  // Overdue ladder, days after the invoice is issued (Foundation 8.5).
  'billing.reminder_days': 7,
  'billing.warning_days': 14,
  'billing.hide_days': 21,
  'billing.block_days': 30,
  // Where vendors pay SportsLink, shown on every invoice (Foundation 8.5). Set by admins; empty until then.
  'billing.pay_to': '' as string,
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
  'venue.max_photos': 10,
  'venue.max_photo_bytes': 5_000_000,
  // Minor safeguards (Foundation 10.2). OPEN: each is a switch until the owner decides; defaults follow the
  // Foundation's recommendation.
  'minors.minimum_age': 13,
  'minors.block_private_chat': true,
  'minors.consent_version': '2026-09-v1' as string,
  // Spec 8.1: join requests close this long before the start.
  'booking.max_recurring_weeks': 12, // spec 6.2: only where the venue allows recurring bookings
  'match.join_cutoff_minutes': 120,
  // Find Players (spec 9.3).
  'find.max_radius_km': 25,
  'find.requests_per_hour': 3,
  'find.alerts_per_day': 10,
  'find.batch_size': 10, // nearest first; the next batch goes out if not enough players accepted
  'find.batch_minutes': 5,
  'find.location_max_age_hours': 12, // older locations are not used for matching
  'find.quiet_start_hour': 22, // local time; no alerts until quiet_end unless the player allows it
  'find.quiet_end_hour': 7,
  'find.chat_hours_after_close': 24,
  // Foundation 10.2: minors and adults do not see each other in Find Players unless the guardian allows it.
  'minors.find_players_separate': true,
  // Tournaments (spec 12.2). OPEN: whether entry fees go to SportsLink or the host venue; the tournament's pay_to
  // text tells entrants where to pay either way.
  'tournament.fee_payee': 'venue' as 'venue' | 'sportslink',
  'tournament.points_win': 3,
  'tournament.points_draw': 1,
  'tournament.group_advance': 2, // per group into the knockout
  // Results (spec 11.1). OPEN: whether silence after the window counts as confirmed.
  'result.confirm_hours': 48,
  'result.silence_confirms': true,
  // Glicko-2 (spec 11.2), public scale.
  'rating.start': 1500,
  'rating.start_deviation': 350,
  'rating.start_volatility': 0.06,
  'rating.tau': 0.5,
  'rating.inactivity_period_days': 30, // deviation grows once per idle period
  // Anti-abuse (spec 11.4): after this many rated games against the same opponent in the window, changes shrink.
  'rating.repeat_opponent_games': 3,
  'rating.repeat_opponent_days': 30,
  'rating.repeat_opponent_factor': 0.5,
  // Tiers (spec 11.5): the highest band whose minimum the rating reaches. Provisional above this deviation.
  'rating.tiers': [
    { name: 'Bronze', min: 0 },
    { name: 'Silver', min: 1400 },
    { name: 'Gold', min: 1600 },
    { name: 'Platinum', min: 1800 },
    { name: 'Elite', min: 2000 },
  ] as { name: string; min: number }[],
  'rating.provisional_deviation': 110,
  // Behaviour reviews (spec 11.6).
  'review.window_hours': 48,
  'review.venue_window_days': 14, // players review a venue this long after playing
  'review.tags': ['on_time', 'friendly', 'fair_play', 'skilled', 'good_communication', 'team_player'] as string[],
  'admin.session_hours': 8,
  'admin.max_failed_logins': 5,
  'admin.lockout_minutes': 15,
  // Granular admin permissions per role (spec 14). Change here or in the settings table, not in code paths.
  'admin.role_permissions': {
    owner: [...ADMIN_PERMISSIONS],
    super_admin: [...ADMIN_PERMISSIONS], // except managing owners, enforced where admins are managed
    operations: [
      'tournaments.manage',
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
