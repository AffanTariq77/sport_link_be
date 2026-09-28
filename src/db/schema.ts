// Phase 1 schema. See docs/SPEC.md section 4.
// Rules: money is integer minor units (paisa for PKR) with a currency code,
// times are timestamptz (UTC), all business rules that may change live in `settings`.
// The booking no-overlap constraint and PostGIS indexes are in the custom SQL migration
// (drizzle/0001_constraints.sql) because Drizzle cannot express them.
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// PostGIS geography point, written as WKT 'SRID=4326;POINT(lng lat)'.
const geographyPoint = customType<{ data: string }>({ dataType: () => 'geography(Point, 4326)' });

const id = () => uuid('id').primaryKey().defaultRandom();
const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const timestamps = {
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
};

// ---------- Enums ----------
export const userStatus = pgEnum('user_status', ['pending_verification', 'active', 'suspended', 'banned', 'deleted']);
export const gender = pgEnum('gender', ['male', 'female', 'other', 'prefer_not_to_say']);
export const docType = pgEnum('doc_type', ['cnic', 'b_form']);
export const reviewStatus = pgEnum('review_status', ['pending', 'approved', 'rejected']);
export const alertMode = pgEnum('alert_mode', ['always', 'only_when_available', 'never']);
export const billingModel = pgEnum('billing_model', ['percentage', 'monthly']);
export const vendorStatus = pgEnum('vendor_status', [
  'applied',
  'under_review',
  'approved',
  'rejected',
  'suspended',
  'blocked',
  'banned',
]);
export const listingStatus = pgEnum('listing_status', [
  'draft',
  'pending_visit',
  'live',
  'hidden',
  'suspended',
  'banned',
]);
export const paymentMethod = pgEnum('payment_method', ['jazzcash', 'easypaisa', 'bank_transfer', 'cash']);
export const dayType = pgEnum('day_type', ['weekday', 'weekend', 'holiday', 'all']);
export const advanceType = pgEnum('advance_type', ['fixed', 'percentage', 'none']);
export const visitResult = pgEnum('visit_result', ['scheduled', 'passed', 'failed', 'no_show', 'cancelled']);
export const bookingSource = pgEnum('booking_source', ['app', 'manual', 'block']);
export const bookingStatus = pgEnum('booking_status', [
  'held',
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
  'expired',
]);
export const shareStatus = pgEnum('share_status', [
  'pending',
  'submitted',
  'confirmed',
  'rejected',
  'refunded',
  'void',
]);
export const matchStatus = pgEnum('match_status', [
  'open',
  'full',
  'in_progress',
  'result_pending',
  'completed',
  'disputed',
  'cancelled',
]);
export const matchPlayerStatus = pgEnum('match_player_status', [
  'requested',
  'approved',
  'confirmed',
  'declined',
  'withdrawn',
  'removed',
  'waitlisted',
]);
export const conversationType = pgEnum('conversation_type', ['direct', 'match', 'team', 'find_players', 'booking']);
export const reportStatus = pgEnum('report_status', ['open', 'in_review', 'actioned', 'dismissed']);
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'overdue', 'written_off', 'void']);
export const adminRole = pgEnum('admin_role', ['owner', 'super_admin', 'operations', 'finance', 'moderation']);

// ---------- Platform ----------
export const countries = pgTable('countries', {
  code: text('code').primaryKey(), // ISO 3166-1 alpha-2, e.g. PK
  name: text('name').notNull(),
  currency: text('currency').notNull(), // ISO 4217, e.g. PKR
  timezone: text('timezone').notNull(), // IANA, e.g. Asia/Karachi
  languages: text('languages').array().notNull(),
  paymentMethods: paymentMethod('payment_methods').array().notNull(),
  enabled: boolean('enabled').notNull().default(false),
});

// Admin-configurable business rules. countryCode null = global default.
export const settings = pgTable(
  'settings',
  {
    id: id(),
    key: text('key').notNull(),
    countryCode: text('country_code').references(() => countries.code),
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (t) => [unique('settings_key_country_uq').on(t.key, t.countryCode).nullsNotDistinct()],
);

export const sports = pgTable('sports', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  teamSizeMin: smallint('team_size_min').notNull(),
  teamSizeMax: smallint('team_size_max').notNull(),
  statSchema: jsonb('stat_schema'), // detailed stats definition, Phase 3
  active: boolean('active').notNull().default(true),
});

