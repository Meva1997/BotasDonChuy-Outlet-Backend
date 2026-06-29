# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project uses **pnpm** (`packageManager: pnpm@11.8.0`).

- `pnpm install` — install dependencies
- `pnpm dev` — run the server in watch mode via `ts-node-dev` (entry: `src/app.ts`)
- `pnpm build` — compile TypeScript to `dist/` via `tsc`
- `pnpm start` — run the compiled build (`node dist/app.js`)

There is no test runner or linter configured yet (`pnpm test` is a placeholder that exits 1).

## Architecture

Express 5 + TypeScript REST API backed by PostgreSQL through Sequelize 6. It is the backend
for the "Botas Don Chuy Outlet" store (products of type `bota`, `sombrero`, or `ropa`).

**Startup flow** (`src/app.ts`): loads env via `dotenv` → creates the Express app → calls
`connectDB()` → registers global middleware (`helmet`, `cors` with `CORS_ORIGIN`, JSON and
urlencoded body parsers) → mounts Swagger UI at `/api/docs` (+ raw spec at `/api/docs.json`) →
mounts the routers → exposes `GET /health` → listens on `PORT` (default `4000`).
The app `export default`s for testability.

**Database** (`src/config/database.ts`): a single shared `sequelize` instance built from
`DATABASE_URL` (postgres dialect, connection pool max 5). `connectDB()` authenticates and,
**only when `NODE_ENV === "development"`**, runs `sequelize.sync({ alter: true })` to reshape
tables to match the models without dropping data. SQL logging is also gated on development.
On any connection error the process exits with code 1.

**HTTP layer** (`src/routes/`, `src/controllers/`): routers are mounted in `src/app.ts`
under a base path (e.g. `app.use("/api/products", productRoutes)`). Each route file builds an
Express `Router` and delegates to handlers in the matching `*.controller.ts`. Product reads
only expose rows with `visible: true` and exclude the `unitCost` field via Sequelize
`attributes: { exclude: [...] }`. `GET /api/products` does filtering (`categoria` → `type`,
`talla` → membership in `sizes`) and pagination (`page`/`perPage`, page clamped to
`[1, totalPages]`) in memory after the query, and also returns `availableSizes`.
**When adding a new resource, create `*.routes.ts` + `*.controller.ts` and mount the router
in `src/app.ts`.**

**API docs** (`src/config/swagger.ts`): `swagger-jsdoc` builds an OpenAPI 3.0 spec from a base
`definition` (info, `servers`, `bearerAuth` security scheme, reusable `components.schemas` like
`Product`, `LoginInput`, `Error`) plus JSDoc `@openapi` annotations read from the `apis` globs
(`./src/routes/*.ts` + `./src/app.ts` in dev, and the `./dist/...` equivalents for the compiled
build — both run with cwd at the backend root). `src/app.ts` serves the interactive UI with
`swagger-ui-express` at `/api/docs` (no `NODE_ENV` gate — exposed in all environments) and the
raw JSON at `/api/docs.json`. **When adding a new resource, document each endpoint with an
`@openapi` JSDoc block above its `router.<method>(...)` in `*.routes.ts`, referencing shared
schemas via `$ref: '#/components/schemas/...'` (add new schemas to `src/config/swagger.ts`).**

**Auth** (`src/routes/auth.routes.ts`, `src/controllers/auth.controller.ts`): mounted at
`/api/auth`. `POST /api/auth/login` validates the body with `loginSchema` (zod), looks up
`AdminUser` by email, compares bcrypt hash, and returns `{ token, user }`. `POST /api/auth/forgot-password`
always returns `{ ok: true }`. `GET /api/auth/me` is protected by `requireAuth` and returns
the decoded `{ user }`. Both `/login` and `/forgot-password` are gated behind `authRateLimiter`
(10 req / 15 min). `requireAuth` (`src/middlewares/requireAuth.ts`) extracts the Bearer token,
verifies it with `JWT_SECRET`, and attaches `req.user: AuthUser`. `requireRole(...roles)`
checks `req.user.role` and throws `403` if the role isn't in the list.

