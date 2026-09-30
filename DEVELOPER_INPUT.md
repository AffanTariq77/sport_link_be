# SportsLink: developer input and handover

This file is identical in `sport_link_be` and `sport_link_fe`. It lists what is built, the only values a developer
must supply, how to get each one, what is still mocked or missing, and how to run, test and ship.

Nothing secret is in either repository. Every development shortcut below (fixed OTP, fake SMS, logged push, local
file storage, local admin) is refused by the API when `NODE_ENV=production`, so none of them can reach production
by accident.

---

## ✅ COMPLETED

**Backend (`sport_link_be`, NestJS, PostgreSQL with PostGIS, 24 test files)**

- Auth: phone OTP, rotating refresh tokens with reuse detection, limits and lockout as settings, phone number change
  (codes on both numbers, or admin review if the old number is lost), account deletion with anonymisation.
- Profiles and ID: CNIC or B-Form upload, encrypted numbers and images (AES-256-GCM), duplicate detection, admin
  review with every view audit-logged.
- Minors: guardian consent with versioned text, locked accounts until consent, private-chat block, Find Players
  separation, guardian alerts for bookings, matches and teams, guardianship ending at 18.
- Venues and booking engine: opening hours, peak and holiday pricing, holds, payments made directly to the venue
  (JazzCash, Easypaisa, bank transfer, cash where allowed) with vendor confirmation, the double-booking exclusion
  constraint, cancellations and refunds by policy snapshot, weekly bookings paid upfront, extensions.
- Vendors: onboarding checklist, branches, courts, hours, prices, policies, payment accounts, venue photos, staff with
  branch-scoped permissions, calendar, manual bookings, blocks, no-shows, refunds, billing, analytics, revenue
  calculator, venue reviews with replies.
