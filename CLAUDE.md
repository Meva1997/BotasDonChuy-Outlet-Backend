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
urlencoded body parsers) → exposes `GET /health` → listens on `PORT` (default `4000`).
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

**Models** (`src/models/Product.ts`): models import the shared `sequelize` instance and call
`Model.init(...)`. A model only gets its table created/synced if it is imported somewhere in
the startup path — `src/app.ts` does `import "./models/Product"` specifically to register it.
**When adding a new model, add a matching side-effect import in `src/app.ts`.**

The `Product` model stores `DECIMAL(10,2)` money fields (`originalPrice`, `salePrice`,
`unitCost`) with custom getters that `parseFloat` the values so the API returns numbers rather
than strings. `type` is a Postgres ENUM (`bota | sombrero | ropa`) and `sizes` is an
`ARRAY(INTEGER)` — both are Postgres-specific, so the database must be PostgreSQL.

## Conventions

- TypeScript runs in `strict` mode with decorators enabled (`experimentalDecorators`,
  `emitDecoratorMetadata`); source in `src/`, output in `dist/`.
- Configuration comes exclusively from environment variables (`PORT`, `NODE_ENV`,
  `DATABASE_URL`, `CORS_ORIGIN`, plus Cloudinary keys). `.env` is gitignored — never commit it.
- Dependencies present but not yet wired in: `jsonwebtoken` + `bcrypt` (auth), `zod`
  (validation), `cloudinary` + `multer` + `multer-storage-cloudinary` (image uploads),
  `express-rate-limit`. Prefer these existing libraries when implementing those features.

## Workflow

- **Before pushing to GitHub** (any commit/push the user requests): always verify that
  `README.md` and this `CLAUDE.md` are up to date with the changes being committed, and update
  them if needed, before running the commit/push.
