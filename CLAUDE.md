# SportsLink API (sport_link_be)

Backend for SportsLink: sports venue booking, matchmaking, live Find Players, ratings and tournaments.
Launch market Pakistan, built to expand. Frontend lives in the separate repo `sport_link_fe`.

Full spec: `docs/SPEC.md`. Business rules: `docs/FOUNDATION.md`. Read the relevant section before building a feature.

## Stack

- NestJS 12 (ESM only: relative imports end in `.js`), TypeScript 5.9 (TS 7 not yet supported by eslint tooling)
- PostgreSQL 16 + PostGIS, Drizzle ORM and drizzle-kit (chosen over Prisma: pure TypeScript, no engine downloads, easy raw SQL for PostGIS and constraints)
- Vitest for tests, against a real `sportslink_test` database
- Redis + BullMQ for jobs, Socket.IO for realtime (to be added when those features start)
- Nest dependency injection: always use explicit `@Inject(TOKEN)`, as in `BookingsService`

## Done so far

- Full Phase 1 schema (`src/db/schema.ts`, 33 tables) with migrations
- `drizzle/0002_constraints.sql`: booking no-overlap exclusion constraint, money checks, unique transaction references, PostGIS indexes, append-only audit log
- Booking engine (`src/bookings`): holds, manual bookings, maintenance blocks, pricing across peak boundaries and past-midnight hours, holidays, advance calculation, expiry of stale holds
- Settings with country override (`src/settings.ts`), health endpoint, seed
- Auth (`src/auth`): phone OTP with a fake SMS provider (codes print to the API log), opaque hashed access and rotating refresh tokens with reuse detection, `AuthGuard`, `/auth/me`. OTP limits are settings. `DEV_OTP_CODE` fixes the code in development
- Profile and ID (`src/users`, `src/verification`): `PATCH /me/profile` (date of birth sets `is_minor`, locked once a document is submitted), `GET`/`POST /me/verification` (CNIC for adults, B-Form for minors). Numbers and images encrypted with AES-256-GCM using keys derived from `DOCUMENT_KEY`, HMAC hash for duplicates. `verifications_active_doc_uq` blocks a document already pending or approved on any account; duplicates are flagged in `reports`. Storage behind `FileStorage` (local folder in development, S3 not added yet). Timing is the setting `verification.required_at`. Not built yet: guardian consent, admin review (approve, reject, audit-logged viewing)
- Venues and holds (`src/venues`, `src/bookings/bookings.controller.ts`): `GET /sports`, `/venues` (sport and city filters), `/venues/:id` (courts, policy, accepted payment methods, never account details), `/courts/:id/slots?date=` (slots from opening hours, priced by the engine, availability matches `bookings_no_overlap`), `POST /bookings` (hold), `GET /bookings/mine`
- Payments (`src/payments`): `GET`/`POST /bookings/:id/payment` (approved accounts with decrypted numbers, never cash as an account; method plus transaction ID moves the hold to `pending_payment` with `booking.payment_confirm_minutes`; pay at venue only when `allowUnpaidCash` or no advance, confirmed at once). Duplicate transaction IDs are rejected and flagged in `reports`. Vendor side: `GET /vendor/access`, `GET /vendor/payments`, `POST /vendor/payments/:id/confirm|reject` (owners, or staff with `confirm_payments` scoped by `branch_ids`; rows locked; rejection logged as a `payment_rejected` report until a disputes table exists). Account numbers encrypted with a key derived from `DOCUMENT_KEY`. Seed gives the demo vendor (sign in as 0300 0000001) fake approved accounts
- Vendor onboarding (`src/vendors`, owner only): `POST /vendor/apply` (needs an ID document submitted), `GET /vendor/setup` (vendor, branches with courts, hours, prices, policy and a checklist, masked accounts), branches, policy, courts (deactivation blocked by upcoming bookings), hours and prices (overlaps rejected, replaced as a whole, new bookings only), payment accounts (encrypted, pending until admin approval, `replaces_account_id`), `POST /vendor/branches/:id/submit` (checklist must pass, including every open hour priced for two weeks; creates a site visit, status `pending_visit`). Not built yet: venue photos, and staff access to onboarding endpoints (owner only)
- Vendor operations (`src/vendors/access.ts`, `calendar.service.ts`, `staff.service.ts`): `vendorAccess(db, user, permission)` is the one branch-scoped access check (owners, or active staff with the permission; empty `branch_ids` = all branches). `GET /vendor/calendar` (a local day: slots per court with app, manual and block entries; players by name only, walk-in phone decrypted for the vendor), `POST /vendor/bookings/manual` (phone encrypted), `POST /vendor/blocks`, `POST /vendor/bookings/:id/no-show`, `GET/POST/DELETE /vendor/:vendorId/staff` (owners or `manage_staff`; staff added by the phone of their existing account)
- Matches (`src/matches`): `POST /matches` from the host's own booking that is confirmed or pending payment (the host secures the slot and pays for the players they bring; one match per booking) or an unlisted venue (needs `acceptedUnlistedWarning`, no payment). Filters: age range, gender, verified only (skill rating comes with ratings). `GET /matches` hides matches the viewer does not meet the filters for or whose host blocked them; join requests close at `match.join_cutoff_minutes` before the start; overlapping matches blocked. Host approves (listed: creates the joiner's share of `ceil(total / slots)`; unlisted: confirmed), declines, removes, cancels; full matches waitlist further approvals. Joiners pay their share with `POST /matches/:id/pay`; the vendor confirms it in the normal payments queue, which confirms the player (`refreshMatchStatus`)
- Chat (`src/chat`): match group chats (host plus approved and confirmed players) and player-to-venue booking chats (venue side: anyone with `view_bookings` on the branch); membership is worked out from the match or booking on every call. `containsPhoneNumber` catches Pakistani numbers including spaced digits and English or Roman Urdu number words; sending one returns `PHONE_WARNING` (409) until `confirmPhone`, then the message is `flagged_phone` and `chat.phone_number_shared` is logged. Block and unblock (`/users/:id/block`), reports attach the last 20 messages. Clients poll `GET /conversations/:id/messages?after=`; Socket.IO, photos, voice notes and location pins are not built yet
- Admin (`src/admin`): separate sign-in `POST /admin/auth/login` (email, scrypt password, TOTP code, lockout after `admin.max_failed_logins`), opaque hashed `admin_sessions` (`admin.session_hours`), `AdminGuard` plus `@Permission(...)`; role permissions are the setting `admin.role_permissions`. Every admin action goes through `audit()` in the same transaction. Endpoints: overview, identity review (number and images decrypted per view, each view audit-logged; approval activates the user), venues (schedule visit, record result: passing needs the owner's CNIC approved, makes the branch live and the vendor approved), venue status, vendor billing, payment account approval (approving a replacement retires the old one), user search and moderation (bans revoke sessions), reports and disputes (minors first), audit log. Create admins with `pnpm admin:create`; the seed creates a local admin from `DEV_ADMIN_EMAIL`/`DEV_ADMIN_PASSWORD`, two-factor code `DEV_TOTP_CODE` in development only

## Decisions already made

- Players pay vendors directly (JazzCash, Easypaisa, bank transfer, cash). SportsLink never holds player money or stores wallet or card credentials.
- Vendor billing at launch: postpaid monthly invoices. Each vendor has a percentage commission (`commission_bps`) or a monthly plan, set by admin.
- App bookings and manual bookings both count for billing (setting `billing.count_manual_bookings`).
- CNIC upload required at sign-up (minors: B-Form plus linked guardian). Keep timing as a setting.
- Host approves every match join request. Host pays for players they bring, joiners pay their own share.
- Refunds for cancellations and no-shows follow each vendor's policy, snapshotted on the booking.
- Ratings: Glicko-2 per user per sport and per team per sport. Behaviour reviews separate. Tournament rating separate and admin-controlled.
- Only admins create tournaments. Government trials are a "Coming soon" placeholder.

Anything marked OPEN in the spec: build as a setting or feature flag, never hard-code.

## Non-negotiable rules

- Double booking is prevented by the `bookings_no_overlap` exclusion constraint. Never remove or weaken it. Any new booking type goes in the `bookings` table so the constraint covers it. Keep `test/bookings.spec.ts` passing.
- Money: integer minor units plus currency code. Never floats. Percentages in basis points.
- Times: stored as timestamptz (UTC), converted with the branch timezone.
- Phone numbers are never returned by any player-facing endpoint.
- Location: store rounded (about 500 m) for Find Players; never expose coordinates to other users.
- CNIC images: private bucket, field-level encryption, short-lived signed URLs, every view audit-logged.
- Every admin action writes to `audit_log` (append-only, enforced by trigger).
- Every endpoint checks ownership or role. Vendor staff are scoped to their branches.
- Changeable business rules go in `DEFAULTS` in `src/settings.ts` and are read with `getSetting`.

## Engineering rules

- Treat code as production-bound.
- Never hardcode secrets. `.env` locally (git-ignored), a secrets manager in deployed environments. Flag any secret found in code.
- Prefer minimal diffs. Do not refactor unrelated code.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` after every change. Report failures honestly; never skip or delete failing tests to make a build pass.
- Ask before destructive or irreversible operations (dropping tables, deleting data, force pushes, rewriting history).
- No real CNIC images, phone numbers or payment details outside production. Seed and test data are fake.
- After `pnpm db:generate`, remove the quotes drizzle-kit puts around `geography(Point, 4326)`.
- Do not invent features or integrations that are not in the spec. Ask instead.
- User-facing text in British English.

## Next steps (Phase 1)

1. Auth: guardian consent flow for minors (phone OTP, sessions, profile, ID upload and admin review are done)
2. Booking API: split shares between players (with matches), cancellation and refunds, recurring series, expiry notifications (browsing, holds, advance payment and vendor confirmation are done)
3. Vendors: venue photos (application, venues, courts, hours, prices, policies, payment accounts, review, calendar, manual bookings, blocks, no-shows and staff are done)
4. Matches: results and ratings are Phase 2 (create, filters, join requests, approval, waitlist and shares are done)
5. Chat: realtime (Socket.IO), photos, voice notes, location pins, retention (text chat with the phone warning, block and report are done)
6. Monthly invoice job and overdue ladder
7. Admin API: invoices and admin user management (roles, approvals, bans, commission, reports and audit log are done)
8. OpenAPI spec: done. Generated by `@nestjs/swagger` from the Zod schemas in `@Body({ schema })` and `@ApiOkResponse({ standardSchema })`, served at `/docs` and `/docs-json` outside production. Give every new endpoint both

Phase 1 is done when every item in spec section 18.4 passes.