**Error handling** (`src/middlewares/`): `asyncHandler` wraps async controller functions so
thrown/rejected errors are forwarded to Express's error pipeline instead of needing try/catch
in each controller. Controllers throw `AppError(message, statusCode)` for expected failures
(e.g. 404s). `errorHandler` is registered last in `src/app.ts` and maps `ZodError`,
Sequelize's `UniqueConstraintError`/`ValidationError`, and `AppError` to JSON responses with a
Spanish `message`; anything else falls back to a logged 500.
**When adding a new resource, use `asyncHandler` for its controller handlers and throw
`AppError` for expected error cases instead of returning ad-hoc status codes.**

**Models** (`src/models/`): models import the shared `sequelize` instance and call
`Model.init(...)`. A model only gets its table created/synced if it is imported somewhere in
the startup path — `src/app.ts` does `import "./models/Product"` (and the same for every other
model) specifically to register it. Cross-model relations (`hasMany`/`belongsTo`) live in
`src/models/associations.ts`, also side-effect imported from `src/app.ts`.
**When adding a new model, add a matching side-effect import in `src/app.ts`, and declare its
associations (if any) in `associations.ts`.**

The `Product` model stores `DECIMAL(10,2)` money fields (`originalPrice`, `salePrice`,
`unitCost`) with custom getters that `parseFloat` the values so the API returns numbers rather
than strings. `type` is a Postgres ENUM (`bota | sombrero | ropa`) — Postgres-specific, so the
database must be PostgreSQL. `discountPercent`, `stock`, and `sizes` are all `VIRTUAL` fields:
`discountPercent` is derived from the two prices, while `stock` (total) and `sizes` (repeated
per unit, e.g. `[25, 25, 26]`) are derived from the `ProductSize` association (`productId`,
`size`, `stock`, unique per `(productId, size)`) — the real source of truth for stock per size.
Controllers must `include` the `productSizes` association for `stock`/`sizes` to resolve;
without it they default to `0`/`[]`. `Order` holds a frozen snapshot of totals and shipping
data; `OrderItem` freezes per-unit prices (`unitOriginalPrice`, `unitSalePrice`, `unitCosto`) so
historical orders aren't affected by later `Product` price changes. `AdminUser` and
`BrandSettings` (singleton) round out the Fase 1 data model. `src/seed.ts` (`pnpm seed`)
populates all of the above from the frontend's mock data.

## Conventions

- TypeScript runs in `strict` mode with decorators enabled (`experimentalDecorators`,
  `emitDecoratorMetadata`); source in `src/`, output in `dist/`.
- Configuration comes exclusively from environment variables (`PORT`, `NODE_ENV`,
  `DATABASE_URL`, `CORS_ORIGIN`, `JWT_SECRET`, `JWT_EXPIRES_IN`, plus Cloudinary keys).
  `.env` is gitignored — never commit it.
- Dependencies wired in: `jsonwebtoken` + `bcrypt` (auth), `zod` (validation),
  `express-rate-limit` (auth routes), `swagger-jsdoc` + `swagger-ui-express` (API docs).
  Dependencies installed but not yet wired: `cloudinary` + `multer` +
  `multer-storage-cloudinary` (image uploads — Fase 3+).
  Prefer these existing libraries when implementing those features.
- `pnpm-workspace.yaml` holds the pnpm `allowBuilds` map (decides which dependency lifecycle
  scripts may run, e.g. `bcrypt: true`, `@scarf/scarf: false`). pnpm v11 errors on undecided
  build scripts, so new deps with install scripts must be resolved via `pnpm approve-builds`.

## Workflow

- **Before pushing to GitHub** (any commit/push the user requests): always verify that
  `README.md` and this `CLAUDE.md` are up to date with the changes being committed, and update
  them if needed, before running the commit/push.
- **Whenever a commit/push adds or changes routes** (new `*.routes.ts`, a new `router.<method>`,
  or a changed path/params/response): the Swagger documentation MUST be written/updated first —
  add an `@openapi` JSDoc block for each new or changed endpoint (and any new
  `components.schemas` in `src/config/swagger.ts`) — before running the commit and push.
