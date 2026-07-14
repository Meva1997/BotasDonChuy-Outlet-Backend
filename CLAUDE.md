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
`AdminUser` by email, compares bcrypt hash, and returns `{ token, user }`. `GET /api/auth/me` is
protected by `requireAuth` and returns the decoded `{ user }`. `/login`, `/forgot-password`,
`/verify-reset-code` and `/reset-password` are all gated behind `authRateLimiter`
(10 req / 15 min). `requireAuth` (`src/middlewares/requireAuth.ts`) extracts the Bearer token,
verifies it with `JWT_SECRET`, and attaches `req.user: AuthUser`. `requireRole(...roles)`
checks `req.user.role` and throws `403` if the role isn't in the list.

**Password reset via 5-digit code** (Fase 9.2 — `auth.controller.ts`, `src/utils/resetCode.ts`):
the forgot-password flow uses a **5-digit numeric code** emailed to the user (not a reset link).
`AdminUser` carries three nullable columns for it: `resetPasswordCodeHash` (sha256 of the code —
never stored in clear; sha256 not bcrypt because the code is short-lived, single-use, and
attempt-limited), `resetPasswordExpiresAt` (now + `RESET_CODE_TTL_MINUTES`, 15), and
`resetPasswordAttempts` (counter). All three are **excluded from `GET /api/admin/users`** alongside
`passwordHash`. `POST /api/auth/forgot-password` validates with `forgotPasswordSchema`, and **if
the email exists** generates a code (`crypto.randomInt(0,100000)` padded to 5 digits), stores its
hash + expiry (attempts reset to 0), and emails it via `email.service`; it **always** returns
`{ ok: true }` (exists or not) so it never reveals whether an email is registered. `POST
/api/auth/verify-reset-code` (`{ email, code }`) validates the code but **does not consume it** —
it only unlocks the frontend's reset page; the real security is at reset. `POST
/api/auth/reset-password` (`{ email, code, newPassword, confirmPassword }`, `resetPasswordSchema`
enforces the same password complexity as `loginSchema`) **re-validates** the code, updates the
`passwordHash`, and clears the three reset columns (single-use). A shared `assertValidResetCode`
helper backs both endpoints: it rejects (generic `400 "Código inválido o expirado"`) when the
user/code is missing, expired, or over `RESET_CODE_MAX_ATTEMPTS` (5), and on a wrong code it
increments `resetPasswordAttempts` (burning the code once the max is hit) — the error message is
identical for missing-email/wrong-code/expired so none of them is distinguishable. This flow is
**independent** of `PUT /api/admin/account` (which requires `currentPassword`); the reset path
needs no current password precisely because the user forgot it.

**Emails / Resend** (Fase 9.1 — `src/config/resend.ts`, `src/services/email.service.ts`,
`src/services/email/templates/`): transactional emails go through **Resend**.
`src/config/resend.ts` (its own `dotenv.config()` at module top, like `stripe.ts`/`cloudinary.ts`)
**hard-requires** `RESEND_API_KEY` **and** `EMAIL_FROM` (throws at startup if either is missing —
side-effect imported from `app.ts` for fail-fast) and exports the shared `resend` client,
`EMAIL_FROM`, and `FRONTEND_URL`. `src/services/email.service.ts` exposes `sendEmail({ to, subject,
html, idempotencyKey? })` wrapping `resend.emails.send(...)`; it **logs but never throws** — the
Resend SDK returns `{ data, error }` (it doesn't throw on API errors), so the wrapper handles both
the returned `error` **and** a network exception via try/catch, and returns in both cases. A failed
email must never take down the request that triggered it (forgot-password, checkout, Stripe
webhook) — ROADMAP §6. HTML templates live in `src/services/email/templates/` as plain functions
returning a string (no template engine); the first is `passwordResetCodeTemplate({ code, name? })`.
**Domain caveat:** without a verified domain, `EMAIL_FROM` must be `onboarding@resend.dev` and
Resend only delivers to the account owner's address (`403` to anyone else — swallowed by
`sendEmail`); production needs a verified domain (manual DNS step, no code).

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

**Payments / Stripe** (Fase 8, activo — solo Stripe; Skydropx sigue diferido): the `stripe`
package is installed and configured in `src/config/stripe.ts` (its own `dotenv.config()` at module
top, like `database.ts`, since imports run before `app.ts`'s `dotenv.config()`). That module
**hard-requires** `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` (throws at startup if either
is missing — no inert fallback) and exports the shared `stripe` client, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_CURRENCY` (default `"mxn"`), and the sweeper knobs `PENDING_ORDER_TTL_MINUTES` (30) /
`PENDING_ORDER_SWEEP_INTERVAL_MINUTES` (10). Keys are **test/sandbox** for now. `Order` carries the
nullable `paymentIntentId` + `paymentStatus` (`unpaid|processing|paid|failed`) columns.