// ---------- Users ----------
export const users = pgTable(
  'users',
  {
    id: id(),
    phone: text('phone').notNull(), // E.164. Never returned by player-facing APIs.
    name: text('name'),
    dob: date('dob'),
    gender: gender('gender'),
    city: text('city'),
    countryCode: text('country_code')
      .notNull()
      .references(() => countries.code),
    photoKey: text('photo_key'),
    status: userStatus('status').notNull().default('pending_verification'),
    isMinor: boolean('is_minor').notNull().default(false),
    guardianUserId: uuid('guardian_user_id'),
    guardianConsentAt: ts('guardian_consent_at'),
    guardianConsentVersion: text('guardian_consent_version'),
    reliabilityScore: smallint('reliability_score').notNull().default(100),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_phone_uq').on(t.phone)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    docType: docType('doc_type').notNull(),
    // Document number stored encrypted by the app (field-level). Hash used for duplicate detection.
    docNumberEncrypted: text('doc_number_encrypted').notNull(),
    docNumberHash: text('doc_number_hash').notNull(),
    frontKey: text('front_key').notNull(), // private bucket object key
    backKey: text('back_key').notNull(),
    status: reviewStatus('status').notNull().default('pending'),
    rejectionReason: text('rejection_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    ...timestamps,
  },
  (t) => [index('verifications_hash_idx').on(t.docNumberHash)],
);

export const devices = pgTable('devices', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  deviceFingerprint: text('device_fingerprint').notNull(),
  pushToken: text('push_token'),
  platform: text('platform').notNull(), // ios | android | web
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
});

// ---------- Auth ----------
// One row per OTP sent. Only a hash of the code is stored. locked_until is set after too many wrong attempts.
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    phone: text('phone').notNull(), // E.164
    codeHash: text('code_hash').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    lockedUntil: ts('locked_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('otp_phone_created_idx').on(t.phone, t.createdAt)],
);

// One row per signed-in device. Tokens are opaque and stored as SHA-256 hashes, so a database leak
// does not leak sessions, and revoking a row (ban, staff removal) takes effect on the next request.
// previous_refresh_hash detects reuse of a rotated refresh token, which revokes the session.
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    accessTokenHash: text('access_token_hash').notNull(),
    accessExpiresAt: ts('access_expires_at').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    previousRefreshHash: text('previous_refresh_hash'),
    refreshExpiresAt: ts('refresh_expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_access_uq').on(t.accessTokenHash),
    uniqueIndex('sessions_refresh_uq').on(t.refreshTokenHash),
    index('sessions_previous_refresh_idx').on(t.previousRefreshHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const playerSports = pgTable(
  'player_sports',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sportId: uuid('sport_id')
      .notNull()
      .references(() => sports.id),
    position: text('position'),
    selfLevel: smallint('self_level'), // 1 to 5
    availableNow: boolean('available_now').notNull().default(false),
    alertMode: alertMode('alert_mode').notNull().default('only_when_available'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sportId] })],
);

export const blocks = pgTable(
  'user_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

// ---------- Vendors and venues ----------
export const vendors = pgTable('vendors', {
  id: id(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id),
  businessName: text('business_name').notNull(),
  countryCode: text('country_code')
    .notNull()
    .references(() => countries.code),
  billingModel: billingModel('billing_model').notNull().default('percentage'),
  commissionBps: integer('commission_bps'), // basis points: 500 = 5.00%
  monthlyFee: money('monthly_fee'),
  status: vendorStatus('status').notNull().default('applied'),
  ...timestamps,
});

export const vendorStaff = pgTable(
  'vendor_staff',
  {
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    branchIds: uuid('branch_ids').array().notNull(), // empty = all branches
    permissions: text('permissions').array().notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.vendorId, t.userId] })],
);

export const branches = pgTable('branches', {
  id: id(),
  vendorId: uuid('vendor_id')
    .notNull()
    .references(() => vendors.id),
  name: text('name').notNull(),
  address: text('address').notNull(),
  city: text('city').notNull(),
  location: geographyPoint('location').notNull(),
  timezone: text('timezone').notNull(),
  facilities: text('facilities').array().notNull().default([]),
  photoKeys: text('photo_keys').array().notNull().default([]),
  rules: text('rules'),
  status: listingStatus('status').notNull().default('draft'),
  ...timestamps,
});

