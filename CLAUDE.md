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

1. Auth: guardian consent flow for minors, admin review of verifications (phone OTP, sessions, profile and ID upload are done)
2. Booking API: split shares between players (with matches), cancellation and refunds, recurring series, expiry notifications (browsing, holds, advance payment and vendor confirmation are done)
3. Vendors: onboarding, branches, courts, price rules, policies, payment account approval, site visits
4. Matches: create, filters, join requests, approval, shares
5. Chat with phone number warning
6. Monthly invoice job and overdue ladder
7. Admin API: roles, approvals, bans, commission settings, invoices, audit log
8. OpenAPI spec: done. Generated by `@nestjs/swagger` from the Zod schemas in `@Body({ schema })` and `@ApiOkResponse({ standardSchema })`, served at `/docs` and `/docs-json` outside production. Give every new endpoint both

Phase 1 is done when every item in spec section 18.4 passes.