`src/services/payment.service.ts`: `createPaymentIntentForOrder(order)` creates a **real**
PaymentIntent (`amount: Math.round(order.total * 100)` cents, `currency: STRIPE_CURRENCY`,
`metadata.orderId`, `automatic_payment_methods`) and returns `{ clientSecret, paymentIntentId }`;
`order.controller.ts`'s `createOrder` persists that `paymentIntentId` (+ `paymentStatus:
"processing"`) on the order and returns the `clientSecret` to the client. `markOrderPaidFromWebhook`
(→ `paid`) and `markOrderPaymentFailed` (→ `paymentStatus: "failed"`, keeps `status: "pending"` so a
transient decline can be retried on the same PaymentIntent) are **idempotent** and **tolerant of a
missing order** (log + return, never `throw`, so a verified event always 200s and Stripe doesn't
retry in a loop).

`POST /api/webhooks/stripe` (`src/routes/webhook.routes.ts` → `stripeWebhook`): mounted in
`src/app.ts` with `express.raw({ type: "application/json" })` **before** the global
`express.json()` (so `req.body` is the raw `Buffer` that `stripe.webhooks.constructEvent` needs to
verify the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`). A missing/invalid signature
returns **400** (Stripe won't count it as delivered); any verified event returns `{ received: true }`
(200) even when unhandled, to avoid retry loops. Handled events: `payment_intent.succeeded` →
`markOrderPaidFromWebhook`; `payment_intent.payment_failed` → `markOrderPaymentFailed`;
`payment_intent.canceled` → `releaseOrderStock` (restock + `cancelled`). **Postgres note:** `express`
raw parsing means the webhook route must be mounted before `express.json()`, not after.

`orders.service.releaseOrderStock(orderId)` is the exact inverse of `createOrder`'s atomic stock
decrement: in a transaction it locks the `Order` row **alone** (`FOR UPDATE` — *not* with the `items`
include, since Postgres rejects `FOR UPDATE` on the nullable side of the `items` LEFT JOIN), loads
its `OrderItem`s separately, `ProductSize.update({ stock: literal('stock + N') })` per line, and sets
`status: "cancelled"` / `paymentStatus: "failed"`. It's **idempotent** (only acts while `status ===
"pending"`) and **never restocks a paid order**, so the webhook `canceled` path and the sweeper can't
double-restock. `src/services/pendingOrderSweeper.ts` (`startPendingOrderSweeper`, started from
`app.ts` after `connectDB()`; skipped when `NODE_ENV === "test"`, timer `unref()`ed) runs every
`PENDING_ORDER_SWEEP_INTERVAL_MINUTES`, finds `pending` orders older than
`PENDING_ORDER_TTL_MINUTES` with a `paymentIntentId`, and **reconciles each against Stripe**
(`retrieve`): if the PaymentIntent is `succeeded` it marks the order `paid` (recovers a missed
webhook), otherwise it cancels the PaymentIntent and calls `releaseOrderStock`.

**Dashboard** (`src/routes/adminDashboard.routes.ts`, `src/routes/adminOrder.routes.ts`,
`src/controllers/dashboard.controller.ts`, `src/controllers/order.controller.ts`,
`src/services/dashboard.service.ts`): `GET /api/admin/dashboard` `[auth]` returns `DashboardData`
(`kpisByPeriod`, `profitKpisByPeriod`, `revenueByPeriod`, `recentSales`, `inventory`) computed **in
memory** from `Order`/`OrderItem`/`Product` — no aggregation tables. Only orders with
`status: "paid"` count as sales (not `paymentStatus`, which the seed leaves at `"unpaid"` — see
`src/seed.ts`). `kpisByPeriod`/`profitKpisByPeriod` follow the same shape as `revenueByPeriod`: all
three `"7"|"30"|"90"` windows computed together in one response (no query param — the frontend
alternates client-side in `DataSection`), via `buildKpisForWindow(dailyAgg, windowDays, todayStart)`.
Per-order aggregation (revenue/COGS/pieces/order-count) is folded into a single day-bucketed pass
(`buildDailyAggregates` → `Map<isoDay, DayAggregate>`) so each order's `unitCost` is summed once
instead of being re-scanned per KPI window; each window (and its prior comparison window) then sums
straight from that map — the same UTC-day-bucket the revenue series uses. Each window's `trend`
compares against its own equal-length prior window (e.g. `"90"`
compares `today-89d..today` vs. the 90 days before that), which is why the shared order fetch
(`ordersHistory`) reaches back `2 * REVENUE_WINDOW_DAYS` (180) days — the widest KPI window (90)
needs a full prior 90-day period behind it for the comparison, not just the 90 days `revenueByPeriod`
itself displays. `revenueByPeriod` returns all three `"7"|"30"|"90"` series together (one
`RevenuePoint` per calendar day, including `$0` days — never skipped); day grouping (`isoDay`) and
day-label formatting (`formatShortDate`) are **both pinned to UTC** (`timeZone: "UTC"` on every
`toLocaleDateString`/`toLocaleTimeString` call) so the output doesn't depend on the host's local
timezone — omitting that option silently rolls the label back a day on hosts west of UTC (caught
during manual testing on a `America/Mexico_City` dev machine). `GASTOS FIJOS` in `profitKpis` is a
hardcoded `$2,000.00` **monthly** constant (`GASTOS_FIJOS` in `dashboard.service.ts`, no expenses
model exists) prorated to each window (`GASTOS_FIJOS × windowDays/30`) so `"7"`/`"90"` don't
subtract a flat month of fixed costs from a week's or a quarter's gross profit. `recentSales` caps
at the 20 most recent paid orders; `savings`/`total`
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
180-day queries are (they cover full history by design), `loadReportData` caches its in-flight/settled
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

**Marca y usuarios** (`src/routes/brand.routes.ts`, `src/routes/adminUser.routes.ts`,
`src/routes/account.routes.ts`, `src/controllers/brand.controller.ts`,
`src/controllers/adminUser.controller.ts`): Fase 7. `GET /api/admin/brand` `[public]` and `PUT
/api/admin/brand` `[auth]` share one router but **not** a blanket `router.use(requireAuth)` —
`requireAuth` is applied directly on the `PUT` route only, since the `GET` must stay public (the
storefront reads brand text from it). Both handlers `findOrCreate` the singleton `BrandSettings`
row (`id: 1`, defaults duplicated from `src/seed.ts`'s `BRAND_DEFAULTS` — **not imported**, because
`seed.ts` runs its full `seed()` side effect, including `process.exit`, at module load) instead of
`findByPk` + `404`, so the route works even on a dev DB where `pnpm seed` was never run (the
frontend's `MarcaSection` has no "not seeded yet" empty state). `PUT` validates with
`brandSettingsUpdateSchema` (`src/schemas/brand.ts`, all fields optional — the frontend autosaves
one field at a time — all strings reject empty string since the columns are `NOT NULL`). The
**logo is not handled here** (Fase 3 wired Cloudinary): `logoUrl`/`logoPublicId` are managed by the
dedicated `POST`/`DELETE /api/admin/brand/logo` endpoints, and `brandSettingsUpdateSchema` no longer
accepts `logoUrl` at all (see the **Imágenes / Cloudinary** section below).

`GET /api/admin/users` `[auth]` lists `AdminUser` rows excluding `passwordHash`
(`attributes: { exclude: ["passwordHash"] }`, same pattern as excluding `unitCost` on public
product reads). `POST /api/admin/users` `[auth]` creates a user with a bcrypt-hashed
`tempPassword` — `createAdminUserSchema` requires the **same complexity as `loginSchema`**
(min 8 chars + uppercase + symbol, via the shared `PASSWORD_UPPERCASE_REGEX`/`PASSWORD_SYMBOL_REGEX`
in `src/schemas/auth.ts`); a weaker rule here would let a tempPassword hash successfully while
being permanently unable to pass `POST /api/auth/login`, which validates the same regexes before
ever touching the DB — and `POST /api/auth/forgot-password` is still a stub, so that would be an
unrecoverable lockout. A duplicate email is pre-checked (`409` with a specific message) the same
way `updateOwnAccount` does below. **`owner` and `admin` have identical route access** for all of
`GET`/`POST`/`DELETE /api/admin/users` — `requireRole` is not used anywhere in this phase, matching
the Fase 1 seed comment that the two roles carry the same permissions. `DELETE
/api/admin/users/:id` still enforces two data-integrity guards independent of role: it throws `400`
if the caller targets their own account (`String(id) === req.user!.id` — `req.user.id` is a string
from the JWT payload, `AdminUser.id` is an int) and `400` if the target is the last remaining
`owner`. That second guard runs inside a `sequelize.transaction` that locks the `owner` rows
(`AdminUser.findAll({ where: { role: "owner" }, lock: t.LOCK.UPDATE })`, i.e. `SELECT ... FOR
UPDATE`) rather than a plain `count()`, so two concurrent deletes targeting two different owners
can't both read the same pre-delete count and leave the panel with zero owners; only
locked/checked when the target itself is an `owner`, to avoid the extra query on every
`admin`-role delete — both guards protect against the panel losing all access rather than being
permission checks.

`PUT /api/admin/account` `[auth]`, backed by the same `adminUser.controller.ts` (co-located with
the `/users` handlers rather than a separate controller file, mirroring `order.controller.ts`
backing both `order.routes.ts` and `adminOrder.routes.ts`), updates the caller's own row. Body is
`{ currentPassword, email?, newPassword?, confirmPassword? }` (`updateAccountSchema`,
`src/schemas/adminUser.ts`) — `currentPassword` is **always** required and verified via
`comparePassword` (defense-in-depth against a leaked JWT, even for an email-only change); `email`
and the password fields are independently optional so the same endpoint serves the frontend's two
separate buttons ("Actualizar Correo" / "Cambiar Contraseña"). `newPassword` requires the same
complexity as `tempPassword`/`loginSchema` for the same login-lockout reason above. A changed email
is pre-checked for uniqueness (`409` with a specific message) rather than relying solely on the
generic `UniqueConstraintError` → 409 handler in `errorHandler.ts` (that handler remains the safety
net for the small TOCTOU window). **Known limitation:** an email change does not re-sign the JWT,
so the caller's current token keeps showing the old email until their next login.

**Imágenes / Cloudinary** (Fase 3, activo — `src/config/cloudinary.ts`, `src/middlewares/upload.ts`,
`src/services/image.service.ts`): product and brand-logo images live in **Cloudinary**.
`src/config/cloudinary.ts` (its own `dotenv.config()` at module top, like `stripe.ts`/`database.ts`)
**hard-requires** `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` (throws at
startup if any is missing — side-effect imported from `app.ts` for fail-fast) and exports the shared
`cloudinary` v2 client plus the folder constants `CLOUDINARY_PRODUCTS_FOLDER` /
`CLOUDINARY_BRAND_FOLDER`. `src/middlewares/upload.ts` is **multer with `memoryStorage`** (buffers
never touch disk; `fileFilter` allows only PNG/JPEG/WEBP → `AppError(400)`, `limits.fileSize` 5 MB) —
`uploadProductImages` (`upload.array("images", 3)`) and `uploadLogo` (`upload.single("logo")`).
`src/services/image.service.ts` uploads each buffer with `cloudinary.uploader.upload_stream`
(returning `{ url, publicId }`) and deletes via `uploader.destroy` — **not**
`multer-storage-cloudinary` (its peer-deps want multer/cloudinary 1.x; also, doing the upload
manually keeps the `public_id` on hand for later deletion). `destroyImage` is idempotent/tolerant
(no-op on a missing `publicId`, swallows "not found").

**Product images** (`product.controller.ts`): `POST /api/admin/products/:id/images` `[auth]`
(`uploadProductImages` middleware) uploads 1–3 images and appends them to `Product.images`, capping
at 3 total. The cap is checked early (before uploading) **and** re-checked under a row lock
(`SELECT … FOR UPDATE` in a transaction) so two concurrent adds can't both pass a stale count and
clobber each other. Uploads are **all-or-nothing** (`uploadAllOrCleanup`: if any of several fails,
the ones that succeeded are `destroy`ed so no orphan assets survive an un-persisted op), and if the
DB transaction throws, the just-uploaded assets are cleaned up too. `DELETE
/api/admin/products/:id/images` `[auth]` removes one image by `publicId` (in the body, validated by
`deleteProductImageSchema`) under a row lock, **persists the DB change first, then** `destroy`s the
Cloudinary asset best-effort (a failed `destroy` leaves an orphan — acceptable — never a dangling
reference that would break the image in the store). Public product reads (`getProducts`,
`getProductById`) run every row through `toPublicProduct`, which **strips `publicId`** from each
image (internal Cloudinary management id) so the storefront only sees `url`/`imageSrc`. The admin
`DELETE /api/admin/products/:id` hard-delete path also `destroy`s the product's images; the
soft-delete path keeps them (the row survives for order history). Note `productSchema`/
`productUpdateSchema` **no longer accept `imageSrc`** — images are set only through these dedicated
endpoints.

**Brand logo** (`brand.controller.ts`): `POST /api/admin/brand/logo` `[auth]` (`uploadLogo`) uploads
the logo and, after persisting the new `logoUrl`/`logoPublicId`, `destroy`s the previous asset
best-effort (new asset persisted before deleting the old, so a failed `destroy` never loses the
current logo). `DELETE /api/admin/brand/logo` `[auth]` nulls both columns then `destroy`s
best-effort. `BrandSettings` gained the nullable `logoPublicId` column alongside `logoUrl`.

**Multer errors**: `errorHandler` maps `MulterError` (from parsing `multipart/form-data`) to `400`
with a Spanish message — `LIMIT_FILE_SIZE` (>5 MB), `LIMIT_FILE_COUNT`, and `LIMIT_UNEXPECTED_FILE`
(wrong field name or over the count — `err.field` disambiguates) — otherwise these would fall to the
generic 500.

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
without it they default to `0`/`[]`. Product images live in the `images` column (`JSONB`, default
`[]`, shape `[{ url, publicId }]` — the Cloudinary gallery, up to 3); `imageSrc` is a read-only
`VIRTUAL` that returns `images[0]?.url ?? null` (kept for frontend compat — the source of truth is
`images`, so there's no physical column to keep in sync). See the **Imágenes / Cloudinary** section.
`Order` holds a frozen snapshot of totals and shipping
data; `OrderItem` freezes per-unit prices (`unitOriginalPrice`, `unitSalePrice`, `unitCosto`) so
historical orders aren't affected by later `Product` price changes. `AdminUser` and
`BrandSettings` (singleton) round out the Fase 1 data model; `AdminUser` also gained three
nullable password-reset columns in Fase 9 (`resetPasswordCodeHash`, `resetPasswordExpiresAt`,
`resetPasswordAttempts` — see the **Password reset via 5-digit code** section). `src/seed.ts`
(`pnpm seed`) populates all of the above from the frontend's mock data.

## Conventions

- TypeScript runs in `strict` mode with decorators enabled (`experimentalDecorators`,
  `emitDecoratorMetadata`); source in `src/`, output in `dist/`.
- Configuration comes exclusively from environment variables (`PORT`, `NODE_ENV`,
  `DATABASE_URL`, `CORS_ORIGIN`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` (both required — the server throws at startup without them),
  optional `STRIPE_CURRENCY`/`PENDING_ORDER_TTL_MINUTES`/`PENDING_ORDER_SWEEP_INTERVAL_MINUTES`,
  plus Cloudinary keys, `RESEND_API_KEY` + `EMAIL_FROM` (both required — the server throws at
  startup without them) and optional `FRONTEND_URL`). `.env` is gitignored — never commit it
  (the Stripe/Resend keys are test/sandbox).
- Dependencies wired in: `jsonwebtoken` + `bcrypt` (auth), `zod` (validation),
  `express-rate-limit` (auth routes), `swagger-jsdoc` + `swagger-ui-express` (API docs),
  `stripe` (payments — real PaymentIntent + signed webhook),
  `cloudinary` + `multer` (image uploads — Fase 3: multer memory storage → Cloudinary
  `upload_stream`; `multer-storage-cloudinary` is installed but **unused**, see the image section),
  `resend` (transactional emails — Fase 9: password-reset code, see the Emails section).
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
