<!-- @author Shuja naqvi -->
# API Boilerplate (NestJS + TypeORM)

A NestJS API boilerplate: modular structure, base repositories, global exception filter, JWT auth, versioned routes, and TypeORM with PostgreSQL.

---

## Purpose

This boilerplate exists to give the team **one shared starting point** and a **clear path** for building backend APIs.

- **Why it exists**  
  New services should not reinvent structure, auth, error handling, or database patterns. This repo encodes the same architecture and conventions used in our existing APIs (e.g. FanFood-style NestJS + TypeORM), so every new project starts with the same foundations.

- **What it gives the team**
  - **Consistency** — Same folder layout, naming, and patterns across services.
  - **Speed** — No “where do I put this?” or “how do we do errors?” — follow the sample `item` module and the README.
  - **Quality** — Lint, tests, and pre-commit hooks are already wired; the team just extends them.

- **Clear path for the team**
  1. **Onboard** — Clone, install, run; read “Project structure” and “Adding a new feature module” below.
  2. **Build** — Add feature modules (controller, service, repository, entity, DTOs) using the `item` module as the template.
  3. **Ship** — Use the same patterns (versioned routes, validation, error responses, auth) so clients and other teams know what to expect.

Use this repo as the base for new NestJS APIs so the whole team walks the same path from day one.

---

## Features

- **NestJS 8** with TypeScript
- **TypeORM** with PostgreSQL (entities, custom repositories, pagination)
- **Global patterns**: `GlobalExceptionFilter`, `ValidationPipe`, request ID, request logging
- **Auth**: JWT guard with `@Public()` for unauthenticated routes
- **API versioning**: URI versioning (e.g. `/api/v1/items`)
- **Sample feature module**: `Item` (CRUD) with controller, service, repository, entity, DTOs, authorizer
- **Testing**: Jest unit tests, e2e tests, Fishery factories
- **Code quality**: ESLint, Prettier, pre-commit (lint + test)

## Local setup

### Prerequisites

