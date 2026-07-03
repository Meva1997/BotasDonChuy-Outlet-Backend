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
The admin CRUD lives in `src/routes/adminProduct.routes.ts` (mounted at `/api/admin/products`,
`router.use(requireAuth)` so every route needs a JWT) and reuses `product.controller.ts`
(`adminGetProducts`/`adminCreateProduct`/`adminUpdateProduct`/`adminDeleteProduct`). Unlike the
public reads it exposes non-visible rows and `unitCost`. Create/update validate the body with
`productSchema`/`productUpdateSchema` (zod) and write tallas/stock to `ProductSize` inside a
`sequelize.transaction`; `sizes` accepts a `"25,25,26"` string or a number array (each repeat =
one stock unit). `DELETE` soft-deletes (`deletedAt` + `visible:false`) when the product is
referenced by an `OrderItem`, otherwise hard-deletes (its `ProductSize` rows cascade).
**When adding a new resource, create `*.routes.ts` + `*.controller.ts` and mount the router
in `src/app.ts`.**

Because the seed inserts rows with explicit `id`s, Postgres SERIAL sequences are left behind;
`src/seed.ts` resyncs each one (`setval(pg_get_serial_sequence(table,'id'), MAX(id))`) at the
end of the transaction so later `id DEFAULT` inserts (e.g. `POST /api/admin/products`) don't
collide with seeded ids.

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

**Checkout** (`src/routes/order.routes.ts`, `src/controllers/order.controller.ts`,
`src/services/orders.service.ts`): `POST /api/orders` is **public** (mounted at `/api/orders`).
The body `{ items: [{ productId, size, quantity }], customer, shippingCarrier? }` is validated with
`createOrderSchema` (zod, `src/schemas/checkout.ts`). `orders.service.createOrder` does everything
inside a single `sequelize.transaction`: it **aggregates** duplicate `(productId, size)` lines,
processes them in deterministic `(productId, size)` order (deadlock avoidance), and for each line
runs an **atomic** `ProductSize.update({ stock: literal('stock - N') }, { where: { …, stock: { [Op.gte]: N } } })`
— if `affectedCount === 0` it throws `AppError(409)`, so concurrent buyers of the last unit get
exactly one `201` and one `409` (the size drops to stock 0). Totals are **recomputed server-side**
with the `cart` service (the client never sends amounts), and prices are **frozen** into each
`OrderItem` (`unitOriginalPrice`/`unitSalePrice`/`unitCost`/`nameSnapshot`). `createOrderSchema`
caps `quantity` at 99/item and `items` at 50/order (the real per-size limit is enforced by the
atomic decrement → `409`). `unitCost` is frozen in the row but **excluded from the public response**
(the order is reloaded with `attributes: { exclude: ['unitCost'] }` on `items`), matching the rule
that cost fields only appear on authenticated admin routes. Orders are created with
`status: "pending"` / `paymentStatus: "unpaid"`; the response is `{ order, clientSecret }`.

**Payments / Stripe seam** (Fase 8, wired but inert): `src/services/payment.service.ts` exposes
`createPaymentIntentForOrder` (returns `{ clientSecret: null, paymentIntentId: null }` today) and
`markOrderPaidFromWebhook`. `Order` has nullable `paymentIntentId` + `paymentStatus`
(`unpaid|processing|paid|failed`) columns for this. `POST /api/webhooks/stripe`
(`src/routes/webhook.routes.ts`) is a stub that flips the matching order to `paid`. The `stripe`
package is **not installed**; activating it (real PaymentIntent, webhook signature verification via
`express.raw`, releasing stock of abandoned `pending` orders) is deferred to Fase 8.