export const courts = pgTable('courts', {
  id: id(),
  branchId: uuid('branch_id')
    .notNull()
    .references(() => branches.id),
  name: text('name').notNull(),
  surface: text('surface'),
  photoKeys: text('photo_keys').array().notNull().default([]),
  slotMinutes: smallint('slot_minutes').notNull().default(60),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const courtSports = pgTable(
  'court_sports',
  {
    courtId: uuid('court_id')
      .notNull()
      .references(() => courts.id),
    sportId: uuid('sport_id')
      .notNull()
      .references(() => sports.id),
  },
  (t) => [primaryKey({ columns: [t.courtId, t.sportId] })],
);

export const openingHours = pgTable('opening_hours', {
  id: id(),
  courtId: uuid('court_id')
    .notNull()
    .references(() => courts.id),
  weekday: smallint('weekday').notNull(), // 0 = Sunday
  opensAt: time('opens_at').notNull(),
  closesAt: time('closes_at').notNull(), // may be earlier than opensAt for past-midnight hours
});

// Price per slot. Most specific matching rule wins (holiday > weekend/weekday > all).
export const priceRules = pgTable('price_rules', {
  id: id(),
  courtId: uuid('court_id')
    .notNull()
    .references(() => courts.id),
  dayType: dayType('day_type').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  pricePerHour: money('price_per_hour').notNull(),
  ...timestamps,
});

export const holidays = pgTable(
  'holidays',
  {
    countryCode: text('country_code')
      .notNull()
      .references(() => countries.code),
    day: date('day').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.countryCode, t.day] })],
);

export const venuePolicies = pgTable('venue_policies', {
  branchId: uuid('branch_id')
    .primaryKey()
    .references(() => branches.id),
  advanceType: advanceType('advance_type').notNull().default('percentage'),
  advanceValue: integer('advance_value').notNull().default(2000), // bps if percentage, minor units if fixed
  cancelRefund: boolean('cancel_refund').notNull().default(true),
  cancelWindowHours: smallint('cancel_window_hours').notNull().default(24),
  noShowRefund: boolean('no_show_refund').notNull().default(false),
  recurringAllowed: boolean('recurring_allowed').notNull().default(false),
  allowUnpaidCash: boolean('allow_unpaid_cash').notNull().default(false),
  ...timestamps,
});

export const paymentAccounts = pgTable('payment_accounts', {
  id: id(),
  vendorId: uuid('vendor_id')
    .notNull()
    .references(() => vendors.id),
  method: paymentMethod('method').notNull(),
  accountTitle: text('account_title').notNull(),
  accountNumberEncrypted: text('account_number_encrypted'), // null for cash
  bankName: text('bank_name'),
  status: reviewStatus('status').notNull().default('pending'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  replacesAccountId: uuid('replaces_account_id'), // old account stays active until this is approved
  ...timestamps,
});

export const siteVisits = pgTable('site_visits', {
  id: id(),
  branchId: uuid('branch_id')
    .notNull()
    .references(() => branches.id),
  requestedBy: text('requested_by').notNull(), // vendor | admin
  scheduledAt: ts('scheduled_at'),
  visitorAdminId: uuid('visitor_admin_id'),
  result: visitResult('result').notNull().default('scheduled'),
  notes: text('notes'),
  photoKeys: text('photo_keys').array().notNull().default([]),
  ...timestamps,
});

// ---------- Bookings ----------
export const recurringSeries = pgTable('recurring_series', {
  id: id(),
  courtId: uuid('court_id')
    .notNull()
    .references(() => courts.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  weekday: smallint('weekday').notNull(),
  startTime: time('start_time').notNull(),
  durationMinutes: smallint('duration_minutes').notNull(),
  weeks: smallint('weeks').notNull(),
  status: text('status').notNull().default('active'),
  ...timestamps,
});

// No-overlap guarantee: exclusion constraint on (court_id, tstzrange(start_at, end_at))
// for active statuses. See drizzle/0001_constraints.sql.
export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    courtId: uuid('court_id')
      .notNull()
      .references(() => courts.id),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    source: bookingSource('source').notNull(),
    status: bookingStatus('status').notNull(),
    currency: text('currency').notNull(),
    total: money('total').notNull(),
    advanceDue: money('advance_due').notNull(),
    // Policy snapshot at booking time, so later policy changes do not affect this booking.
    policySnapshot: jsonb('policy_snapshot').notNull(),
    holdExpiresAt: ts('hold_expires_at'),
    paymentDeadlineAt: ts('payment_deadline_at'),
    createdBy: uuid('created_by').references(() => users.id),
    manualCustomerName: text('manual_customer_name'),
    manualCustomerPhoneEncrypted: text('manual_customer_phone_encrypted'),
    matchId: uuid('match_id'),
    recurringSeriesId: uuid('recurring_series_id').references(() => recurringSeries.id),
    countsForBilling: boolean('counts_for_billing').notNull(),
    cancelledBy: text('cancelled_by'), // player | vendor | admin | system
    cancelReason: text('cancel_reason'),
    ...timestamps,
  },
  (t) => [index('bookings_court_start_idx').on(t.courtId, t.startAt)],
);