- [Node.js](https://nodejs.org) (v16+)
- PostgreSQL (local or Docker)
- (Optional) Redis if you add Bull/cache later

### Install and run

```bash
# Clone and enter the repo
cd localpay-api-Main-Nest

# Install dependencies
npm install

# Configure database (default: postgres/postgres@localhost:5432)
# Edit ormconfig.json or use env vars as needed.

# Run in development
npm run serve:dev
```

- API base: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`
- Sample resource: `http://localhost:3000/api/v1/items`

### PostgreSQL with Docker

```bash
docker run -d \
  --name postgres \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:13
```

## Scripts

| Script           | Description                    |
|-----------------|--------------------------------|
| `npm run serve:dev`  | Start dev server (ts-node-dev) |
| `npm run serve:prod`| Build and run production       |
| `npm run build`     | Compile TypeScript             |
| `npm run lint`      | Run ESLint                     |
| `npm run lint:fix`  | ESLint with auto-fix           |
| `npm run test`      | Run unit tests                 |
| `npm run test:cov`  | Unit tests with coverage       |
| `npm run e2e`       | Run e2e tests                 |
| `npm run typeorm`   | TypeORM CLI                    |

## Project structure

```
src/
├── app.module.ts
├── main.ts
├── config.ts
├── auth/                 # JWT strategy, guard, @Public()
├── common/                # base-entity, base-repository, filters, pipes, decorators
├── core/                  # Global module (Http, Schedule)
├── database/migrations/  # TypeORM migrations
├── health/                # Health check controller
├── item/                  # Sample feature module
│   ├── controller/
│   ├── dto/
│   ├── entity/
│   ├── repository/
│   └── service/
├── logger/                # Winston + request logger + query logger
├── response-types/        # DTOs for API responses
├── security/              # Roles, authorizer interface
└── public/                # Static assets
e2e/                       # E2E tests
test/factories/            # Fishery factories for tests
```

## Purpose of everything inside `src/`

| Path | Purpose |
|------|--------|
| **`app.module.ts`** | Root Nest module: wires TypeORM, Winston, Auth, Health, Item, and shared config. Add new feature modules here. |
| **`main.ts`** | App bootstrap: global prefix `api`, versioning, request ID, body size, ValidationPipe, GlobalExceptionFilter, JWT guard, request logger. |
| **`config.ts`** | Central config: merges defaults with env (e.g. JWT, CORS). Single place to add new env-driven settings. |
| **`auth/`** | Authentication and public routes. |
| `auth/auth.module.ts` | Registers JWT + Passport; exports for use by other modules. |
| `auth/decorators/public.decorator.ts` | `@Public()` — marks routes that skip JWT (e.g. health, public GET). |
| `auth/guards/jwt-auth-guard.ts` | Global guard: requires JWT unless `@Public()`. Attaches user to request. |
| `auth/strategies/jwt.strategy.ts` | Passport JWT strategy: validates token and returns payload (id, email, role). |
| `auth/interfaces/jwt-payload.interface.ts` | Shape of the JWT payload used in the app. |
| **`common/`** | Shared building blocks used across feature modules. |
| `common/base-entity.ts` | TypeORM base entity: `id` (uuid), `createdTime`, `modifiedTime`. Extend this for all entities. |
| `common/base-repository.ts` | Base repo: `findById`, `findMany`, `paginate`. Use for non–soft-delete entities. |
| `common/custom-repository.ts` | Like base repo but filters out `isDeleted: true`. Use for soft-delete entities. |
| `common/global-exception.filter.ts` | Catches all errors; returns `{ statusCode, timestamp, message, error?, messages? }` and logs. |
| `common/pagination-decorator.ts` | `@Pagination()` — reads `limit` and `page` from query and returns `IPaginationOptions`. |
| `common/decorators/response-type.decorator.ts` | `@ResponseType(DtoClass)` — serializes response with class-transformer (e.g. `@Expose()` only). |
| `common/pipes/is-required.pipe.ts` | Validates that a query/param is present; throws BadRequestException if missing. |
| `common/pipes/validate-array.pipe.ts` | Validates query arrays against a set of allowed values (e.g. enum values). |
| `common/user-decorator.ts` | `@RequestUser()` — param decorator to get the current user from the request (set by JWT guard). |
| `common/utils.ts` | Shared helpers (e.g. `isDefined`). Add small, reusable utils here. |
| **`core/`** | Global app-wide services (HTTP client, scheduling). Imported once in `AppModule`. |
| `core/core.module.ts` | Registers HttpModule and ScheduleModule; marked `@Global()` so they are available everywhere. |
| **`database/migrations/`** | TypeORM migration files. Run with `npm run typeorm migration:run`. |
| **`health/`** | Readiness/liveness for load balancers and orchestration. |
| `health/health.module.ts` | Wires Terminus and the health controller. |
| `health/controller/health.controller.ts` | `GET /api/health` — pings DB (and can be extended for Redis, etc.). Uses `@Public()`. |
| **`item/`** | Sample feature module — use as the template for new domains (e.g. orders, users). |
| `item/item.module.ts` | Registers Item entity/repository, ItemService, ItemAuthorizer, ItemController. |
| `item/controller/item.controller.ts` | REST: list (paginated), get by id, create, update, delete. Uses `@ResponseType`, `Pagination()`, `@Public()` where needed. |
| `item/service/item.service.ts` | Business logic: findAll, findOne, create, update, delete (soft delete via `isDeleted`). |
| `item/service/item.authorizer.ts` | `assertCanAccess(itemId, privilege)` — use before mutations/reads that need permission checks. |
| `item/repository/item.repository.ts` | TypeORM custom repository for Item (soft delete). |
| `item/entity/item.ts` | Item table: name, description, active, isDeleted; extends BaseEntity. |
| `item/dto/create-item.dto.ts` | Request body DTO for creating an item (class-validator). |
| `item/dto/update-item.dto.ts` | Request body DTO for updating an item (all fields optional). |
| **`logger/`** | Structured logging for the app and TypeORM. |
| `logger/logger.ts` | Winston root logger and options (format, level by env). |
| `logger/request-logger.ts` | Morgan middleware: logs each HTTP request as JSON (endpoint, status, time, etc.). |
| `logger/query-logger.ts` | TypeORM logger: forwards query/slow-query/error logs to Winston. |
| **`response-types/`** | DTOs used only for **serializing** API responses (with `@Expose()`). |
| `response-types/base-response.dto.ts` | Base response DTO with `id`. Others extend this. |
| `response-types/item-response.dto.ts` | Fields exposed for a single Item in responses. |
| `response-types/pagination-response.dto.ts` | Paginated list shape (e.g. `ItemPaginationResponseDto`: items, itemCount, pageCount, totalItems). |
| **`security/`** | Roles and permission contracts used by authorizers. |
| `security/roles.ts` | Enums: `UserRole`, `OperationPrivilege`. Extend for your app’s roles. |
| `security/authorizer.interface.ts` | `IAuthorizer.assertCanAccess(id, privilege)` — implement per resource for access control. |
| **`public/`** | Static files served by Express (e.g. images, docs). Put files here to serve at `/api/...`. |

---

## Adding a new feature module

1. Create folder `src/<module>/` with:
   - `entity/<name>.ts` (extends BaseEntity or uses CustomRepository pattern with `isDeleted`)
   - `repository/<name>.repository.ts` (extends CustomRepository or BaseRepository)
   - `dto/create-*.dto.ts`, `dto/update-*.dto.ts` (class-validator)
   - `service/<name>.service.ts`, optional `service/<name>.authorizer.ts`
   - `controller/<name>.controller.ts` (use `@ResponseType(ResponseDto)` and `Pagination()`)
2. Register in `app.module.ts`: `TypeOrmModule.forFeature([...])`, providers, controllers.
3. Add response DTOs in `src/response-types/` if needed.

## Database migrations

```bash
# Create a new migration
npm run typeorm migration:create -- -n YourMigrationName

# Run migrations
npm run typeorm migration:run

# Revert last migration
npm run typeorm migration:revert
```

With `synchronize: true` in `ormconfig.json`, schema is synced on startup (suitable for local/dev). Disable it in production and use migrations only.

## Commit hooks

The project uses the `pre-commit` package. On each commit it runs:

- `npm run lint`
- `npm run test`

Configured in `package.json` under `"pre-commit": ["lint", "test"]`.

## Code style (enforced by ESLint)

The boilerplate enforces a consistent style so the team stays aligned.

| Rule | What it does |
|------|----------------|
| **Variable declarations** | Prefer `const` when a variable is never reassigned. Use `let` only when you must reassign. Avoid `var`. |
| **Functions: arrow-style** | Use **arrow functions** (or `const name = () => {}`) instead of `function name() {}`. Class methods stay as usual; this applies to standalone helpers, bootstrap, and exported functions. |

**Examples**

- Prefer: `const bootstrap = async (): Promise<void> => { ... };`
- Avoid: `async function bootstrap(): Promise<void> { ... }`

- Prefer: `export const requestLogger = (): ReturnType<typeof morgan> => { ... };`
- Avoid: `export function requestLogger(): ReturnType<typeof morgan> { ... }`

- Prefer: `const result = items.map((x) => x.id);`
- Prefer: `const value = getValue();` (use `const` if you don’t reassign).

These are enforced by ESLint (`prefer-const`, `func-style`). Run `npm run lint` to check; fix with `npm run lint:fix` where possible.

## References

- [NestJS](https://docs.nestjs.com)
- [TypeORM](https://typeorm.io)
- [class-validator](https://github.com/typestack/class-validator)
- [class-transformer](https://github.com/typestack/class-transformer)