**Dashboard** (`src/routes/adminDashboard.routes.ts`, `src/routes/adminOrder.routes.ts`,
`src/controllers/dashboard.controller.ts`, `src/controllers/order.controller.ts`,
`src/services/dashboard.service.ts`): `GET /api/admin/dashboard` `[auth]` returns `DashboardData`
(`kpis`, `profitKpis`, `revenueByPeriod`, `recentSales`, `inventory`) computed **in memory** from
`Order`/`OrderItem`/`Product` — no aggregation tables. Only orders with `status: "paid"` count as
sales (not `paymentStatus`, which the seed leaves at `"unpaid"` — see `src/seed.ts`).
`kpis`/`profitKpis` use a rolling **30-day window** (`today-29d..today`) vs. the prior 30 days for
`trend`, so they stay numerically consistent with `revenueByPeriod["30"]` (same window, same
data). `revenueByPeriod` returns all three `"7"|"30"|"90"` series together (one `RevenuePoint` per
calendar day, including `$0` days — never skipped); day grouping (`isoDay`) and day-label
formatting (`formatShortDate`) are **both pinned to UTC** (`timeZone: "UTC"` on every
`toLocaleDateString`/`toLocaleTimeString` call) so the output doesn't depend on the host's local
timezone — omitting that option silently rolls the label back a day on hosts west of UTC (caught
during manual testing on a `America/Mexico_City` dev machine). `GASTOS FIJOS / MES` in
`profitKpis` is a hardcoded `$2,000.00` constant (`GASTOS_FIJOS` in `dashboard.service.ts`) since
there's no expenses model. `recentSales` caps at the 20 most recent paid orders; `savings`/`total`
per row reuse `Order.savings`/`Order.total` directly (already computed by the `cart` service at
checkout) rather than recomputing from items. `inventory` includes every non-soft-deleted product
(including `visible: false`) since inventory value must reflect real holdings regardless of
storefront visibility. `GET /api/admin/orders` `[auth]` (in `order.controller.ts`, alongside
`createOrder`) returns a **paginated** page of orders (`page`/`perPage`, default `perPage: 20`,
page clamped to `[1, totalPages]`) with their `items` included, most recent first, **without**
excluding `unitCost` (admin routes expose cost fields by design, like `adminGetProducts`). The
envelope is `{ orders, total, page, perPage, totalPages }`; `total` comes from a separate
`Order.count()` (no `include`) to avoid the inflated row count `findAndCountAll` returns with a
`hasMany` include, and the `limit` + `items` include relies on Sequelize's subquery so the limit
bounds orders (not joined rows) while items load in full.

