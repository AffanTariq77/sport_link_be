# SportsLink API

Backend for SportsLink: venue booking, matches, Find Players, ratings and tournaments.
NestJS 12, PostgreSQL 16 with PostGIS, Drizzle ORM, TypeScript (ESM).

## Requirements

Node.js 22 or later, pnpm 9, Docker.

## Getting started

```bash
cp .env.example .env        # then set DOCUMENT_KEY: openssl rand -base64 32
docker compose up -d        # Postgres with PostGIS, Redis, plus a sportslink_test database
pnpm install
pnpm db:migrate
pnpm db:seed                # fake demo data only
pnpm dev                    # http://localhost:3000/health, API docs at /docs
```

If ports 5432, 6379 or 3000 are taken, set `DB_PORT`, `REDIS_PORT` and `PORT` in `.env` (and the matching
`DATABASE_URL`).

### Development sign-in

- Players: any Pakistani mobile number. Codes print in the API log; set `DEV_OTP_CODE=123456` in `.env` to use a
  fixed code.
- Demo vendor (from the seed): `0300 0000001`.
- Admin panel: set `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD` and `DEV_TOTP_CODE` in `.env` and run `pnpm db:seed`, or
  create a real admin with `pnpm admin:create <email> "<name>" <role>` (prints the authenticator secret).

The development codes are refused when `NODE_ENV=production`.

## Scripts

| Script                        | What it does                                                  |
| ----------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                    | Compile in watch mode and restart on change                   |
| `pnpm build` / `pnpm start`   | Production build and run                                      |
| `pnpm test`                   | Rebuild the test database from migrations, then run all tests |
| `pnpm lint`, `pnpm typecheck` | ESLint and TypeScript checks                                  |
| `pnpm db:generate`            | Create a migration from changes to `src/db/schema.ts`         |
| `pnpm db:migrate`             | Apply migrations                                              |
| `pnpm db:seed`                | Load fake demo data (refuses to run in production)            |
| `pnpm admin:create`           | Create an admin with a password and two-factor secret         |

## Layout

```
src/
  main.ts, app.module.ts, config.ts, settings.ts
  db/          schema.ts (all tables), client, migrate, seed
  bookings/    booking engine: holds, manual bookings, blocks, pricing
  health/      health check
drizzle/       SQL migrations (0000 extensions, 0001 schema, 0002 hand-written constraints)
test/          database tests against sportslink_test
```

## Migrations

After changing `src/db/schema.ts`, run `pnpm db:generate` and review the SQL. drizzle-kit wraps the
PostGIS type in quotes (`"geography(Point, 4326)"`); remove the quotes before committing.
Constraints Drizzle cannot express go in a custom migration: `pnpm drizzle-kit generate --custom --name <name>`.