- Matches: listed and unlisted venues, filters (age, gender, verified, rating range), host approval, waitlist, shares.
- Chat: match, booking, team and Find Players group chats with the phone-number warning, block and report.
- Ratings: results with confirm or dispute, Glicko-2 (checked against Glickman's example), team composites, idle
  deviation growth, repeat-opponent damping, admin decisions and voids, behaviour reviews, tiers, leaderboards.
- Teams: roster, invites, roles and handover, team chat, team matches and challenges, team ratings, captain
  replacement when a captain is banned, roster lock during tournaments.
- Find Players: rounded locations (about 500 m), availability and alert modes, nearest-first batched alerts via
  PostGIS with blocks, quiet hours, daily caps and minor safeguards, picking players, group chat, conversion to a match.
- Tournaments (admin only): knockout, league, round robin, groups then knockout; seeded draws with byes; entry fees
  confirmed by an admin; results, walkovers, withdrawals, tables; tournament ratings; government trials placeholder.
- Billing and jobs: monthly invoices, overdue ladder with notifications, proof upload, settlement; a 5-minute job
  runner under a Postgres advisory lock.
- Notifications: stored in-app list plus push through Expo, hooked into every flow above.
- Admin: separate sign-in with password and TOTP, role permissions as settings, audit log on every action,
  identity checks, venues and site visits, payment accounts, invoices, users and bans, reports, disputed results,
  tournaments, platform analytics.
- Storage: local folder for development, any private S3-compatible bucket for deployment (tested against an S3 mock).
- Security: headers, per-IP rate limit, input validation on every endpoint, OpenAPI at `/docs` outside production.

**Frontend (`sport_link_fe`, Turborepo)**

- `apps/web` (Next.js, port 3001): every player and vendor flow above, with a header, notifications badge, loading,
  error and not-found screens. Crawled page by page with no console errors.
- `apps/admin` (Next.js, port 3002): every admin area above.
- `apps/mobile` (Expo SDK 57): sign-in, onboarding and ID, venues and booking, payments, matches, results and reviews,
  chats, notifications and push registration, Find Players, teams, tournaments, rankings, player profiles, account,
  and vendor mode (calendar, payments, refunds). iOS and Android bundles build; `expo-doctor` passes.
- `packages/api-client`: typed client generated from the API's OpenAPI document.

---

## 🔑 DEVELOPER INPUT REQUIRED

Only these values are needed. Everything else has a working default.

**To run locally (development): nothing.** Copy the example files and generate one key:

- [ ] `DOCUMENT_KEY` (backend): generate locally, one command, no account needed.

**To deploy (staging or production):**

- [ ] `DATABASE_URL` (backend): managed PostgreSQL 16 with PostGIS.
- [ ] `DOCUMENT_KEY` (backend): a new key per environment, kept in a secrets manager.
- [ ] `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, AWS credentials or an IAM role (backend); `S3_ENDPOINT` only for
      Cloudflare R2 or MinIO.
- [ ] `PUSH_PROVIDER=expo`, plus `EXPO_ACCESS_TOKEN` only if enhanced push security is on (backend).
- [ ] EAS project id in `apps/mobile/app.json` (`expo.extra.eas.projectId`), set by `eas init` (mobile).
- [ ] `EXPO_PUBLIC_API_URL` (mobile builds): the deployed API address. Replace the `example.invalid` placeholders in
      `apps/mobile/eas.json` (preview and production profiles).
- [ ] `API_URL` (web and admin): the deployed API address, reachable from the Next.js servers.
- [ ] An SMS provider account and the adapter for it (see Known limitations: this needs code, not only a key).
- [ ] The first real admin, created with `pnpm admin:create` (no variable; see below).
- [ ] Map tiles for the web Find Players map: a keyed tile provider (MapTiler, Stadia or similar). OpenStreetMap's public
      tiles are for light use only; the URL is `TILES` in `apps/web/src/app/find-players/map.tsx`.
- [ ] Google Maps Android API key for development and store builds of the mobile map (`react-native-maps`): add the
      `react-native-maps` plugin with `androidGoogleMapsApiKey` to `apps/mobile/app.json`. Expo Go needs none; iOS uses Apple Maps.

---

## 🛠️ HOW TO GET EACH INPUT

### DOCUMENT_KEY

- **Purpose:** master key for CNIC and B-Form numbers and images, payment account numbers, walk-in phone numbers and
  admin TOTP secrets. Separate keys are derived from it (HKDF).
- **Why needed:** the API refuses to start without it. Losing it makes stored documents unreadable; leaking it exposes
  them.
- **Provider:** none. It is a random 32-byte value.
- **Steps:** run `openssl rand -base64 32` and copy the output.
- **Where:** `sport_link_be/.env` locally; your secrets manager (AWS Secrets Manager, Doppler, Render or Fly secrets)
  for each deployed environment. Never commit it and never reuse the development key.
- **Environments:** all (a different value each).
- **Development fallback:** none, by design. Generating one takes a second.

### DATABASE_URL (and TEST_DATABASE_URL)

- **Purpose:** PostgreSQL connection string. The test database is rebuilt from migrations on every test run.
- **Provider:** any PostgreSQL 16 with the PostGIS extension: AWS RDS, Neon, Supabase, Crunchy Bridge.
- **Steps:** create the database, enable PostGIS (`CREATE EXTENSION postgis;`, or pick a PostGIS-enabled plan), copy
  the connection string, run `pnpm db:migrate` against it. Do not run `pnpm db:seed` in production (it refuses).
- **Where:** `sport_link_be/.env` locally; secrets manager when deployed.
- **Environments:** all. `TEST_DATABASE_URL` is for local and CI only.
- **Development fallback:** yes. `docker compose up -d` starts PostGIS and creates `sportslink` and `sportslink_test`;
  `.env.example` has matching values.

### S3 storage: STORAGE_DRIVER, S3_BUCKET, S3_REGION, S3_ENDPOINT, AWS credentials

- **Purpose:** private storage for ID documents, invoice payment proofs and venue photos (served through the API).
- **Why needed:** the local folder driver is refused in production.
- **Provider:** AWS S3, or any S3-compatible service (Cloudflare R2, MinIO, Backblaze B2).
- **Steps (AWS):** create a bucket in the region closest to users (for example `ap-south-1`), keep Block Public Access
  on, enable default encryption. Create an IAM role (preferred) or user with `s3:PutObject`, `s3:GetObject` and
  `s3:DeleteObject` on that bucket only. For R2, create an API token with object read and write on the bucket and set
  `S3_ENDPOINT` to the account's R2 endpoint.
- **Where:** backend environment: `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, and either an IAM role on the host or
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the secrets manager.
- **Environments:** staging and production.
- **Development fallback:** yes. `STORAGE_DRIVER=local` stores files in `.storage/` (git-ignored).

### Push notifications: PUSH_PROVIDER, EXPO_ACCESS_TOKEN, EAS project id

- **Purpose:** phone push for bookings, payments, matches, chat and the rest. Notifications are always stored and shown
  in the app's list; push is the extra delivery.
- **Provider:** Expo (EAS). Expo relays to Apple (APNs) and Google (FCM).
- **Steps:**
  1. Create an Expo account and run `npx eas-cli login`, then `npx eas-cli init` in `apps/mobile`. It writes
     `expo.extra.eas.projectId` into `app.json`; commit that (it is not a secret).
  2. Android: create a Firebase project, add an Android app with package `com.sportslink.app`, and upload the FCM V1
     service account key in the Expo dashboard under Credentials. iOS: `eas credentials` creates the APNs key with
     your Apple Developer account (paid membership needed).
  3. Build a development or store build with `eas build`. Expo Go on Android cannot receive push (SDK 53 and later).
  4. Optional: turn on enhanced push security in the Expo project and create an access token under Account settings,
     Access tokens.
- **Where:** backend `PUSH_PROVIDER=expo`, and `EXPO_ACCESS_TOKEN` in the secrets manager if you turned on enhanced
  security. Project id in `apps/mobile/app.json`.
- **Environments:** staging and production.
- **Development fallback:** yes. `PUSH_PROVIDER=log` prints each push to the API log; the in-app list works without push.

### API addresses: API_URL (web, admin), EXPO_PUBLIC_API_URL (mobile)

- **Purpose:** where each frontend reaches the API. The browser never calls the API directly; the Next.js servers do.
- **Steps:** deploy the API, note its HTTPS address, set it in each frontend's host settings.
- **Where:** `apps/web/.env.local` and `apps/admin/.env.local` locally (`API_URL`); host environment variables when
  deployed. Mobile: `EXPO_PUBLIC_API_URL` in the EAS build profile (it is built into the app, so it must not be secret).
- **Environments:** all.
- **Development fallback:** yes. Web and admin default to `http://localhost:3000`; the mobile app uses the Expo dev
  server's computer and `EXPO_PUBLIC_API_PORT`.

### SMS provider (SMS_PROVIDER)

- **Purpose:** sending OTP codes.
- **Why needed:** production refuses `SMS_PROVIDER=fake`. The provider is an open decision in the spec, so no real
  adapter exists yet.
- **Provider:** your choice. Options with Pakistan delivery include Twilio Verify, Vonage, Infobip, or a local
  aggregator. Check PTA sender-ID registration requirements with the provider.
- **Steps:** open an account, register the sender ID, get the API key, then add an adapter implementing `SmsSender`
  (`send(phone, text)`) in `src/auth`, add its name to `SMS_PROVIDER` in `src/config.ts`, and its key as a new
  variable in `config.ts` and `.env.example`. It is a small class; the rest of the OTP flow is done and tested.
- **Where:** the key in the secrets manager.
- **Environments:** staging and production.
- **Development fallback:** yes. `SMS_PROVIDER=fake` prints codes in the API log, and `DEV_OTP_CODE=123456` fixes the
  code (refused in production).

### First admin (pnpm admin:create)

- **Purpose:** the admin panel has no public sign-up.
- **Steps:** on a machine with the production `DATABASE_URL` and `DOCUMENT_KEY`, run
  `pnpm admin:create <email> "<name>" owner`. It prints the password once (or reads `ADMIN_PASSWORD`) and the
  authenticator secret; add the secret to an authenticator app. Further admins are created the same way with the roles
  `super_admin`, `operations`, `finance` or `moderation`.
- **Development fallback:** yes. With `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD` and `DEV_TOTP_CODE` in `.env`,
  `pnpm db:seed` creates a local admin whose two-factor code is fixed (refused in production).

### Business decisions that are settings, not variables

These are marked OPEN in the spec and are already switches in `src/settings.ts` (overridable per country in the
`settings` table). Decide them before launch: CNIC at sign-up or before participation (`verification.required_at`),
full refund when a vendor cancels (`booking.vendor_cancel_full_refund`), billing no-shows (`billing.count_no_shows`),
the minor safeguards (`minors.*`), silence confirming a result (`result.silence_confirms`), and who receives
tournament fees (`tournament.fee_payee`). `billing.pay_to` is the text vendors see for paying SportsLink invoices.

---

## ⚠️ KNOWN LIMITATIONS

- **SMS:** no real provider yet (above). Sign-in in production needs the adapter.
- **Realtime:** chat and Find Players poll every few seconds; Socket.IO is not added. Redis runs in Docker but is not
  used yet.
- **Rate limit and jobs** run inside one API process (per-IP memory limit, 5-minute timer with an advisory lock).
  Several API instances are safe for jobs, but the rate limit is per instance.
- **Not built:** player subscriptions, ads and promo codes (need product decisions and app store billing), chat photos,
  voice notes and location pins, court photos, venue reliability scores, credit notes, device-based ban enforcement
  (devices are recorded), an admin screen to manage admins (the CLI does it), leaderboard caching.
- **Mobile:** vendor onboarding, venue photo upload, weekly bookings and analytics are on the web app only; mobile vendor
  mode covers the day-to-day calendar, payments and refunds.
- **Time zone:** a few web and mobile screens show times in Asia/Karachi, the launch market; bookings use each venue's
  own time zone. Revisit for a second country.
- **Payments** are direct transfers confirmed by the venue or admin by transaction ID, as decided. There is no gateway,
  so there is nothing to mock or configure.
- **Maps:** venue coordinates are typed in by the vendor; there is no map picker and no maps API key is needed.
- **Security review:** no external penetration test has been done yet. `docs/SECURITY.md` has the checklist.

---

## ▶️ HOW TO RUN

Requirements: Node.js 22, pnpm 9 (`npx -y pnpm@9.15.9` works without installing), Docker.

**API (`sport_link_be`)**

```bash
cp .env.example .env              # set DOCUMENT_KEY: openssl rand -base64 32
                                  # optional: DEV_OTP_CODE=123456, and the DEV_ADMIN_* lines for the admin panel
docker compose up -d              # PostGIS and Redis; change DB_PORT/REDIS_PORT/PORT in .env if ports are taken
pnpm install
pnpm db:migrate
pnpm db:seed                      # fake demo venue, vendor and sports
pnpm dev                          # http://localhost:3000/health, docs at /docs
```

**Web and admin (`sport_link_fe`)**

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/admin/.env.example apps/admin/.env.local   # set API_URL if the API is not on port 3000
pnpm install
pnpm --filter @sportslink/web --filter @sportslink/admin --parallel dev
# web http://localhost:3001, admin http://localhost:3002
```

**Mobile on your phone**

```bash
cp apps/mobile/.env.example apps/mobile/.env.local  # EXPO_PUBLIC_API_PORT = the API port
cd apps/mobile && npx expo start
```

Install Expo Go, join the same Wi-Fi as the computer, scan the QR code. Everything works in Expo Go except push on
Android; for push, make a development build: `npx expo install expo-dev-client`, then
`npx eas-cli build --profile development` (profiles are in `apps/mobile/eas.json`).

**Sign in during development:** any Pakistani mobile number, code `123456` (with `DEV_OTP_CODE`) or the code printed
in the API log. Demo vendor: `0300 0000001`. Admin: the `DEV_ADMIN_EMAIL` and `DEV_ADMIN_PASSWORD` from `.env`, code
`DEV_TOTP_CODE`. All demo data is fake.

**Regenerate the typed API client** after changing the API: with the API running,
`API_URL=http://localhost:3000 pnpm --filter @sportslink/api-client generate`.

---

## 🧪 HOW TO TEST

**Automated**

- Backend: `pnpm lint`, `pnpm typecheck`, `pnpm test` (rebuilds `sportslink_test` from migrations; about a minute),
  `pnpm build`. Covers the booking constraint under 25 parallel holds, payments, refunds, billing, admin, ratings
  (Glickman's example), teams, Find Players, tournaments, analytics, account changes and more.
- Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm --filter @sportslink/web --filter @sportslink/admin build`, and
  `npx expo-doctor` in `apps/mobile`.
- CI (`.github/workflows/ci.yml` in both repos) runs the same checks plus a secrets scan.

**By hand, in order**

1. Sign in on the web as a new number, fill the profile, upload a test ID image (not a real CNIC).
2. Admin panel: approve the ID under Identity checks.
3. Book a slot at Demo Arena, pay with a made-up transaction ID; sign in as `0300 0000001` and confirm it under
   Payments. Try a weekly booking from the venue page and an extension from My bookings.
4. Create a match from that booking, join from a second number, approve, chat, then (after the end time) add the
   result and confirm it from the other side. Check ratings on Rankings and the player profile.
5. Create two teams, challenge one from the other, accept.
6. Find Players: share location, turn on Available to play on a second account, send a request, accept, pick, chat.
7. Admin: create a free tournament, enter from two accounts, make the draw after the deadline, enter results.
8. Vendor: Analytics and reviews, revenue calculator; review the venue as the player after the booking ends.
9. Account: change the phone number using both codes; delete a spare account.

---

## 🚀 PRODUCTION CHECKLIST

- [ ] `NODE_ENV=production` on the API (turns off every development shortcut and the `/docs` page).
- [ ] Managed PostgreSQL with PostGIS, daily backups and point-in-time recovery; `pnpm db:migrate` in the deploy step.
- [ ] New `DOCUMENT_KEY` in a secrets manager, with a written plan for storing and rotating it.
- [ ] Private S3 bucket with encryption and a least-privilege role; `STORAGE_DRIVER=s3`.
- [ ] SMS provider adapter, sender ID registered, key in the secrets manager.
- [ ] `PUSH_PROVIDER=expo`, EAS project id committed, FCM and APNs credentials in Expo.
- [ ] HTTPS everywhere; `API_URL` and `EXPO_PUBLIC_API_URL` point at the HTTPS API; web and admin behind HTTPS.
- [ ] Admin panel on its own domain, ideally behind an IP allow-list or SSO; first owner admin created with the CLI.
- [ ] Decide the OPEN settings above and set them in the `settings` table.
- [ ] Set `billing.pay_to` to SportsLink's real payment details (not in code).
- [ ] One API instance, or add Redis-backed rate limiting before scaling out.
- [ ] Error monitoring and log collection on the API, web and admin (for example Sentry and the host's log drain).
- [ ] Run the CI secrets scan and `pnpm audit`; fix anything high or critical.
- [ ] External penetration test, especially ID documents, admin sign-in and payment confirmation.
- [ ] App store listings, privacy policy and terms (minors, ID documents, location), data deletion page for Google Play.
- [ ] Legal sign-off on guardian consent text (`minors.consent_version`).