**Reports** (`src/routes/adminReports.routes.ts`, `src/controllers/reports.controller.ts`,
`src/services/reports.service.ts`): mounted at `/api/admin/reports` (`router.use(requireAuth)`).
Both endpoints are computed **in memory** from a single shared fetch (`loadReportData`) of
`status: "paid"` orders (with `items`, `attributes` trimmed to `id`/`createdAt` on `Order` and
`productId`/`quantity` on `items` — the only fields the aggregation reads) + **all** products (with
`productSizes` via the shared `productSizesInclude` from `src/utils/productSizesInclude.ts` — also
reused by `dashboard.service.ts` and `product.controller.ts` — so the `Product.stock` virtual
resolves) — no aggregation tables. Since neither report can be time-windowed the way the dashboard's
90-day queries are (they cover full history by design), `loadReportData` caches its in-flight/settled
promise for `REPORT_CACHE_TTL_MS` (60s); a failed fetch clears the cache immediately instead of
repeating the error until the TTL expires. This keeps a single admin page load that hits both
`/monthly` and `/replenishment` back-to-back from scanning the full order history twice.
`loadReportData` deliberately includes soft-deleted (discontinued) products, since a product with
sales history is soft-deleted precisely because an `OrderItem` references it (see the admin CRUD
`DELETE` rule) — excluding them would erase their past sales from the monthly totals. `GET
/api/admin/reports/monthly` `[auth]` returns `MonthlyReport[]`: units sold are grouped by `(UTC
month, productId)` from `OrderItem.quantity`, then for **every** month in the range `[earliest
paid-order month … current UTC month]` (inclusive, no gaps — empty months emitted as `$0`, like
`revenueByPeriod` never skips days) it builds `byProduct`. `monthRange` clamps its start to `to` if
`from` is somehow after `to` (clock drift between DB/app, or a corrupt/future `createdAt`), so it
returns at least the current month instead of silently returning `[]`. Each month's `byProduct`
includes **every live product** (`unitsSold` 0 if unsold that month) **plus any discontinued product
that actually sold that month** (discontinued products don't appear as $0 rows in months without
activity, so they never clutter recent months); `revenue = unitsSold × Product.salePrice`, **current**
price not the frozen `OrderItem` price; sorted desc by `unitsSold`. `byCategory` (grouped by `type`,
`label` from a plural map replicating `frontend/lib/categories.ts`, sorted desc by revenue) is derived
from that `byProduct`, so discontinued sales flow into their category too. The month whose key equals
the current UTC month is flagged `partial: true` (`isoMonth`/`formatMonthLabel`/`utcMonthStart` live
in the shared `src/utils/date.ts`, alongside the dashboard's day-granularity equivalents
`isoDay`/`formatShortDate`/`utcDayStart` — both **UTC-pinned** for the same reason: `formatMonthLabel`
turns `toLocaleDateString`'s `"enero de 2026"` into the front's `"Enero 2026"`). `GET
/api/admin/reports/replenishment` `[auth]` returns `ReplenishmentRow[]` computed on-the-fly (never
persisted): per **live** product (discontinued ones are filtered out — you don't restock a
soft-deleted product) it feeds a monthly `unitsSold` series into `computeForecast`
(`src/services/forecast.ts`, the Fase 0 port). The series is built from **complete months only**
(`monthlyReports.filter(r => !r.partial)`) — except when there are **zero** complete months yet (the
store's first calendar month), where that rule would leave every series permanently empty and hide a
real day-one stockout for up to a month; in that one case the current partial month is used instead,
as a single low-confidence data point. The month range starts at the **whole store's** earliest paid
order, so a recently-added product would carry a tail of leading `$0` months from before it existed;
those are **trimmed** per product (`rawSeries.slice(firstSale)`, the series starts at its first month
with a sale) so the padding doesn't dilute the average or push a short-lived product into the
4+-month exponential-smoothing branch seeded at level 0 (understating demand). `$0` months **after**
the first sale are kept (real dry-month demand signal); a product that never sold gets an empty
series → `computeForecast` returns `0`/"Sin datos". `computeForecast`'s `forecastNextMonth` is
rounded to an integer, which can round a real-but-thin demand (e.g. ~0.4 units/month) down to `0`; an
`effectiveForecast` (the raw average of the trimmed series) is used as a floor whenever that happens,
so `diasCobertura`/`suggestedOrder` don't fall back to the "no sales" sentinel for a product that
actually has sales history and zero stock — `forecastNextMonth` in the response still reports the
raw (possibly-`0`) rounded forecast. From that it derives `diasCobertura`
(`round(stock / effectiveForecast × 30)`, `999` sentinel only when there's neither a rounded forecast
nor sales history), `suggestedOrder` (`max(0, round(effectiveForecast × 2) − stock)`, i.e. a 2-month
target minus stock), `ingresoMensual`/`margenMensual` (from the avg of the trimmed complete-month
series × price/margin), `costoEstimadoPedido`, and `priority` (`urgente` <15 días · `pronto` <45 ·
`ok`). Rows are sorted by priority rank (`urgente < pronto < ok`) then `margenMensual` desc. Rounding
mirrors the frontend mock exactly: `ingresoMensual`/`margenMensual`/`diasCobertura`/`suggestedOrder`/
`forecastNextMonth` are integers, while `revenue`/`totalRevenue`/`costoEstimadoPedido` are left raw.
Per the ROADMAP, the backend serves only the raw monthly + replenishment rows; derived metrics (%
del total, promedios, tendencia vs mes anterior) are computed by the frontend. Cost fields
(`unitCost`, `margenMensual`, `costoEstimadoPedido`) appear here because these are authenticated
admin routes. The per-product series extraction transposes each month's `byProduct` into a
`Map<productId, unitsSold>` once (`unitsByMonthMaps`) rather than doing a `.find()` per
product×month pair, keeping it O(months×products) instead of O(months×products²).

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