export const bookingShares = pgTable('booking_shares', {
  id: id(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  playersCovered: smallint('players_covered').notNull().default(1),
  amount: money('amount').notNull(),
  advanceAmount: money('advance_amount').notNull(),
  method: paymentMethod('method'),
  txnReference: text('txn_reference'),
  status: shareStatus('status').notNull().default('pending'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: ts('confirmed_at'),
  dueAt: ts('due_at'),
  ...timestamps,
});

// ---------- Matches ----------
export const matches = pgTable('matches', {
  id: id(),
  hostId: uuid('host_id')
    .notNull()
    .references(() => users.id),
  sportId: uuid('sport_id')
    .notNull()
    .references(() => sports.id),
  bookingId: uuid('booking_id').references(() => bookings.id),
  // Unlisted venue: no booking, free-text address plus approximate point.
  unlistedVenueName: text('unlisted_venue_name'),
  unlistedVenueAddress: text('unlisted_venue_address'),
  location: geographyPoint('location'),
  startAt: ts('start_at').notNull(),
  endAt: ts('end_at').notNull(),
  slotsTotal: smallint('slots_total').notNull(),
  hostBrings: smallint('host_brings').notNull().default(1),
  filters: jsonb('filters').notNull().default({}), // rating range, age range, gender, verifiedOnly
  status: matchStatus('status').notNull().default('open'),
  joinCutoffAt: ts('join_cutoff_at'),
  ...timestamps,
});

export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    teamSide: smallint('team_side'),
    status: matchPlayerStatus('status').notNull().default('requested'),
    shareId: uuid('share_id').references(() => bookingShares.id),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] })],
);

// ---------- Chat ----------
export const conversations = pgTable('conversations', {
  id: id(),
  type: conversationType('type').notNull(),
  refId: uuid('ref_id'), // match, team, request or booking id
  archivedAt: ts('archived_at'),
  ...timestamps,
});

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    lastReadAt: ts('last_read_at'),
    leftAt: ts('left_at'),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    senderId: uuid('sender_id').references(() => users.id), // null = system message
    kind: text('kind').notNull(), // text | image | voice | location | system
    body: text('body'),
    mediaKey: text('media_key'),
    flaggedPhone: boolean('flagged_phone').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt)],
);

// ---------- Trust and safety ----------
export const reports = pgTable('reports', {
  id: id(),
  reporterId: uuid('reporter_id')
    .notNull()
    .references(() => users.id),
  targetType: text('target_type').notNull(), // user | venue | message | review | match
  targetId: uuid('target_id').notNull(),
  reason: text('reason').notNull(),
  details: text('details'),
  evidence: jsonb('evidence'), // e.g. attached last messages
  involvesMinor: boolean('involves_minor').notNull().default(false),
  status: reportStatus('status').notNull().default('open'),
  ...timestamps,
});

export const moderationActions = pgTable('moderation_actions', {
  id: id(),
  adminId: uuid('admin_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  action: text('action').notNull(), // warning | suspension | ban | shadow_limit | hide | remove
  reason: text('reason').notNull(),
  expiresAt: ts('expires_at'),
  reportId: uuid('report_id').references(() => reports.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ---------- Billing ----------
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    status: invoiceStatus('status').notNull().default('draft'),
    issuedAt: ts('issued_at'),
    dueAt: ts('due_at'),
    paidAt: ts('paid_at'),
    paymentProofKey: text('payment_proof_key'),
    ...timestamps,
  },
  (t) => [uniqueIndex('invoices_vendor_period_uq').on(t.vendorId, t.periodStart)],
);

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id),
  bookingId: uuid('booking_id').references(() => bookings.id), // null for monthly fee or credit notes
  description: text('description').notNull(),
  amount: money('amount').notNull(), // negative for credit notes
});

// ---------- Admin ----------
export const adminUsers = pgTable('admin_users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: adminRole('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

// Append-only. Update and delete are blocked by trigger in drizzle/0001_constraints.sql.
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorType: text('actor_type').notNull(), // admin | user | system
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_target_idx').on(t.targetType, t.targetId)],
);
