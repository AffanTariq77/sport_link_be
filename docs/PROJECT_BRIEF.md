> Original project brief, kept for reference. Superseded: the code is two repos (`sport_link_be`, `sport_link_fe`) using Drizzle, not one monorepo with `apps/api` and Prisma. Each repo's own `CLAUDE.md` is current.

# SportsLink

Sports venue booking, matchmaking, live Find Players, ratings and tournaments.
Mobile (iOS, Android), web app (players and vendors) and a separate admin panel.
Launch market: Pakistan. Built to expand to other countries.

Full spec: `docs/SPEC.md` (Technical Specification). Business rules: `docs/FOUNDATION.md`.
Read the relevant section of the spec before building any feature.

## Stack

- Monorepo: Turborepo, pnpm, TypeScript everywhere
- `apps/api`: NestJS, PostgreSQL + PostGIS, Prisma (raw SQL migrations where Prisma cannot express a constraint), Redis + BullMQ, Socket.IO
- `apps/web`: Next.js (player and vendor web)
- `apps/admin`: Next.js, separate deployment
- `apps/mobile`: React Native with Expo
- `packages/types`, `packages/validation` (Zod schemas shared by API and clients), `packages/api-client`, `packages/ui`
- Local services via `docker compose` (Postgres with PostGIS, Redis)

## Decisions already made

- Players pay vendors directly (JazzCash, Easypaisa, bank transfer, cash). SportsLink never holds player money or stores wallet or card credentials.
- Vendor billing at launch: postpaid monthly invoices. Each vendor has either a percentage commission or a monthly plan, set per vendor by admin.
- App bookings and manual bookings entered by the vendor both count for billing (`counts_for_billing`).
- CNIC upload required at sign-up (minors: B-Form plus linked guardian). Keep timing as a setting.
- Host approves every match join request. Host pays for players they bring, joiners pay their own share.
- Refunds for cancellations and no-shows are controlled by each vendor's policy.
- Ratings: Glicko-2 per user per sport and per team per sport. Behaviour reviews are separate. Tournament rating is separate and admin-controlled.
- Only admins create tournaments. Government trials are a "Coming soon" placeholder.

Anything marked OPEN in the spec: build as a setting or feature flag, never hard-code.

## Non-negotiable rules

- Double booking must be impossible: enforce with a Postgres exclusion constraint on (court_id, tstzrange) for active bookings, plus a Redis lock during checkout. Cover it with concurrency tests.
- Money: integer minor units plus currency code. Never floats.
- Times: stored in UTC, shown in the venue's timezone.
- Phone numbers are never returned by any player-facing endpoint.
- Location: store rounded (about 500 m) for matching; never expose coordinates to other users.
- CNIC images: private bucket, field-level encryption, short-lived signed URLs, every view audit-logged.
- Every admin action writes to the append-only `audit_log`.
- Every endpoint checks ownership or role. Vendor staff are scoped to their branches.
- All changeable business rules live in the `setting` table (per country where relevant).

## Engineering rules

- Treat code as production-bound.
- Never hardcode secrets. Use `.env` (git-ignored) locally, a secrets manager in deployed environments. Flag any secret found in code.
- Prefer minimal diffs. Do not refactor unrelated code.
- Run lint, type checks and tests after every change. Report failures honestly; never skip or delete failing tests to make a build pass.
- Ask before destructive or irreversible operations (dropping tables, deleting data, force pushes, rewriting history).
- No real CNIC images, phone numbers or payment details outside production. Seed data is fake.
- Do not invent features or integrations that are not in the spec. Ask instead.
- UI copy in British English.

## Phase 1 build order

1. Monorepo scaffold, docker compose, CI (lint, typecheck, test)
2. Database schema and migrations for all Phase 1 entities (spec section 4), seed data
3. Auth: phone OTP (provider behind an interface, fake provider in dev), sessions, CNIC upload, guardian flow
4. Vendors: onboarding, branches, courts, price rules, policies, payment accounts, site visits
5. Booking engine: holds, pricing, split shares, confirmation flow, manual bookings, recurring series (spec section 6)
6. Matches: create, filters, join requests, approval, shares (spec section 8)
7. Chat with phone number warning (spec section 10)
8. Vendor billing: monthly invoice job, overdue ladder (spec section 7.4)
9. Admin panel: roles, approvals, bans, commission settings, invoices, audit log (spec section 14)
10. Mobile and web screens for the above

Phase 1 is done when every item in spec section 18.4 passes.
