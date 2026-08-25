# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project uses **pnpm** (`packageManager: pnpm@11.20.0`).

- `pnpm install` — install dependencies
- `pnpm dev` — server in watch mode via `ts-node-dev` (entry: `src/app.ts`)
- `pnpm build` — compile TypeScript to `dist/`; `pnpm start` — run `dist/app.js`
- `pnpm migrate` / `pnpm migrate:undo` / `pnpm migrate:undo:all` / `pnpm migrate:status` — `sequelize-cli`
- `pnpm seed` — populate the DB from the frontend's mock data (`src/seed.ts`)
- `pnpm test` — Jest suite; `pnpm test:watch`; `pnpm test <pattern>` for one part

No linter is configured yet.

## Architecture

Express 5 + TypeScript REST API backed by PostgreSQL through Sequelize 6. Backend for the
"Botas Don Chuy Outlet" store (products of type `bota`, `sombrero`, or `ropa`).

**Las secciones más extensas viven en `docs/features/`** (una por área: `catalog-search.md`,
`coupons.md`, `expenses.md`, `sale-notice.md`, `checkout.md`, `order-lookup.md`,
`stripe-payments.md`, `multi-box-packing.md`, `shipment-retry.md`, `reports.md`,
`bulk-import.md`). Aquí queda un resumen de cada una con su referencia; **al cambiar el
comportamiento de alguna, actualiza su archivo en `docs/features/`, no solo el resumen.**

### Startup flow (`src/app.ts`)

`dotenv` → create app → `trust proxy` when `TRUST_PROXY` is set (it decides whether `req.ip`, and
therefore every rate limiter, sees the real client or the proxy — see **Conventions**) → global
middleware (`helmet`, `cors` with `CORS_ORIGIN` as a comma-separated list split/trimmed into an array,
JSON + urlencoded parsers) → Swagger UI at `/api/docs` (+ raw spec at `/api/docs.json`, both gated by
`apiDocsEnabled()` — off in production unless `API_DOCS_ENABLED=true`) → routers →
`GET /health` and `GET /health/ready` → `errorHandler` last.

Everything with a **process-level side effect** — `connectDB()`, the three cron starters
(`startPendingOrderSweeper`, `startShipmentRetrySweeper`, `startDailySalesDigest`), `app.listen(PORT)`
(default `4000`, capturing the `http.Server` in `server`), and the graceful-shutdown wiring — sits
**after** `export default app` inside `if (process.env.NODE_ENV !== "test")`: Supertest imports `app`
directly and must not open a port, connect to the DB, or start crons.

**Graceful shutdown** (Fase H.5): `SIGTERM`/`SIGINT` share a `gracefulShutdown` that (0) calls
`markDraining()` so a readiness probe landing mid-drain gets an honest `503` — that window lasts only
as long as in-flight requests, since on Node ≥19 `server.close()` also destroys idle keep-alive
connections and an idle process exits in milliseconds, so the next probe usually sees a connection
error instead; making a load balancer reliably observe the `503` would need an explicit delay before
`server.close()`, deliberately not implemented (it would lengthen every redeploy); (1) stops the
crons; (2) `server.close()`s to drain in-flight requests; (3) `await sequelize.close()`s the pool — so
a redeploy can't cut a checkout transaction mid-flight. A flag ignores repeated signals and a 10 s
`unref()`ed timeout forces `process.exit(1)` if a hung connection stalls `server.close()`.

### Healthchecks (Fase O.5 — `src/services/readiness.ts`, routes inline in `app.ts`)

**Two separate probes**, and pointing the orchestrator at the wrong one is the whole hazard.
`GET /health` is **liveness** and deliberately **does not touch the DB** — if it did, a momentary
Postgres blip would make the orchestrator **restart** the app (killing in-flight requests, fixing
nothing) instead of pulling it out of rotation. `GET /health/ready` is **readiness**: it runs
`sequelize.authenticate()` and answers `200 { status:"ok", database:"up", timestamp }` or
`503 { status:"unavailable", database, reason, timestamp }`.

Four load-bearing details in `checkReadiness`:
1. **Mandatory timeout** (`HEALTH_READY_TIMEOUT_MS`, 3 s, via `positiveNumberEnv`) inside a
   `Promise.race` — `config/database.ts` sets no `connectTimeout`/`statement_timeout` and
   `pool.acquire` is 30 s, so with Postgres down the probe would hang far past what any orchestrator
   waits. The `setTimeout` is `unref()`ed and **`clearTimeout`ed in a `finally`**, or the losing timer
   would reject later with nobody listening (unhandled rejection).
2. **1 s result cache + in-flight sharing** (same pattern as `loadReportData`): public unauthenticated
   route, pool of 5 connections, so without it a script hammering it starves real checkouts. The
   window is counted from when the check **finishes**, so a slow (DB-down) check doesn't expire
   mid-flight and let every request open its own query. A dedicated rate limiter was rejected: probes
   come from one internal IP, so a mis-calibrated limit would `429` **the probe itself** → false "not
   ready" → self-inflicted restart.
3. **Draining flag** (`markDraining()`, irreversible), checked first, so shutdown answers
   `503 reason:"draining"` without touching the DB.
4. **Transition-only logging, no Sentry**: a probe runs every few seconds forever, so one line per
   failed attempt would flood the log provider and eat the quota.

`checkReadiness` **never throws** (a DB failure is a valid `{ ready:false }`, not a request error) —
the route must not reach `errorHandler`, which would report a 500 to Sentry per probe and return
Spanish UI copy for something a machine reads. The `503` body **never** carries the DB error text
(public route); it goes to the log. `checkReadiness(timeoutMs?)` takes an override only for tests, and
`resetReadinessCache()` is exported **only for tests** (module state survives `truncateAll`, same as
`resetCheckoutIdempotency()`).

### Database (`src/config/database.ts`)

A single shared `sequelize` instance built from `DATABASE_URL` (postgres dialect, pool max 5).
`connectDB()` only authenticates — schema changes never happen at runtime, in any environment, dev
included (this used to run `sync({ alter: true })` in development; removed in Fase H.2 so dev and prod
share the exact same schema-change path). SQL logging is gated on development. On any connection error
the process exits with code 1.

**TLS comes from `src/config/databaseSsl.ts`, and `?sslmode=…` in the URL does nothing.** That's the
usual advice and it fails silently here, leaving the connection in cleartext: Sequelize copies the
URL's query params into `dialectOptions`, but its postgres connection manager filters that object
through an allowlist containing `ssl` and **not** `sslmode`, so the key is dropped and `pg` falls back
to its `ssl: false` default. `databaseSslOptions()` reads `DATABASE_SSL` (default `false`) and
`DATABASE_SSL_REJECT_UNAUTHORIZED` (default `true`) through `booleanEnv` and returns
`{ ssl: { rejectUnauthorized } }` — or **`{}`** when off, not `{ ssl: false }`, so `pg` keeps its own
default and behavior is unchanged from before the module existed. It also `console.warn`s when the URL
carries an `sslmode` that expects TLS while `DATABASE_SSL` is off, turning that trap into a message.
**Both `database.ts` and `sequelize-cli.js` call the same function** (the `.js` can `require` the `.ts`
because `.sequelizerc` registers ts-node first) — a hand-copied second version is exactly how the
migrations would end up unencrypted while the app is encrypted.
`tests/unit/config/sequelizeCliConfig.test.ts` asserts the two can't drift.

### Migrations (`src/migrations/`, Fase H.2)

The versioned, reproducible path to change schema, dev and prod alike. `sequelize-cli` is driven by
`.sequelizerc` at the repo root, which registers **`ts-node/register/transpile-only`** (migrations are
authored in TypeScript; this CLI version's glob matches `.ts` natively). `transpile-only` is
deliberate: type-checking at CLI startup would need `@types/node` and friends installed *in
production*, and nothing is lost — `tsconfig.json`'s `include: ["src/**/*"]` covers `src/migrations/`,
so `pnpm build` already type-checks and emits every migration, and the deploy pipeline runs it before
`pnpm migrate`. It points
`migrations-path`/`seeders-path`/`models-path` at `src/migrations`/`src/seeders`/`src/models`. The
CLI's connection config is `src/config/sequelize-cli.js` (plain `.js`, not compiled by `tsc` —
`sequelize-cli` never imports `app.ts`, so it bootstraps its own `dotenv.config()`, same reasoning as
`stripe.ts`/`cloudinary.ts`) and resolves `DATABASE_URL` via `use_env_variable`.

`src/migrations/` reconstructs the current schema as one `createTable` migration per table in FK order
(`products` → `product_sizes` → `orders` → `order_items` → `adminusers` → `brand_settings`) — a clean
starting point rather than replaying every historical `alter: true`. Each migration's `down` also
drops the Postgres `ENUM` type(s) it implicitly created (`DataTypes.ENUM` auto-creates
`enum_<table>_<column>`, but `dropTable` does **not** drop it).

**When you add a column or a table, write the migration under `src/migrations/` first — there is no
`alter: true` fallback to replicate it anywhere, dev included.**

### HTTP layer (`src/routes/`, `src/controllers/`)

Routers are mounted in `src/app.ts` under a base path (e.g. `app.use("/api/products", productRoutes)`)
and delegate to handlers in the matching `*.controller.ts`. `src/routes/` is split into subfolders **by
access/responsibility, not by resource**:

- `admin/` — every router with `requireAuth` on some or all routes: `adminProduct`, `adminDashboard`,
  `adminOrder`, `adminReports`, `adminUser`, `adminCoupon`, `adminExpense`, `account`, and `brand`
  (its `GET` is public but its `PUT`/logo routes aren't, so it lives here rather than in `public/`).
- `public/` — no auth anywhere in the file: `product`, `order` (checkout + public lookup), `shipping`,
  `coupon`.
- `auth/` — authentication itself (neither an admin resource nor a storefront one).
- `webhooks/` — third-party callbacks from Stripe/Skydropx, verified by signature rather than a JWT.

`src/config/swagger.ts`'s `apis` glob is `./src/routes/**/*.ts` (and the `dist/` equivalent) precisely
so it keeps finding `@openapi` blocks regardless of subfolder. **When adding a new resource, put its
`*.routes.ts` in the subfolder matching its access level**, mount it in `src/app.ts`, and create the
matching `*.controller.ts`.

**Public product reads** only expose rows with `visible: true` and exclude `unitCost` via
`attributes: { exclude: [...] }`.

`GET /api/products` filters, sorts and paginates **in SQL**: `total` comes from a separate
`Product.count({ where })` and the page from `Product.findAll({ where, limit, offset, order })`, so
Postgres only ever returns the requested page (`page` clamped to `[1, totalPages]`). Filters:
`categoria` → `type`; `talla` → a `WHERE id IN (SELECT "productId" FROM product_sizes WHERE size = N
AND stock > 0)` subquery (since "has this size in stock" isn't a plain column). `talla` is validated
with `Number.isInteger` **and `> 0` on a trimmed non-empty string** before being interpolated — never a
raw client string; the emptiness check matters because `Number("") === 0` passes `Number.isInteger`, so
`?talla=` used to filter by `size = 0` and return an **empty catalog**.

The `where` is built as a **single object literal** with conditional spreads rather than mutated field
by field, because `[Op.or]` is a `symbol` key a `WhereOptions` won't accept by assignment without a
cast; what matters is that `count` and `findAll` get **the same object**, or `total`/`totalPages` would
contradict the returned page.

#### Catalog search, sort and price range (Fase N.1)

`q` (búsqueda `iLike` sobre `name`/`code`, **siempre** vía `escapeLike`), `orden`
(`precio_asc`/`precio_desc`/`novedad`) y `precioMin`/`precioMax` filtran y ordenan en SQL,
respaldados por dos índices parciales declarados también en `Product.init()`. Todo parámetro
inválido se **ignora en silencio**, nunca es `400`, y los predicados de `availableSizes` son una
copia a mano del `where` compartido: **un filtro nuevo se agrega en los dos lados**.

Detalle completo en `docs/features/catalog-search.md`.

### Cupones y códigos de descuento (Fase N.2)

`POST /api/coupons/validate` `[público]` + CRUD en `/api/admin/coupons` `[auth]`. El cliente manda
un **código** y jamás un monto; el descuento se calcula solo en `computeCouponDiscount`
(`src/services/cart.ts`) sobre la mercancía neta y sin tocar el envío, y el canje es atómico dentro
de la transacción del checkout. El invariante de toda la app es
`total = subtotal − savings − couponDiscount + shipping`.

Detalle completo en `docs/features/coupons.md`.

### Gastos y suscripciones (Fase N.3)

CRUD + `/summary` + `/history` en `/api/admin/expenses` `[auth]`; sustituye la constante
`GASTOS_FIJOS = 2000` que restaba el dashboard. **El monto no es una columna de `expenses`: vive
versionado en `expense_amounts` por `effectiveFrom`**, así que subir el precio de una suscripción no
reescribe los meses ya cerrados. ⚠️ Las guías de envío **no** se capturan como gasto (se derivan de
`Order.shipping`); las cajas y el empaque sí.

Detalle completo en `docs/features/expenses.md`.

### Aviso de venta al dueño (Fase N.4)

Dos correos a `OWNER_NOTIFICATION_EMAIL` (fallback `ALERT_EMAIL_TO`; sin ninguna de las dos la fase
queda apagada): el **aviso por venta** —fire-and-forget dentro del guard `affected === 1` de
`markOrderPaidFromWebhook`, con asunto autocontenido— y el **resumen diario** del día local anterior
(cron `startDailySalesDigest`). Ninguno lleva `unitCost` ni margen.

Detalle completo en `docs/features/sale-notice.md`.

### Seed

`src/seed.ts` (`pnpm seed`) populates every model from the frontend's mock data. Because it inserts rows
with explicit `id`s, Postgres SERIAL sequences are left behind; the seed resyncs each one
(`setval(pg_get_serial_sequence(table,'id'), MAX(id))`) at the end of the transaction so later
`id DEFAULT` inserts (e.g. `POST /api/admin/products`) don't collide with seeded ids.

⚠️ **`pnpm seed` is development-only and must never run against production.** Before inserting anything
it `TRUNCATE … RESTART IDENTITY CASCADE`s eight tables (`orders` and `adminusers` among them) *outside*
the transaction, inserts 30+ mock products plus a fake order history the dashboard and reports would
count as real sales, hardcodes the admin's email/password, and calls `process.exit` as a **side effect
of being imported** (which is why `brand.controller.ts` duplicates `BRAND_DEFAULTS` instead of importing
it, and why `seed.ts` has no tests).

### First admin user in production (`src/scripts/bootstrapAdmin.ts`)

The only way into the panel on a fresh database: `POST /api/admin/users` requires a JWT, and getting a
JWT requires a user. Run **compiled** — `node dist/scripts/bootstrapAdmin.js` — because `ts-node`,
`sequelize-cli` and `typescript` are devDependencies, so `pnpm seed`/`pnpm migrate` don't exist after a
`pnpm install --prod`; everything this script needs at runtime (`bcrypt`, `sequelize`, `pg`, `dotenv`,
`zod`) is already a prod dependency. `pnpm bootstrap:admin` is the local ts-node convenience only.

Credentials come in as **env vars** (`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, plus optional
`BOOTSTRAP_ADMIN_NAME`/`BOOTSTRAP_ADMIN_ROLE`/`BOOTSTRAP_RESET_PASSWORD`), never argv — the password
would otherwise land in shell history and be visible in `ps`.

Load-bearing details:
- **It validates with `createAdminUserSchema`**, the same schema `POST /api/admin/users` uses — never
  re-derived rules. A laxer password rule here would hash fine and produce an account that can **never**
  pass `POST /api/auth/login`, exactly what `src/schemas/auth.ts`'s header warns about. The schema
  `.trim()`s **before** the regexes, so what gets hashed is the **parsed** string, not the raw env value
  (a trailing space pasted into a PaaS variable editor would otherwise create a dead account).
- **`role` defaults to `owner`, not the schema's `admin`.** `DELETE /api/admin/users/:id` refuses to
  delete the last `owner`; a database bootstrapped as `admin` has zero owners, so that guard protects
  nothing. Both roles carry identical route permissions by design, so this opens no access.
- **An existing email is a hard failure (exit 1), not an overwrite** — unless `BOOTSTRAP_RESET_PASSWORD`
  is on, which is also how the seeded admin's password gets rotated. The reset clears the three
  password-reset columns, like `resetPassword` does, or a code issued beforehand would still be live
  against the brand-new password.
- **It never imports `src/app.ts`** — that would fail-fast on the Cloudinary/Resend/Skydropx keys, start
  the three crons and bind the port. `DATABASE_URL` (plus optional `BCRYPT_ROUNDS`) is the whole
  requirement. `config/database` must be imported **before** `utils/password`, which reads
  `BCRYPT_ROUNDS` at module evaluation while `database.ts` is what calls `dotenv.config()`.
- **It does not create `BrandSettings`** — `brand.controller.ts` already `findOrCreate`s the `id: 1`
  singleton on the first (public) `GET /api/admin/brand`; doing it here would add a third copy of
  `BRAND_DEFAULTS`.
- Logic lives in the exported `bootstrapAdmin(env)`, with the CLI runner behind
  `if (require.main === module)`, so it's testable — the trap `seed.ts` fell into.

### Deployment (`render.yaml`)

Render Blueprint at the repo root: the web service plus its Postgres database. Build is
`pnpm install --frozen-lockfile && pnpm build`, **`preDeployCommand` is `pnpm migrate`** (runs after the
build with traffic still on the old version, so a failed migration never fronts a half-migrated app),
start is `pnpm start`. **`autoDeploy` is `false`** — the deploy is triggered by the CI's `deploy`
job after a green `main`, never by the push itself (see **CI/CD**). Secrets are `sync: false` — Render prompts for them once and they are never
committed; `JWT_SECRET` uses `generateValue: true` so it never passes through a human's hands. `PORT`
is deliberately not declared (Render injects it, `app.ts` reads it) and neither is `DATABASE_SSL` (the
service and the DB share a region, so `DATABASE_URL` is the private internal URL).

**`healthCheckPath` is `/health`, not `/health/ready`** — the one place this repo's two-probe design
meets a platform that only has one hook. Render uses that single check both to gate a new deploy and,
on a running service, to pull the instance out of rotation after 15 s and **restart it after 60 s**.
Pointing it at the readiness probe would turn a one-minute Postgres blip into a restart: precisely the
failure mode **Healthchecks** above exists to prevent. The apparent gap — a new deploy taking traffic
without having verified the DB — is already closed by `connectDB()`'s `process.exit(1)`, which kills
the process so it never answers `/health` and Render cancels the deploy. `/health/ready` is for
external uptime monitoring, where a `503` pages a human instead of restarting anything.

`numInstances: 1` is a **decision, not a default**: rate limiters, checkout idempotency, the sweeper's
failure counter and the readiness cache are all process memory, and the three crons would run in every
replica.

### API docs (`src/config/swagger.ts`)

`swagger-jsdoc` builds an OpenAPI 3.0 spec from a base `definition` (info, `servers`, `bearerAuth` security
scheme, reusable `components.schemas` like `Product`, `LoginInput`, `Error`) plus JSDoc `@openapi`
annotations read from the `apis` globs (`./src/routes/**/*.ts` + `./src/app.ts` in dev, and the `./dist/...`
equivalents — both run with cwd at the backend root). `src/app.ts` serves the UI with `swagger-ui-express`
at `/api/docs` and the raw JSON at `/api/docs.json`. **When adding
a new resource, document each endpoint with an `@openapi` JSDoc block above its `router.<method>(...)`,
referencing shared schemas via `$ref: '#/components/schemas/...'` (add new schemas to `swagger.ts`).**

Both routes are wrapped in `if (apiDocsEnabled())` (`src/utils/env.ts`): **off in production**, on
everywhere else, and `API_DOCS_ENABLED=true` turns them back on without a code change (or `=false` off
in dev). The admin routes always required a JWT, so serving the spec was never a hole by itself — but it
hands anyone the complete map of every endpoint, body and response, the panel's included. `requireAuth`
was rejected as the guard: the browser doesn't send `Authorization` when fetching Swagger UI's own assets
or the spec, so the UI would just break. The spec is still **built** at import either way (cheap, and it
keeps `swagger.test.ts` honest); only the two routes disappear, falling to Express's default 404.

### Auth (`src/routes/auth/`, `src/controllers/auth.controller.ts`)

Mounted at `/api/auth`. `POST /api/auth/login` validates with `loginSchema` (zod), looks up `AdminUser` by
email, compares the bcrypt hash, and returns `{ token, user }`; an unknown email and a wrong password
return the **same** `401` message (anti-enumeration). `GET /api/auth/me` is protected by `requireAuth` and
returns the decoded `{ user }`. `/login`, `/forgot-password`, `/verify-reset-code` and `/reset-password`
are gated behind `authRateLimiter` (10 req / 15 min). `requireAuth` (`src/middlewares/requireAuth.ts`)
extracts the Bearer token, verifies it with the `JWT_SECRET` exported by `src/config/auth.ts`
(hard-required at startup — see **Conventions**), and attaches `req.user: AuthUser`.
`requireRole(...roles)` checks `req.user.role` and throws `403` if the role isn't listed.

**Password reset via 5-digit code** (Fase 9.2 — `auth.controller.ts`, `src/utils/resetCode.ts`): the
forgot-password flow emails a **5-digit numeric code**, not a reset link. `AdminUser` carries three
nullable columns: `resetPasswordCodeHash` (sha256 of the code — never stored in clear; sha256 not bcrypt
because the code is short-lived, single-use and attempt-limited), `resetPasswordExpiresAt` (now +
`RESET_CODE_TTL_MINUTES`, 15) and `resetPasswordAttempts`. All three are **excluded from
`GET /api/admin/users`** alongside `passwordHash`.

- `POST /api/auth/forgot-password`: **if the email exists**, generates a code
  (`crypto.randomInt(0,100000)` padded to 5), stores its hash + expiry (attempts reset to 0) and emails
  it; it **always** returns `{ ok: true }` so it never reveals whether an email is registered.
- `POST /api/auth/verify-reset-code` validates but **does not consume** the code — it only unlocks the
  frontend's reset page; the real security is at reset.
- `POST /api/auth/reset-password` (`resetPasswordSchema` enforces the same complexity as `loginSchema`)
  **re-validates** the code, updates `passwordHash` and clears the three columns (single-use).

A shared `assertValidResetCode` backs both endpoints: it rejects with a generic `400 "El código no es
válido o ya expiró (dura N minutos). Solicita uno nuevo para continuar."` when the user/code is missing,
expired, or over `RESET_CODE_MAX_ATTEMPTS` (5), and on a wrong code increments `resetPasswordAttempts`
(burning the code at the max) — the message is identical for missing-email/wrong-code/expired so none is
distinguishable. This flow is **independent** of `PUT /api/admin/account` (which requires
`currentPassword`); the reset path needs no current password precisely because the user forgot it.

### Emails / Resend (Fase 9.1)

`src/config/resend.ts` (its own `dotenv.config()` at module top, like `stripe.ts`/`cloudinary.ts`)
**hard-requires** `RESEND_API_KEY` **and** `EMAIL_FROM` (throws at startup — side-effect imported from
`app.ts` for fail-fast) and exports the shared `resend` client, `EMAIL_FROM` and `FRONTEND_URL`.

`src/services/email.service.ts` exposes `sendEmail({ to, subject, html, idempotencyKey? })`; it **logs but
never throws** — the Resend SDK returns `{ data, error }` (it doesn't throw on API errors), so the wrapper
handles both the returned `error` **and** a network exception via try/catch. A failed email must never
take down the request that triggered it (forgot-password, checkout, Stripe webhook).

HTML templates live in `src/services/email/templates/` as plain functions returning a string (no template
engine): `passwordResetCodeTemplate`, `orderConfirmationTemplate`, `newOrderNotification`,
`dailySalesDigest`, plus the shared `escapeHtml.ts`.

`orderConfirmationTemplate` renders the itemized order using the **frozen `OrderItem` prices**, never
current `Product` prices (original struck through when discounted), the
`subtotal`/`savings`/`couponDiscount`/`shipping`/`total`, the shipping address, and a **conditional
shipping block**: a "Estamos preparando tu envío" placeholder, or —when `tracking: { number, url?,
carrier? }` is passed— the "va en camino" variant, so one template backs both emails.

**It never renders the order number**, in the body or the subject, and that's deliberate: `Order.id` is
the store's global sequence, not the buyer's — "tu pedido #20" implies twenty purchases they never made
— and it isn't a usable reference either, since the public lookup is by token precisely because a
sequential id would be enumerable. The date stays: it's what actually distinguishes two purchases in an
inbox. Both `sendOrderEmail` callers' `idempotencyKey`s (`order-confirmation/${id}`, `order-shipped/${id}`)
**do** keep the id — they're internal to Resend, the customer never sees them, and they're the
"one email per order" guarantee shared by the Skydropx webhook and the manual status advance.

The tracking block (Fase O.4) offers **two ways in, and both are needed**: the "Ver el estado de mi
pedido" button (`trackingPageUrl`) **and the `publicToken` printed in plain sight** in a monospace,
`word-break:break-all` box (`trackingCode`), with `trackingLookupUrl` naming the page where it's pasted.
The code box exists because the button alone left the token reachable only inside an `href`: the `/pedido`
page asks for the **code**, so a buyer arriving that way had to know how to "copy link address" — the
owner himself couldn't find it. That box is **never an `<a>`** (tapping a link on mobile navigates instead
of letting you select the text, which is the whole point). The block goes in **both** emails, since they
share `sendOrderEmail` and there's no telling which one the customer keeps; with neither URL nor code
(rows predating the `publicToken` column, where `publicOrderUrl` returns `undefined`) nothing is rendered
at all, rather than a link to a 404 or an empty box. `payment.service.ts` builds both URLs —
`publicOrderUrl` (`/pedido/<token>`) and `publicOrderLookupUrl` (`/pedido`) — and they are the only URLs
this backend constructs toward the front, which is why they live side by side.

It **never** receives or renders `unitCost`, formats money with
the shared `formatMoney` (`src/utils/formatMoney.ts`, es-MX `$1,920.50` — also used by
`dashboard.service.ts` and `product.controller.ts`'s price-conflict error, so the same amount reads the
same everywhere) and formats the order date pinned to `America/Mexico_City` (a **deliberate** deviation
from the repo's UTC-pinning, which exists for aggregation stability — this is a customer receipt for a
store in Celaya, GTO). Every customer/product-controlled string it interpolates (`customerName`,
`nameSnapshot`, the address fields, `shippingCarrier`, `couponCode`, `trackingCode`, the `tracking` fields)
goes through
`escapeHtml` — without it a legitimate `&`/`<`/`>` in an address breaks the render and a hostile value
would inject markup; numeric fields are not escaped.

**Domain caveat:** without a verified domain, `EMAIL_FROM` must be `onboarding@resend.dev` and Resend only
delivers to the account owner's address (`403` to anyone else — swallowed by `sendEmail`); production needs
a verified domain (manual DNS step, no code).

### Checkout

`POST /api/orders` `[público, orderRateLimiter]` (`src/services/orders.service.ts`) crea el pedido
dentro de **una sola transacción**: descuento atómico de stock por `(productId, size)`, totales y
envío **recalculados en el servidor** (el cliente nunca manda montos), precios **congelados** en
cada `OrderItem`, canje del cupón y constancia de aceptación de términos (Fase 27). Incluye la
**idempotencia de checkout** (Fase O.2) que devuelve la respuesta original ante un doble clic.

Detalle completo en `docs/features/checkout.md`.

#### Public order lookup (Fase O.4)

`GET /api/orders/lookup/:token` `[público, orderLookupRateLimiter]` deja al comprador ver estado y
guía sin cuenta, usando el UUID opaco `Order.publicToken` como única credencial (nunca `id + email`,
que sería enumerable). La respuesta es una **proyección explícita** (`PublicOrderView`), no la fila
con exclusiones. Incluye la rotación de token (Fase O.6).

Detalle completo en `docs/features/order-lookup.md`.

### Payments / Stripe (Fase 8)

`src/config/stripe.ts` (hard-require de `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`),
`src/services/payment.service.ts` y `POST /api/webhooks/stripe` montado con `express.raw` **antes**
del `express.json()` global. **La transición a pagado es un único `UPDATE` condicional** (`where: {
id, status:"pending", paymentStatus: ne "paid" }`) y el correo, el aviso al dueño y la guía solo se
disparan con `affectedCount === 1`. Incluye `releaseOrderStock` y `pendingOrderSweeper`.

El cliente compartido fija su `apiVersion` (`STRIPE_API_VERSION`, hoy `2026-06-24.dahlia`). Es un
no-op en runtime —el SDK ya mandaba esa misma versión por su cuenta— y existe por el tipo: el campo
está tipado con el literal exacto de la versión del SDK, así que un `pnpm update` de `stripe` que la
mueva **rompe `pnpm build`** en vez de cambiar en silencio la forma de los objetos que leen
`markOrderPaidFromWebhook` y `applyDisputeFromWebhook`. Subirla obliga a revisar el changelog.

Detalle completo en `docs/features/stripe-payments.md`.

### Disputas / contracargos (Fase 28)

`Order.disputeStatus` / `disputeReason` / `disputedAt` / `disputeAmount`
(`20260821120000-orders-dispute-fields.ts`), `payment.service.applyDisputeFromWebhook`, handled in
`stripeWebhook` (`order.controller.ts`).

Hasta esta fase `charge.dispute.created`/`.updated`/`.closed` caían en el `default: break` del switch y
**no dejaban rastro**: el pedido seguía `paid`, seguía en "Pendientes de enviar" y salía impreso en la
hoja de empaque — la mercancía se podía mandar con el dinero ya retirado del saldo (Stripe se lleva el
importe más su comisión de disputa, que no se devuelve ni ganando el caso).

**Columnas propias, no un valor nuevo del enum `paymentStatus`.** El cargo *fue* cobrado y, si la
disputa se gana, el dinero vuelve — meter `"disputed"` en el enum obligaría a decidir a qué estado
"regresar" al cerrarse (¿`paid`? ¿`refunded`? un contracargo perdido no es un reembolso) y borraría el
hecho de que se pagó. Mismo criterio que ya separa `status` de `paymentStatus`. `disputeStatus` y
`disputeReason` guardan el string **crudo** de Stripe (`needs_response` · `under_review` · `won` ·
`lost` · `warning_*`/`fraudulent`/`product_not_received`/…), igual que `shipmentStatus` guarda el crudo
de Skydropx — un enum de Postgres convertiría cada estado nuevo de Stripe en una migración; quien los
clasifica es el frontend. `disputedAt` es la **primera** vez que se supo y no se pisa en eventos
posteriores (`updated`/`closed` mueven el estado, no la fecha en que empezó el problema).
`disputeAmount` puede ser **parcial** (no basta con leer `total`) y se guarda en pesos — Stripe lo manda
en centavos — con el mismo getter `parseFloat` que el resto del dinero del pedido. Las cuatro son
`null` cuando el pedido nunca tuvo disputa, el caso normal, y ninguna llega al comprador:
`getOrderByPublicToken` es una lista blanca explícita de `attributes` que no las incluye.

`applyDisputeFromWebhook` **no toca `status`, `paymentStatus` ni el stock**: una disputa perdida tampoco
cancela el pedido ni repone stock, porque la mercancía pudo haber salido ya y devolver al catálogo
piezas que no están físicamente en la tienda es peor que no hacer nada — esa decisión sigue siendo del
dueño, con el botón de cancelar/reembolsar que ya existe (Fase H.5). Es **idempotente y tolerante a
"orden no encontrada"** (busca por `paymentIntentId`, log + return sin lanzar), mismo criterio que
`markOrderPaidFromWebhook`/`markOrderPaymentFailed`, para que un evento verificado siempre responda
`200` y Stripe no reintente en bucle.

⚠️ **Qué eventos llegan al webhook se configura en el Dashboard de Stripe, no en este repo**, y por
separado en test y en live: además de los tres de `payment_intent`, el endpoint necesita suscribir
`charge.dispute.created`, `charge.dispute.updated` y `charge.dispute.closed`. `stripe listen` reenvía
todo en local, así que un hueco en esa suscripción solo se nota en producción — y callando, porque el
handler simplemente nunca recibe el evento. Si las disputas dejan de aparecer, revisar esa suscripción
antes que el código.

### Envío en vivo / Skydropx (Fase 8.1–8.7)

`POST /api/shipping/rates` `[público]` (`src/routes/public/shipping.routes.ts` →
`shipping.controller.ts`'s `getShippingRates`) cotiza el envío en vivo contra Skydropx Pro, con la tarifa
plana existente (`cart.ts`'s `computeShipping`) como **fallback** — la tienda nunca debe dejar de cotizar
porque la paquetería esté caída. `src/config/skydropx.ts` sigue el patrón de `stripe.ts`
(`dotenv.config()` propio, **hard-require** al arrancar) para
`SKYDROPX_CLIENT_ID`/`SKYDROPX_CLIENT_SECRET`/`SKYDROPX_WEBHOOK_SECRET` y para **todos** los campos
`SHIP_FROM_*` (los de dirección para cotizar; `STREET`/`EXTERNAL_NUMBER`/`NAME`/`PHONE` desde Fase 8.5,
porque `createShipmentForOrder` los usa para el `address_from` de la guía).

**Cliente HTTP compartido** (`src/services/skydropx.service.ts`, sin SDK — `fetch` nativo): autentica con
OAuth2 `client_credentials`, cachea el `access_token` en memoria y lo renueva ~5 min antes de que expire
(`expires_in: 7200`), y limita **todas** las llamadas salientes (incluida la de token) a 2 req/s con un
`throttle()` de cola compartida a nivel de módulo — el límite documentado de la cuenta. Cada `fetch` lleva
su propio `AbortSignal.timeout` (`REQUEST_TIMEOUT_MS`, 5s) para que una conexión colgada no bloquee
indefinidamente — el presupuesto de 8s de `pollQuotation` solo se revisa *entre* intentos. Los fallos HTTP
se lanzan como `SkydropxRequestError` (conserva `status` y `path`) para poder distinguir un 4xx (bug de
integración nuestro) de una falla transitoria de red/5xx.

**Cotización.** `getShippingRates(addressFrom, addressTo, parcel)` crea la cotización
(`POST /api/v1/quotations`, shape `{ quotation: { address_from, address_to, parcels } }` — confirmado
contra sandbox real; incluye `requested_carriers` solo si `SKYDROPX_CARRIERS` está definido) y hace poll
(`GET /api/v1/quotations/{id}`) cada segundo hasta que ninguna tarifa quede `pending`, se junten
**`MIN_READY_RATES` (3)** tarifas utilizables, o se agote `POLL_TIMEOUT_MS` (**8s**) — `is_completed` puede
no llegar nunca a `true` (timeouts internos de Skydropx), así que el poll no lo espera. El **corte
temprano por 3 tarifas listas** es la mayor ganancia de latencia: alguna paquetería se queda `pending`
indefinidamente y sin el corte mantendría el poll ocupado los 8s completos. **Cuidado:** un `rates: []` en
la primera lectura no es "ya resuelto" — `.some()` sobre un array vacío da `false`, así que el chequeo de
"sigue pendiente" trata explícitamente un array vacío como pendiente, o el poll cortaría con cero tarifas.

Solo se devuelven tarifas **utilizables** (`isUsableRate`: `success: true`, no `pending`, con
`amount`/`total` no nulos — llegan como **strings**, requieren `parseFloat`), **ordenadas de más barata a
más cara y recortadas a `MAX_RATES_RETURNED` (5)** para que el checkout muestre una lista corta.
`SKYDROPX_CARRIERS` (opcional, slugs `provider_name` en minúsculas separados por comas) restringe el
`requested_carriers` — menos proveedores upstream = respuesta más rápida.
`getQuotationRate(quotationId, rateId)` re-consulta una cotización ya creada con un solo `GET` (sin poll —
el cliente solo pudo elegir un rate ya resuelto) y devuelve ese rate normalizado o `null` si ya no está
disponible; es la fuente autoritativa del costo de envío que usa `createOrder`.

Cada `NormalizedShippingRate` incluye `requiresDropoff` (`rateRequiresDropoff`): `true` cuando la
paquetería **no** recoge a domicilio. La señal es **combinada a propósito** — el campo estructurado del
rate (`pickup === false`) más un regex sobre `provider_service_name` (`/sin\s+recolecci[oó]n/i`), porque en
sandbox algunos servicios literalmente llamados "Sin recolección" venían con `pickup: true`; ante la duda
se prefiere sobre-avisar (el costo de un falso negativo es que el paquete nunca sale). Es un dato
**operativo para el dueño**, no para el comprador.

**Empaque y validación (Fase N.6 — ver `docs/features/multi-box-packing.md`).** `src/services/packing.ts`'s
`packOrder` acomoda el pedido en las cajas reales de la tienda y `buildParcels` devuelve un bulto por
caja; la cotización manda ese arreglo completo como `parcels`. `shipping.controller.ts` valida, antes de
cotizar, que cada producto tenga `weightKg`/`lengthCm`/`widthCm`/`heightCm` > 0 (mismo invariante que
`productSchema` exige desde Fase 8.2) — un producto con alguna dimensión en `0` daría una caja válida
pero subdimensionada, así que en ese caso se **salta la cotización en vivo directo al fallback de tarifa
plana**; lo mismo pasa si el acomodo pasa de `MAX_PARCELS_QUOTED` (10) bultos.
`POST /api/shipping/rates` está gateado por `shippingRateLimiter` (20 req/min por IP) — es público y sin
él un solo cliente podría acaparar el presupuesto de 2 req/s de toda la cuenta.

#### Empaque multi-caja (Fase N.6)

`src/services/packing.ts` acomoda el pedido en las cajas reales de la tienda (`DEFAULT_CARTONS`,
**el único lugar que editar** cuando el dueño mida las suyas) con un first-fit-decreasing por
volumen más una pasada de downgrade. **La cotización en vivo y la tarifa plana salen del mismo
`packOrder`**, así que caer al respaldo cambia el precio del bulto y nunca cuántos bultos son;
`Order.packageCount` congela ese conteo para la guía.

Detalle completo en `docs/features/multi-box-packing.md`.

#### Guía automática al pagar (Fase 8.5)

`createShipmentForOrder` (en `payment.service.ts`, fire-and-forget desde `markOrderPaidFromWebhook` tras el
guard `affected === 1`) crea la guía real (`POST /api/v1/shipments`, shape `{ shipment: { rate_id,
address_from, address_to, packages } }`) a partir del `skydropxRateId` guardado. Si la orden cayó al
fallback de tarifa plana no hay `rate_id` que convertir en guía: se loguea y se omite, el dueño la genera a
mano.

Dos hallazgos **no documentados** por Skydropx, confirmados por prueba y error:
`packages[].consignment_note` no es texto libre pese a describirse como "Waybill ID" — se valida contra el
catálogo SAT `c_ClaveProdServ` (Carta Porte, obligatoria para transporte terrestre en México desde 2022) y
un valor inventado da `422`; se usa un código fijo de "Calzado" (`53102400`). `packages[].package_type`
también es obligatorio pese a documentarse opcional; se usa `"4G"`, el valor de ejemplo de la doc oficial.

**La creación de la guía es asíncrona**: `POST /shipments` responde `202` con
`workflow_status: "in_progress"` y `tracking_number`/`label_url` en `null` (confirmado con 6 pollings a lo
largo de ~12s sin resolver). Por eso solo se persiste `Order.skydropxShipmentId` (disponible de inmediato);
`trackingNumber`/`trackingUrl`/`labelUrl`/`shipmentStatus` nacen `null` hasta que el webhook los reporte —
es el mecanismo diseñado para esto, así que no se hace polling bloqueante. El correo "tu pedido va en
camino" tampoco se dispara aquí: no hay `tracking_number` que mostrar todavía.

**Re-cotización.** Si el `skydropxQuotationId`/`skydropxRateId` guardado ya no está disponible (cotización
vencida —vigentes 24h— o el server se reinició entre el checkout y el pago), `createShipmentForOrder`
re-cotiza desde cero: reconstruye el parcel con las dimensiones **actuales** de `Product` para cada
`OrderItem` (no hay dimensiones congeladas, a diferencia de los precios) y llama a `getShippingRates` de
nuevo, prefiriendo un rate del mismo `carrier` que ya se le mostró al cliente. El `quotationId`/`rateId`
frescos se persisten, pero `order.shipping`/`order.total` **nunca** cambian — ya se cobraron.

#### Webhook de estado de envío (Fase 8.6)

`POST /api/webhooks/skydropx` (→ `order.controller.ts`'s `skydropxWebhook`), montado bajo el mismo
`/api/webhooks` con `express.raw` que el de Stripe. `verifySkydropxWebhookSignature` valida la firma
**HMAC-SHA512** del header `Authorization: HMAC <firma>` (hex minúsculas sobre el cuerpo crudo, con
`SKYDROPX_WEBHOOK_SECRET`) comparándola con `crypto.timingSafeEqual` (previo chequeo de longitud, que la
función exige) — nunca `===`. Firma ausente/mal formada/inválida o cuerpo no-`Buffer`/no-JSON → **400**;
cualquier evento verificado → `200 { received: true }` aunque no se maneje.

Solo se maneja el evento `packages` (payload JSON:API: `{ data: { type:"packages", attributes: { status,
tracking_number, tracking_url_provider, label_url }, relationships: { shipment: { data: { id } } } } }`).
**Ojo:** `data.id` es el id del **paquete**, no del envío; el `skydropxShipmentId` que persistimos viaja en
`relationships.shipment.data.id` — por ahí se localiza la orden (y también por `unreconciled:<ese id>`: el
evento es la prueba de que la guía existe, así que se aprovecha para escribirle el id real a la fila
marcada).

`applyShipmentUpdateFromWebhook` (tolerante a "orden no encontrada" como los handlers de Stripe) puebla
`trackingNumber`/`trackingUrl`/`labelUrl` **por primera vez** (los `*Url` solo se escriben cuando llegan no
nulos, para que un evento posterior que los omita no borre lo que uno anterior fijó), guarda
`shipmentStatus` (estado crudo íntegro) y avanza `Order.status` con `advanceOrderStatus` — `delivered` →
`delivered`, cualquier otro estado con actividad → `shipped`, **solo hacia adelante** (rango
`pending<paid<shipped<delivered`; un evento tardío nunca retrocede la orden, y una orden `cancelled` no se
reactiva). El correo "va en camino" (`sendShipmentEmail`, fire-and-forget) se dispara **exactamente una
vez**: la primera vez que llega un `tracking_number` se reclama con un guard atómico `Order.update({
...trackingNumber }, { where: { id, trackingNumber: null } })` — los eventos siguientes actualizan
estado/urls pero no reenvían el correo.

**Guard de idempotencia con centinela.** A diferencia del correo de confirmación (donde el guard es la
propia transición atómica de `paymentStatus`), aquí el id real de la guía solo se conoce **después** del
`POST` — que ya cuesta dinero real (doble guía = saldo gastado dos veces) — así que no puede usarse como
guard de antemano. `createShipmentForOrder` reclama el derecho a crear la guía con un valor centinela
(`Order.update({ skydropxShipmentId: "creating" }, { where: { id, skydropxShipmentId: null } })`) **antes**
de llamar a Skydropx; si el `UPDATE` no afecta ninguna fila, otra llamada ya está creando (o ya creó) la
guía y esta se retira sin tocar Skydropx. Si la creación falla, el centinela se libera para permitir un
reintento. El caso contrario —Skydropx **sí** creó y cobró la guía pero no se pudo guardar su id— **nunca**
libera el centinela: primero reintenta el `UPDATE` (`persistShipmentId`, 3 intentos con 1s de espera,
porque la causa típica es transitoria y es el único fallo de esta función que cuesta dinero) y, si aun así
no se puede, marca la fila con `unreconciled:<id real>` (best-effort) y alerta con severidad `fatal`.

#### Reintento de guía (Fase O.3)

`POST /api/admin/orders/:id/shipment/retry` `[auth]` más el cron gemelo
`src/services/shipmentRetrySweeper.ts`, para el pedido pagado que quedó sin guía (ningún webhook
puede llegar por una guía que nunca se creó). La pieza central son los **valores especiales de
`skydropxShipmentId`** — `"creating"` · `unreconciled:<id real>` · `unreconciled:desconocido` —, que
separan "se está creando" de "Skydropx ya la cobró" y evitan pagar una segunda guía.

Detalle completo en `docs/features/shipment-retry.md`.

### Dashboard

`src/routes/admin/adminDashboard.routes.ts`, `adminOrder.routes.ts`,
`src/controllers/dashboard.controller.ts`, `src/services/dashboard.service.ts`.

`GET /api/admin/dashboard` `[auth]` returns `DashboardData` (`kpisByPeriod`, `profitKpisByPeriod`,
`revenueByPeriod`, `recentSales`, `inventory`) computed **in memory** from `Order`/`OrderItem`/`Product` —
no aggregation tables.

**Sales are the orders with `paymentStatus: "paid"` — not `status: "paid"`**, which is what this used to
filter on and was a real bug fixed in Fase N.4: `Order.status` advances to `shipped`/`delivered`, so an
order **dropped out of revenue, the KPIs and `recentSales` the moment it was dispatched**.
`paymentStatus: "paid"` means "the money came in and hasn't gone back": it survives `shipped`/`delivered`
and only changes to `refunded` or `failed`, which is exactly what must *not* count as a sale.
`reports.service.ts`'s `loadReportData` carries the same predicate for the same reason; the
`status: "paid"` in `pendingShipmentWhere` (`payment.service.ts`) is **not** the same thing and stays —
there it literally means "paid and not yet shipped". Both `dashboard.test.ts` and `reports.test.ts` assert
the `WHERE` never constrains `status` again.

`kpisByPeriod`/`profitKpisByPeriod` follow the same shape as `revenueByPeriod`: all three `"7"|"30"|"90"`
windows computed together in one response (no query param — the frontend alternates client-side in
`DataSection`), via `buildKpisForWindow(dailyAgg, windowDays, todayStart)`. Per-order aggregation
(revenue/COGS/pieces/order-count) is folded into a single day-bucketed pass (`buildDailyAggregates` →
`Map<isoDay, DayAggregate>`) so each order's `unitCost` is summed once instead of re-scanned per window.
Each window's `trend` compares against its own equal-length prior window, which is why the shared order
fetch (`ordersHistory`) reaches back `2 * REVENUE_WINDOW_DAYS` (180) days.

`revenueByPeriod` returns all three series together (one `RevenuePoint` per calendar day, including `$0`
days — never skipped); day grouping (`isoDay`) and label formatting (`formatShortDate`) are **both pinned
to UTC** (`timeZone: "UTC"` on every `toLocaleDateString`/`toLocaleTimeString`) so the output doesn't
depend on the host's timezone — omitting that option silently rolls the label back a day on hosts west of
UTC (caught during manual testing on a `America/Mexico_City` dev machine).

`GASTOS` in `profitKpis` (Fase N.3, formerly the hardcoded `GASTOS_FIJOS = 2000`) comes from the `expenses`
table: the recurring monthly run-rate prorated to each window (`× windowDays/30`, so `"7"`/`"90"` don't
subtract a flat month from a week's or a quarter's gross profit) plus whatever one-time expenses fall
inside that window, each window summing its own. `DESCUENTOS POR CUPÓN` is the Fase N.2 KPI. `recentSales`
caps at the 20 most recent paid orders; `savings`/`shipping`/`total` per row reuse the frozen `Order`
columns directly (already computed at checkout) rather than recomputing from items. `inventory` includes
every non-soft-deleted product (including `visible: false`) since inventory value must reflect real
holdings regardless of storefront visibility.

#### El envío es costo de venta (Fase N.5)

`GANANCIA BRUTA = INGRESOS − costo de producto − COSTO DE ENVÍO`, and `GANANCIA OPERATIVA` stays
`BRUTA − GASTOS`. The bug this fixes: `Order.total` has always included the shipping charged
(`total = subtotal − savings − couponDiscount + shipping`) and `agg.revenue += order.total`, so INGRESOS
carried it — but COGS is only `Σ unitCost × quantity`, so **nothing subtracted it**. A $2,000 sale with a
$160 guía read as if all $2,000 bore margin, and gross/operating profit were inflated by exactly the
shipping. `DayAggregate` gained a `shipping` field summed in the **same day-bucketed pass**, so the
previous-window counterpart (and therefore the trend) comes for free; no query changed, since neither
`Order.findAll` in `getDashboardData` passes `attributes`.

**It is subtracted in gross profit and deliberately NOT added to `GASTOS`.** Shipping is a cost of sale —
one guía per order, exactly like the `unitCost` of each piece — not an operating expense. Since
`GANANCIA OPERATIVA = BRUTA − GASTOS`, routing it through both would subtract it **twice**. The same
amount is exposed **read-only** in `/api/admin/expenses/summary` and `/history` as a *derived* line so
the owner can see it in the expenses panel without the two numbers contradicting each other (see
`docs/features/expenses.md`, `DerivedShippingCost`). ⚠️ The corollary the owner must respect: boxes and packing
material **do** get captured as a `paqueteria` `Expense`; **the guías don't** — that's the double-count.

The source is **`Order.shipping`** (no new column, no migration): with a live Skydropx quote it *is* the
exact `rate.total` (pass-through, no markup), and the flat-rate fallback in `cart.ts` is calibrated to
cost. **Fase N.6 closed the largest of the accepted inaccuracies** — the flat rate used to be a `Math.max`
across cart item types that ignored quantity, so a 5-boot order charged $160 once while the carrier billed
per box; it now packs the cart into real cartons and charges **per box**, the same boxes the live quote
gets. Two accepted inaccuracies remain, both in the same direction (they **understate**, never inflate): a
re-quote or a hand-made guía is never reconciled against the real invoice, and a refund leaves
`paymentStatus: "paid"` so its already-paid guía drops out. Exactness would need an `Order.shippingCost`
column written at label creation — deliberately still not done.

`MARGEN BRUTO` now means `(INGRESOS − COGS − COSTO DE ENVÍO) / INGRESOS`, and its subtitle changed from
"sobre precio de venta outlet" (which described the *denominator*) to **"después de producto y envío"**
(which describes what changed — the numerator). The denominator is still cash collected, which *contains*
the shipping charged, so a heavier shipping mix mechanically dilutes it. **The percentage drops the day
this deploys** — that is the correction, not a regression.

`computeTrend` gained an optional `{ lowerIsBetter }` that flips only `positive` (never the `label`),
used by `COSTO DE ENVÍO`: without it the front would paint "shipping cost rose 40%" **green**.
`DESCUENTOS POR CUPÓN` keeps the old behavior on purpose (an expensive coupon isn't unambiguously bad —
it's the price of selling more) and `GASTOS` deliberately carries no trend at all.

`SaleRow` gained `shipping` because `total` already includes it: without the field the panel can't tell
`total − costoTotal` (inflated) from the row's real margin, `total − shipping − costoTotal`.

`GET /api/admin/orders` `[auth]` returns a **paginated** page of orders (`page`/`perPage`, default
`perPage: 20`, page clamped to `[1, totalPages]`) with their `items` included, most recent first,
**without** excluding `unitCost` (admin routes expose cost fields by design). The envelope is
`{ orders, total, page, perPage, totalPages }`; `total` comes from a separate `Order.count()` (no
`include`) to avoid the inflated row count `findAndCountAll` returns with a `hasMany` include, and the
`limit` + `items` include relies on Sequelize's subquery so the limit bounds orders (not joined rows).

### Manual order cancel/refund (Fase H.5)

`POST /api/admin/orders/:id/cancel` `[auth]` → `orders.service.cancelOrderByAdmin(id, reason?)`, for a
customer who asks to cancel outside the Stripe flow (WhatsApp, call). Body optional (`cancelOrderSchema`,
just a `reason` note for the log); `:id` goes through `parseId`.

**Only `pending` and `paid` are cancellable** — `shipped`/`delivered` (already shipped with a guía, don't
restock) and already-`cancelled` return `409`. A `pending` order reuses `releaseOrderStock` plus a
best-effort `stripe.paymentIntents.cancel` so the PI isn't orphaned. A `paid` order issues a **real full
refund** (`stripe.refunds.create({ payment_intent }, { idempotencyKey: \`refund-order-${id}\` })`)
**before** restocking — the idempotency key means two concurrent cancels never double-refund; the restock
runs in a transaction that re-checks `status === "paid"` under `FOR UPDATE` (a second concurrent cancel
finds it already closed and doesn't over-restock), then calls `releaseCouponForOrder` (after that guard, so
two concurrent cancels can't decrement twice — the `pending` branch needs nothing, `releaseOrderStock`
already does it) and sets `status:"cancelled"` / `paymentStatus:"refunded"` + `refundId`/`refundedAt`. A
**failed refund never restocks** (money didn't come back) **and never releases the coupon** — it logs,
`Sentry.captureException`s, fires `sendAlertEmail`, and throws `502`. This is the first and only refund
path in the code.

### Manual shipment status (Fase O.1)

`PATCH /api/admin/orders/:id/status` `[auth]` → `orders.service.updateOrderStatusByAdmin(id, input)`. The
only way an order reaches `shipped`/`delivered` **without** Skydropx. Before this, `Order.status` only
advanced there from `applyShipmentUpdateFromWebhook` — i.e. only when Skydropx reports a shipment Skydropx
created — so an order that fell back to the flat rate at checkout (no `skydropxRateId` → no label → no
webhook) stayed `paid` **forever**, with no "va en camino" email and counted as pending by the dashboard.

Body is `orderStatusUpdateSchema` (`src/schemas/checkout.ts`): `status` restricted to
`shipped`/`delivered`, plus optional `trackingNumber`/`trackingUrl` (zod `z.url()`)/`shippingCarrier`;
`:id` goes through `parseId`. **Zero new columns** — all four fields already exist on `Order` from Fase
8.5/8.6, so no migration.

Rules: **forward-only**, reusing the **same** `ORDER_STATUS_RANK`/`statusesBelow` the webhook uses (both
exported from `payment.service.ts` for exactly this) — a backwards move returns `409`; **repeating the
current status is allowed** (that's how a guía captured later gets attached to an order already marked
`shipped`). A `cancelled` order returns `409` and `cancelled` isn't an accepted `status` value at all
(`400`) — cancelling stays exclusive to `POST /api/admin/orders/:id/cancel`, the only path that refunds and
restocks; a still-`pending` order returns `409` too (shipping unpaid goods, and `pendingOrderSweeper` would
still cancel its PaymentIntent under it).

The status advance is its own atomic `UPDATE ... WHERE status IN (statusesBelow(target))`, the field writes
are "last wins" and only for keys actually sent (a status-only call never wipes a stored guía), and the
**"va en camino" email is claimed with the exact same atomic guard as the webhook**
(`Order.update({ trackingNumber }, { where: { id, trackingNumber: null } })` → only on `affected === 1`),
reusing the exported `sendShipmentEmail` with its `order-shipped/${id}` `idempotencyKey`. So the email
fires **exactly once per order** whether Skydropx or the owner supplied the tracking. Marking `delivered`
**without** tracking is valid (hand/local delivery) and sends no email. The email is fire-and-forget and is
handed the pre-reload `order` instance, not the `full` one being serialized back — `sendOrderEmail`
`reload()`s what it's given, and doing that to the response object would mutate it mid-serialization. This
is the first import of `payment.service` from `orders.service` (no cycle: `payment.service` never imports
`orders.service`).

### Reports

`/api/admin/reports/monthly` y `/replenishment` `[auth]`, calculados **en memoria** desde un único
fetch compartido y cacheado (`loadReportData`, TTL 60 s) de pedidos `paymentStatus: "paid"` + todos
los productos. El mensual agrupa unidades por `(mes UTC, productId)` sin huecos y valora al precio
**actual**; el de resurtido alimenta `computeForecast` (`src/services/forecast.ts`) con meses
completos por producto.

Detalle completo en `docs/features/reports.md`.

### Marca y usuarios (Fase 7)

`src/routes/admin/brand.routes.ts`, `adminUser.routes.ts`, `account.routes.ts`;
`src/controllers/brand.controller.ts`, `adminUser.controller.ts`.

`GET /api/admin/brand` `[public]` and `PUT /api/admin/brand` `[auth]` share one router but **not** a
blanket `router.use(requireAuth)` — `requireAuth` is applied directly on the `PUT` only, since the `GET`
must stay public (the storefront reads brand text from it). Both handlers `findOrCreate` the singleton
`BrandSettings` row (`id: 1`, defaults duplicated from `src/seed.ts`'s `BRAND_DEFAULTS` — **not imported**,
because `seed.ts` runs its full `seed()` side effect, including `process.exit`, at module load) instead of
`findByPk` + `404`, so the route works even on a dev DB where `pnpm seed` was never run (the frontend's
`MarcaSection` has no "not seeded yet" empty state). `PUT` validates with `brandSettingsUpdateSchema` (all
fields optional — the frontend autosaves one field at a time — all strings reject empty string since the
columns are `NOT NULL`). The **logo is not handled here**: `logoUrl`/`logoPublicId` are managed by
`POST`/`DELETE /api/admin/brand/logo`, and `brandSettingsUpdateSchema` no longer accepts `logoUrl` at all.

`GET /api/admin/users` `[auth]` lists `AdminUser` rows excluding `passwordHash` and the three
reset-password columns. `POST /api/admin/users` `[auth]` creates a user with a bcrypt-hashed
`tempPassword` — `createAdminUserSchema` requires the **same complexity as `loginSchema`** (min 8 chars +
uppercase + symbol, via the shared `PASSWORD_UPPERCASE_REGEX`/`PASSWORD_SYMBOL_REGEX` in
`src/schemas/auth.ts`); a weaker rule here would let a tempPassword hash successfully while being
permanently unable to pass `POST /api/auth/login`, which validates the same regexes before touching the DB.
A duplicate email is pre-checked (`409` with a specific message).

**`owner` and `admin` have identical route access** for all of `GET`/`POST`/`DELETE /api/admin/users` —
`requireRole` is not used anywhere in this phase, matching the Fase 1 seed comment that the two roles carry
the same permissions. `DELETE /api/admin/users/:id` still enforces two data-integrity guards independent of
role: `400` if the caller targets their own account (`String(id) === req.user!.id` — `req.user.id` is a
string from the JWT, `AdminUser.id` is an int) and `400` if the target is the last remaining `owner`. That
second guard runs inside a `sequelize.transaction` that locks the `owner` rows
(`findAll({ where: { role:"owner" }, lock: t.LOCK.UPDATE })`) rather than a plain `count()`, so two
concurrent deletes targeting two different owners can't both read the same pre-delete count and leave the
panel with zero owners; only locked/checked when the target itself is an `owner`. Both guards protect
against the panel losing all access rather than being permission checks.

`PUT /api/admin/account` `[auth]`, in the same `adminUser.controller.ts` (co-located with the `/users`
handlers, mirroring `order.controller.ts` backing both order routers), updates the caller's own row. Body
`{ currentPassword, email?, newPassword?, confirmPassword? }` (`updateAccountSchema`) —
`currentPassword` is **always** required and verified via `comparePassword` (defense-in-depth against a
leaked JWT, even for an email-only change); `email` and the password fields are independently optional so
the same endpoint serves the frontend's two separate buttons. `newPassword` requires the same complexity
for the same login-lockout reason. A changed email is pre-checked for uniqueness (`409`) rather than
relying solely on the generic `UniqueConstraintError` → 409 handler (that remains the safety net for the
small TOCTOU window). **Known limitation:** an email change does not re-sign the JWT, so the caller's token
keeps showing the old email until their next login.

### Imágenes / Cloudinary (Fase 3)

`src/config/cloudinary.ts` (its own `dotenv.config()`) **hard-requires** `CLOUDINARY_CLOUD_NAME` +
`CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` (throws at startup — side-effect imported from `app.ts` for
fail-fast) and exports the shared `cloudinary` v2 client plus `CLOUDINARY_PRODUCTS_FOLDER` /
`CLOUDINARY_BRAND_FOLDER`. `src/middlewares/upload.ts` is **multer with `memoryStorage`** (buffers never
touch disk; `fileFilter` allows only PNG/JPEG/WEBP → `AppError(400)`, `limits.fileSize` 5 MB) —
`uploadProductImages` (`upload.array("images", 3)`) and `uploadLogo` (`upload.single("logo")`).
`src/services/image.service.ts` uploads each buffer with `cloudinary.uploader.upload_stream` (returning
`{ url, publicId }`) and deletes via `uploader.destroy` — **not** `multer-storage-cloudinary` (its
peer-deps want multer/cloudinary 1.x; also, uploading manually keeps the `public_id` on hand for later
deletion). `destroyImage` is idempotent/tolerant.

**Product images** (`product.controller.ts`): `POST /api/admin/products/:id/images` `[auth]` uploads 1–3
images and appends them to `Product.images`, capping at 3 total. The cap is checked early (before
uploading) **and** re-checked under a row lock (`SELECT … FOR UPDATE` in a transaction) so two concurrent
adds can't both pass a stale count and clobber each other. Uploads are **all-or-nothing**
(`uploadAllOrCleanup`: if any of several fails, the successful ones are `destroy`ed so no orphan assets
survive an un-persisted op), and if the DB transaction throws, the just-uploaded assets are cleaned up too.
`DELETE /api/admin/products/:id/images` `[auth]` removes one image by `publicId` (in the body,
`deleteProductImageSchema`) under a row lock, **persists the DB change first, then** `destroy`s the asset
best-effort (a failed `destroy` leaves an orphan — acceptable — never a dangling reference that would break
the image in the store). Public reads run every row through `toPublicProduct`, which **strips `publicId`**
so the storefront only sees `url`/`imageSrc`. The admin hard-delete path also `destroy`s the product's
images; the soft-delete path keeps them (the row survives for order history).
`productSchema`/`productUpdateSchema` **no longer accept `imageSrc`** — images are set only through these
dedicated endpoints.

**Brand logo** (`brand.controller.ts`): `POST /api/admin/brand/logo` `[auth]` uploads and, after persisting
the new `logoUrl`/`logoPublicId`, `destroy`s the previous asset best-effort (new asset persisted before
deleting the old, so a failed `destroy` never loses the current logo). `DELETE /api/admin/brand/logo`
`[auth]` nulls both columns then `destroy`s best-effort.

**Multer errors**: `errorHandler` maps `MulterError` to `400` with a Spanish message — `LIMIT_FILE_SIZE`
(>5 MB for `images`/`logo`, >2 MB for the product-import `file` field — `err.field` picks the right
limit/message), `LIMIT_FILE_COUNT`, and `LIMIT_UNEXPECTED_FILE` — otherwise these would fall to a 500.

### Importación/restock masivo de productos

Alta y restock de mercancía subiendo un `.xlsx`, en **dos pasos**: `POST
/api/admin/products/import/preview` `[auth]` devuelve el plan por fila sin escribir nada, y `POST
/api/admin/products/import` `[auth]` aplica el **JSON** ya revisado (no el archivo original). El
restock **suma** stock y no se puede deshacer, así que todo el diseño está sesgado a **fallar la
fila antes que aplicarla en silencio**.

Detalle completo en `docs/features/bulk-import.md`.

### Error handling (`src/middlewares/`)

`asyncHandler` wraps async controller functions so thrown/rejected errors are forwarded to Express's error
pipeline instead of needing try/catch in each controller. Controllers throw `AppError(message, statusCode)`
for expected failures. `errorHandler` is registered last in `src/app.ts` and maps `ZodError`, Sequelize's
`UniqueConstraintError`/`ValidationError`, body-parser's malformed-body errors, `MulterError`, and
`AppError` to JSON responses with a Spanish `message`; anything else falls back to a logged 500 (also
`Sentry.captureException`). **When adding a new resource, use `asyncHandler` for its handlers and throw
`AppError` for expected error cases instead of returning ad-hoc status codes.**

**Error messages are the frontend's UI copy.** Every consumer (`usePlaceOrder.ts`, `ProductForm.tsx`,
`AccountCard.tsx`, `AdminsCard.tsx`, …) reads **only** `data.message` and paints it verbatim — **nothing
reads `details`**. So `message` must be a complete, actionable Spanish sentence: name the offending entity
and say what to do ("Solo queda 1 pieza de "X" en talla 24. Ajusta la cantidad para continuar."), not a
bare code or id. Consequences:

- `errorHandler` **composes `message` from a `ZodError`'s per-field messages** (one per field — a weak
  password fires 4 issues on the same path — capped at 3, then "(y N campos más por corregir)"), because a
  flat `"Datos inválidos"` left the user with no idea what to fix while the real messages sat unread in
  `details` (still returned, for programmatic use). This is safe only because **zod messages are our own
  Spanish copy**. Sequelize's `ValidationError` is deliberately **not** treated this way: its texts are
  English and name columns ("Product.name cannot be null"), so it keeps a fixed Spanish `message`.
- Since field messages reach the user, a schema field **without** a custom message would leak zod's English
  default. `src/config/zod.ts` (side-effect imported from `app.ts`) sets `z.config(z.locales.es())` as the
  safety net, but **give every user-facing field an explicit message anyway** — the localized default ("se
  esperaba número, recibido indefinido") is Spanish but still describes a type, not a fix. In zod 4 the type
  error is the **first** argument:
  `z.number("El peso (kg) es requerido").nonnegative("El peso no puede ser negativo")`.
- **`:id` params must go through `parseId(req.params.id, "producto")`** (`src/utils/parseId.ts`). A
  non-numeric id otherwise reaches Sequelize as `NaN`, Postgres rejects the query and the client's mistake
  surfaces as a **500** instead of a 400.
- **Anti-enumeration:** `POST /api/auth/login` returns **one identical message** for unknown-email and
  wrong-password. Same rule for `assertValidResetCode` (byte-identical across missing-user / wrong-code /
  expired / attempts-exhausted, so adding actionable text must not branch per cause) and for
  `GET /api/orders/lookup/:token`. The deliberate exception is `POST /api/coupons/validate`, documented
  in `docs/features/coupons.md`.

### Models (`src/models/`)

Models import the shared `sequelize` instance and call `Model.init(...)`. A model only gets its table
created/synced if it is imported somewhere in the startup path — `src/app.ts` side-effect imports every
model specifically to register it. Cross-model relations live in `src/models/associations.ts`, also
side-effect imported. **When adding a new model, add a matching side-effect import in `src/app.ts` and
declare its associations in `associations.ts`.**

**`Product`** stores `DECIMAL(10,2)` money fields (`originalPrice`, `salePrice`, `unitCost`) with custom
getters that `parseFloat` the values so the API returns numbers rather than strings. `type` is a Postgres
ENUM (`bota | sombrero | ropa`) — Postgres-specific, so the database must be PostgreSQL.
`discountPercent`, `stock` and `sizes` are all `VIRTUAL`: `discountPercent` derives from the two prices,
while `stock` (total) and `sizes` (repeated per unit, e.g. `[25, 25, 26]`) derive from the `ProductSize`
association (`productId`, `size`, `stock`, unique per `(productId, size)`) — the real source of truth for
stock per size. **Controllers must `include` the `productSizes` association for `stock`/`sizes` to
resolve**; without it they default to `0`/`[]`. Images live in `images` (`JSONB`, default `[]`, shape
`[{ url, publicId }]`, up to 3); `imageSrc` is a read-only `VIRTUAL` returning `images[0]?.url ?? null`
(kept for frontend compat — the source of truth is `images`, so there's no physical column to sync).

**`Order`** holds a frozen snapshot of totals and shipping data, plus nullable:
- `paymentIntentId` / `paymentStatus` (Fase 8; enum `unpaid|processing|paid|failed|refunded`);
- `skydropxQuotationId` / `skydropxRateId` (Fase 8.4 — the live quotation/rate used, `null` on the flat
  rate) and `shippingRequiresDropoff` (admin-only "no home pickup" flag from that same rate);
- `packageCount` (Fase N.6 — how many boxes the charged rate covers, frozen from `parcels.length` because
  the label is created minutes later in another process, where the catalog's dimensions may have changed
  and `GET /quotations/{id}` doesn't echo the quoted `parcels`; `null` on the flat rate, read as 1);
- `skydropxShipmentId` / `trackingNumber` / `trackingUrl` / `labelUrl` / `shipmentStatus` (Fase 8.5 — the
  last four stay `null` until the Skydropx webhook reports them, since shipment creation is asynchronous);
- `shipmentClaimedAt` (Fase O.3 — the moment `createShipmentForOrder` claimed the `"creating"` sentinel,
  i.e. the clock that decides when it counts as orphaned; a column of its own rather than `updatedAt`,
  which any other write bumps);
- `refundId` / `refundedAt` (Fase H.5 — the Stripe refund reference, populated only when a `paid` order is
  cancelled). Adding `refunded` to the enum needed an `ALTER TYPE ... ADD VALUE` migration
  (`20260722120600-order-refund-fields.ts`); its `down` recreates the enum without it and must drop+restore
  the column's `DEFAULT 'unpaid'` around the type swap (Postgres can't auto-cast a default across types);
- `publicToken` (Fase O.4 — the opaque UUID, unique index, sole credential of the public lookup; `null`
  only on rows predating the column);
- `couponId` / `couponCode` and non-nullable `couponDiscount` (default `0`) (Fase N.2 — the redeemed
  coupon, code and amount **frozen** like the `OrderItem` prices so a coupon edited afterwards can't
  rewrite history; the FK is `onDelete: "RESTRICT"` so a coupon with orders can never be deleted out from
  under one, and `couponDiscount` is deliberately not nullable so every consumer doing arithmetic skips the
  `?? 0`).

Besides `orders_public_token_unique`, `Order.init` declares four **hot-query** indexes (migration
`20260824120000-orders-hot-query-indexes.ts`): `orders_payment_intent_id` and
`orders_skydropx_shipment_id` — both **partial** on `IS NOT NULL`, since those columns are only ever
looked up by exact value (every Stripe webhook event and every Skydropx one) and are `null` on a large
share of rows — plus the composites `orders_payment_status_created_at` (dashboard/reports over their
180-day window, and `recentSales`) and `orders_status_created_at` (`pendingOrderSweeper` and
`pendingShipmentWhere`). The last two are composite **with `createdAt`** rather than on the status
column alone because all four callers pair the status with a date range and order by it. They're
declared in `Model.init` as well as in the migration for the usual `sync({ force: true })` reason, and
`tests/integration/orderIndexes.test.ts` reads `pg_indexes` to catch the drift between the two.

**`OrderItem`** freezes per-unit prices (`unitOriginalPrice`, `unitSalePrice`, `unitCost`) plus
`nameSnapshot` so historical orders aren't affected by later `Product` price changes. **`AdminUser`** (+
the three Fase 9 password-reset columns) and **`BrandSettings`** (singleton, with `logoUrl`/`logoPublicId`)
round out the Fase 1 data model. **`Coupon`** / **`CouponRedemption`** (Fase N.2): the latter's **partial
unique index** (`(couponId, emailNormalized) WHERE releasedAt IS NULL AND enforced`) is not bookkeeping but
the entire "one use per customer" guarantee, so it's declared in `Model.init` as well as in the migration.
**`Expense`** / **`ExpenseAmount`** (Fase N.3): `Expense` is identity + schedule (`concept`, `vendor`,
`category`, `frequency`, `startsAt`/`endsAt` as **`DATEONLY`**, `active`, `notes`) and carries **no
`amount` column** — the money lives in `ExpenseAmount`, versioned by `effectiveFrom`, with its unique
`(expenseId, effectiveFrom)` index likewise declared in `Model.init`.

### Logging y monitoreo (Fase H.4)

`src/config/logger.ts` exports a shared `pino` instance (`logger`) used everywhere a background job,
webhook handler, or fire-and-forget side effect used to `console.*` — level defaults to `info` in
production (one JSON line per record) / `debug` in dev (pretty-printed via `pino-pretty`), overridable with
`LOG_LEVEL`. There is **no** request-logging middleware (`pino-http`) — every logged flow here is a
cron/webhook/background send, not an HTTP request, so instrumenting every public `GET` would add noise the
roadmap doesn't ask for. Context fields are passed pino's object-first way (`logger.warn({ orderId },
"mensaje")`); the field name **`err`** is used consistently for `Error` objects so pino's default
serializer expands `err.stack` automatically.

`src/config/sentry.ts` initializes `@sentry/node` **only if `SENTRY_DSN` is set** (logs a warning and
continues otherwise) — unlike Stripe/Resend/Cloudinary/Skydropx, Sentry is opt-in monitoring, not a
business dependency, so it doesn't hard-require its env var. It's imported as the very first line of
`src/app.ts` (before even `express`) so it's armed before any other config module's fail-fast validation
could throw.

`src/services/alert.service.ts`'s `sendAlertEmail({ subject, context })` reuses `sendEmail` (which never
throws) to send an operational email to `ALERT_EMAIL_TO` (optional — no-ops with a log warning if unset)
for: `createShipmentForOrder` failing to generate a Skydropx label (unconditionally, `fatal` severity, when
Skydropx already **charged** for the label but persisting its id failed — the highest-priority case; at
warning severity and **only when `notifyOnFailure` is on** for the non-monetary branch),
`shipmentRetrySweeper` exhausting its 3 retries for the same order (one alert, not one per cycle),
`pendingOrderSweeper`'s per-order reconciliation catch crossing `REPEATED_FAILURE_ALERT_THRESHOLD` (3)
consecutive failures (tracked in an in-memory `Map<orderId, consecutiveFailures>` that resets on success or
when the order leaves the stale window, deliberately **not** persisted — acceptable for a soft operational
alert, not a correctness guarantee), a payment captured against a cancelled order, and (Fase O.7)
`sendOrderEmail` (`payment.service.ts`, the shared helper behind the confirmation/"va en camino"/
token-rotated emails) failing to actually deliver. `email.service.ts`'s own two failure branches stay
log-only **by design** — routing them through `sendAlertEmail` would create a loop where a Resend outage
tries to alert about itself over the same broken channel. `src/seed.ts`'s `console.log`s are unchanged (a
one-off CLI script).

**`sendEmail` returns `true`/`false` (Fase O.7)**, not `void`: the SDK's `{ data, error }` failure mode
doesn't throw, so a plain `try/catch` around it is blind to a rejected send — a real incident (an
`EMAIL_FROM` still pointing at `onboarding@resend.dev` after the domain was verified) had Resend silently
403 every confirmation email to anyone but the account owner, with no signal anywhere that it had
happened. `sendOrderEmail` now reads that boolean (alongside its existing `reload()`/exception catch) and,
on either kind of failure, fires `sendAlertEmail` with the order id, recipient and `idempotencyKey` — the
one caller of `sendEmail` that acts on the return value; the other four (`auth.controller.ts`,
`ownerNotification.service.ts`, `dailySalesDigest.ts`, `alert.service.ts` itself) still fire-and-forget it
the same as before. Since `sendAlertEmail` itself reuses `sendEmail`, a true Resend outage makes the alert
fail the same silent way — accepted, same as every other alert in this section; what this catches is
exactly the config-error case that isn't a Resend outage.

**`alert.service.ts` is for failures only** — the *business* notifications (a new sale, the daily digest)
live in `src/services/ownerNotification.service.ts` with their own recipient, so the owner can filter, mute
or redirect "you sold something" separately from "something broke".

### Testing (Fase H.1)

**`jest` + `ts-jest` + `supertest`**, living in **`tests/`**, deliberately **outside `src/`** — `tsc`
compiles `src/`→`dist/`, so a test under `src/` would ship to production; `ts-jest` transpiles `tests/`
in-memory and `tsc` ignores them. `jest.config.ts` points `ts-jest` at **`tsconfig.jest.json`** (a separate
file, not an inline object — an inline `tsconfig` **replaces** the base config instead of merging, dropping
`@types` resolution; the file `extends` the base but moves `rootDir` to the repo root and adds
`types: [jest, node]`).

`roadmaps-completados/roadmap-testing.md` breaks the work into **independent parts** (0 = infra; 0.5 =
dedicated test DB; 1 = pure services; 2 = auth; 3 = checkout; 4 = webhook idempotency; 5 = manual
cancel/refund/release; 6 = live shipping rates; 7 = Skydropx HTTP client; 8 = admin product CRUD + images;
9 = brand/admin users; 10 = dashboard/reports aggregations) — **all twelve are done** (62 suites / 811 tests
at last count; new phases add their own suite, e.g. `adminOrderStatus.test.ts` (O.1),
`checkoutIdempotency.test.ts` + `pendingOrderSweeper.test.ts` (O.2), `shipmentRetry.test.ts` (O.3),
`orderLookup.test.ts` + `unit/services/orderConfirmationTemplate.test.ts` (O.4), the six coupon suites
(N.2), `adminExpenses.test.ts` + `unit/services/expenses.test.ts` (N.3), and `newOrderNotification.test.ts`
+ `dailySalesDigest.test.ts` + `unit/utils/storeDay.test.ts` +
`unit/services/newOrderNotificationTemplate.test.ts` (N.4), `unit/services/packing.test.ts` (N.6), and
the pre-production hardening trio `unit/config/apiDocs.test.ts` + `integration/orderIndexes.test.ts`
+ the `booleanEnv`/`apiDocsEnabled` blocks in `unit/utils/env.test.ts`, and the deploy-prep pair
`integration/bootstrapAdmin.test.ts` + `unit/config/auth.test.ts`).
Keep adding tests **part by part**, marking
`[x]` as each closes, and don't touch `src/` from a test change unless a test reveals a real bug.

**Three levels, each behavior where it belongs:**
1. *Pure unit*, no DB — import and call the function (`cart`, `forecast`, `formatMoney`, `date`,
   `dashboard`/`reports` aggregation, `skydropx` service with `fetch` mocked, `sentry`, `errorHandler`).
2. *HTTP integration* — `request(app)...` against a **real test Postgres**, the full
   route→middleware→controller→service→DB flow (`auth`, `checkout`, `products`, `shippingRates`,
   `adminProducts`, `adminBrandUsers`).
3. *Service + mocked SDK* — call the service directly with `Promise.all` and a real DB for
   concurrency/idempotency (`webhooks`, `cancelOrder`).

Controllers are **not** tested in isolation with everything mocked — the logic lives in services (levels
1/3) and the HTTP flow is covered end-to-end by Supertest (level 2). **Stripe, Skydropx and Resend
(`sendEmail`) are ALWAYS mocked** (they cost money or send real emails); the **DB is never mocked** — a real
Postgres, **never sqlite**, because the code depends on `ENUM`, `JSONB` and `literal('stock - N')`.

`tests/setup/env.ts` (Jest `setupFiles`) sets `NODE_ENV=test` and loads **`.env.test`** (gitignored, dummy
keys satisfying each `config/*` fail-fast + a `DATABASE_URL` pointing at a dedicated test DB) with
`override: true` **before** any `config/*` runs its own `dotenv.config()` (which by default does **not**
override existing keys). `tests/setup/db.ts` exposes `setupTestDatabase()` (`authenticate` +
`sync({ force: true })`), `truncateAll()` and `closeTestDatabase()`. **Because `sync({ force: true })`
DROPS and recreates every table, `.env.test`'s `DATABASE_URL` must point at a throwaway test database,
never dev/prod.** `tests/setup/factories.ts` builds Product/AdminUser/Order/OrderItem rows;
`tests/setup/mocks/{stripe,skydropx,resend}.ts` are the reusable SDK-mock builders. **When adding a test
that needs the DB, use these helpers — don't spin up a second sequelize instance.**

`jest.config.ts` sets **`maxWorkers: 1`**: every integration suite's `beforeAll` runs `sync({ force: true
})` against the same test Postgres, and Jest's default parallel workers stomping on that concurrently
produces intermittent `ENUM already exists` / `relation does not exist` errors — a single worker serializes
all suites and removes the race. Don't re-parallelize without also fixing that shared-DB contention.

`pnpm test` also runs automatically on every PR and on pushes to `main` via GitHub Actions
(`.github/workflows/ci.yml`, Fase H.6 — Postgres service container, `pnpm build`, then `pnpm test`).

### CI/CD (`.github/workflows/ci.yml`)

Three jobs, on every PR against `main` and every push to `main`. `Build & Test` is the original
Fase H.6 job (`pnpm build` + `pnpm test` against a Postgres 16 service container) — **its name is a
required status check on the protected branch, so renaming the job silently breaks the merge
gate**, since protection matches checks by context string.

`Migrations` runs `pnpm migrate` → `migrate:status` → `migrate:undo:all` → `pnpm migrate` against
its **own** Postgres service (the test job's `sync({ force: true })` drops every table, so sharing
one database would have them stomping on each other). It exists because Render's
`preDeployCommand` is `pnpm migrate` and **there is no `sync({ alter: true })` anywhere** to paper
over a broken migration — without this job a typo in an `up` surfaces in production. The
`undo:all` leg is what covers the `down`s, i.e. the `DROP TYPE` for the ENUM that `dropTable`
doesn't drop (see **Migrations**).

`Deploy (Render)` `needs: [test, migrations]`, runs **only** on a push to `main`, and `POST`s to
Render's Deploy Hook (`RENDER_DEPLOY_HOOK_URL`, a repo secret). It's paired with
**`autoDeploy: false` in `render.yaml`**: with Render's default, a push started a build in
parallel with CI and never learned the result, so a commit with red tests deployed anyway. The
step no-ops with a `::warning::` when the secret is missing, so CI doesn't break while it's being
configured. ⚠️ `autoDeploy` in the Blueprint only applies on create/sync — an already-created
service also needs Auto-Deploy turned off in its dashboard.

The workflow declares `permissions: contents: read` (no job writes to the repo) and a
`concurrency` group that cancels superseded runs **on PRs only** — cancelling on `main` would
leave a commit undeployed.

**Dependabot is two mechanisms, and only one of them lives in this repo.** `Dependabot alerts` +
`Dependabot security updates` are **repo settings**, not a file, and they're what actually
protects the project: they fire only on a real vulnerability, **including transitive ones in
`pnpm-lock.yaml`** (turning them on surfaced 18 open alerts at once — `brace-expansion`,
`fast-uri`, `ip-address`, `js-yaml`, `uuid` — every one of them transitive, which is why nobody
had seen them). `.github/dependabot.yml` is the *other* one, routine version bumps, kept
deliberately quiet: npm **monthly**, `open-pull-requests-limit: 2`, minors/patches grouped into
one PR, **no `github-actions` block at all** (the accepted cost: a deprecated action runtime has
to be bumped by hand, which the CI itself announces loudly). It ignores majors of `stripe` (the
pinned `apiVersion` literal, see **Payments / Stripe**) and of `sequelize`/`sequelize-cli`.

**`main` is protected** and the rule applies to admins too (`enforce_admins`), so **nothing lands
by direct push, including your own commits**: PR required (0 approvals — solo repo), `Build &
Test` + `Migrations` green, branch up to date (`strict`), conversations resolved, linear history,
no force-push or deletion. The repo allows squash/rebase only and deletes the branch on merge.
`gh pr merge --squash --auto` is the normal way to land work.

## Conventions

- TypeScript runs in `strict` mode with decorators enabled (`experimentalDecorators`,
  `emitDecoratorMetadata`); source in `src/`, output in `dist/`.
- **Configuration comes exclusively from environment variables.** `.env` is gitignored — never commit it
  (the Stripe/Resend keys are test/sandbox; Skydropx points at its own separate sandbox account).
  **`.env.example` at the repo root is the versioned, canonical list** (`.gitignore` names `.env` and
  `.env.test` literally, so it isn't ignored) — it's what gets copied when registering the service with a
  PaaS, and it marks each variable required-vs-optional with its default. **When you add a new env knob to
  the code, add it there too**; `README.md` §Variables de entorno now points at it instead of repeating
  the list, so the two can't drift.
  - **Required (server throws at startup without them):** `DATABASE_URL`, `JWT_SECRET`,
    `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, the three
    `CLOUDINARY_*` keys, `SKYDROPX_CLIENT_ID`, `SKYDROPX_CLIENT_SECRET`, `SKYDROPX_WEBHOOK_SECRET`, and all
    eight `SHIP_FROM_*`
    (`POSTAL_CODE`/`STATE`/`CITY`/`NEIGHBORHOOD`/`STREET`/`EXTERNAL_NUMBER`/`NAME`/`PHONE`).
  - **Optional:** `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `DATABASE_SSL` (`false`) and
    `DATABASE_SSL_REJECT_UNAUTHORIZED` (`true`) — see **Database**, and note that `?sslmode=` in the
    URL is *not* an alternative, `JWT_EXPIRES_IN` (`7d`), `BCRYPT_ROUNDS` (10),
    `FRONTEND_URL`, `STRIPE_CURRENCY`,
    `PENDING_ORDER_TTL_MINUTES` (30), `PENDING_ORDER_SWEEP_INTERVAL_MINUTES` (10), `SKYDROPX_BASE_URL`
    (sandbox host), `SKYDROPX_CARRIERS`, `SHIPMENT_RETRY_DELAY_MINUTES` (15),
    `SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES` (10), `HEALTH_READY_TIMEOUT_MS` (3000), `MIN_CHARGE_MXN` (10),
    `DAILY_DIGEST_HOUR` (8), `DAILY_DIGEST_CHECK_INTERVAL_MINUTES` (15), `SENTRY_DSN` (enables Sentry if
    set), `ALERT_EMAIL_TO` (operational alerts), `OWNER_NOTIFICATION_EMAIL` (business notifications, falls
    back to `ALERT_EMAIL_TO`; with neither set, Fase N.4 is off — deliberately its only switch),
    `LOG_LEVEL`, `TRUST_PROXY`, and `API_DOCS_ENABLED` (serves `/api/docs` + `/api/docs.json`;
    defaults to on outside production, off in it). The five `BOOTSTRAP_ADMIN_*`/`BOOTSTRAP_RESET_PASSWORD`
    vars are read **only** by `src/scripts/bootstrapAdmin.ts`, never by the server.
  - **`JWT_SECRET` fail-fasts in `src/config/auth.ts`** (same pattern as `stripe.ts`/`resend.ts`: own
    `dotenv.config()`, hard-require, side-effect imported from `app.ts`). Until that module existed both
    `auth.controller.ts` and `requireAuth.ts` read it as `process.env.JWT_SECRET!` with **nothing
    validating it**, so a deploy missing it booted happily, served the public catalog, and only blew up
    with a **500 on the first login** — the symptom arriving far from the cause. It also pins
    `JWT_EXPIRES_IN` to an explicit `"7d"` default: the old `expiresIn: process.env.JWT_EXPIRES_IN`
    produced `undefined` when unset, i.e. **tokens that never expire**, unrevocable without rotating the
    secret and logging everyone out.
  - **Numeric knobs go through `positiveNumberEnv` (`src/utils/env.ts`)**, not a bare
    `Number(process.env.X ?? default)`: `??` only falls back on `undefined`, so a blank line in `.env`
    parses as `0` and a typo as `NaN` — and a `0` retry margin means a sentinel claimed milliseconds ago
    counts as orphaned, so a concurrent retry would pay for a second label. **Use it for any new numeric
    env knob.** Note it rejects `0`, so the valid digest hour is 1–23 (a known, costless limitation).
    `MIN_CHARGE_MXN` and the digest knobs live in their services, **not** in a `config/*`, for the
    mock-shadowing reason documented in `docs/features/coupons.md`. `PENDING_ORDER_TTL_MINUTES` and
    `PENDING_ORDER_SWEEP_INTERVAL_MINUTES` were the last two holdouts and were converted too — there
    are now **no** bare `Number(process.env…)` knobs left.
  - **Boolean knobs go through `booleanEnv` (`src/utils/env.ts`)**, never a bare
    `Boolean(process.env.X)` / `=== "true"`: every non-empty string is truthy, `"false"` included —
    exactly what someone types to turn a flag *off*. It accepts `true`/`false`/`1`/`0` case- and
    space-insensitively and falls back with a warning on anything else, so a typo can never flip a
    flag *on*. `apiDocsEnabled()` is the policy built on it.
  - **`TRUST_PROXY`** is the value handed to `app.set("trust proxy", ...)`, parsed by `trustProxyEnv`:
    `undefined` when unset/blank so `app.ts` never calls `app.set` at all, an integer as a hop count,
    `true`/`false`, anything else passed through as an address list/preset. **Every rate limiter counts by
    `req.ip`**, which behind a proxy (Render/Railway/Fly/nginx/Cloudflare — the normal deploy shape here)
    is the proxy's own address unless Express is told how many hops to trust: without it the limits stop
    being per-client and become **one bucket for the whole store**. It is deliberately **not** on by
    default: trusting `X-Forwarded-For` on a directly-exposed server lets anyone bypass the limiters by
    rotating fake IPs, so only whoever deploys knows the right value (`TRUST_PROXY=1` is the usual PaaS
    starting point).
- **Dependencies wired in** — prefer these when implementing those features: `jsonwebtoken` + `bcrypt`
  (auth), `zod` (validation), `express-rate-limit` (auth, shipping rates, checkout, order lookup, coupon
  validation), `swagger-jsdoc` + `swagger-ui-express` (API docs), `stripe` (payments), `cloudinary` +
  `multer` (image uploads; `multer-storage-cloudinary` is installed but **unused**), `resend`
  (transactional emails), `pino` + `pino-pretty` (structured logging), `@sentry/node` (optional error
  tracking), and `exceljs` (the `.xlsx` import — chosen over `xlsx`/SheetJS for its lack of
  prototype-pollution CVE history). Skydropx has no SDK — `skydropx.service.ts` calls its REST API with the
  native `fetch`.
- `pnpm-workspace.yaml` holds the pnpm `allowBuilds` map (which dependency lifecycle scripts may run, e.g.
  `bcrypt: true`, `@scarf/scarf: false`). pnpm v11 errors on undecided build scripts, so new deps with
  install scripts must be resolved via `pnpm approve-builds`.
- `jest` + `ts-jest` + `supertest` (+ `@types/*`) are devDependencies for the test suite.
- `sequelize-cli` + `ts-node` + `typescript` drive schema migrations via `.sequelizerc` /
  `src/config/sequelize-cli.js`, and are **`dependencies`, not devDependencies** (Fase de despliegue):
  the deploy pipeline runs `pnpm migrate` as a pre-deploy step, and a `pnpm install --prod` there would
  otherwise leave the command without a binary. `typescript` has to move with them — `ts-node` doesn't
  run without it. Verified by installing with `--prod` in a clean copy and running the CLI.

## Workflow

- **Before pushing to GitHub** (any commit/push the user requests): verify that `README.md` and this
  `CLAUDE.md` are up to date with the changes being committed, and update them if needed, **before**
  running the commit/push.
- **Whenever a commit/push adds or changes routes** (new `*.routes.ts`, a new `router.<method>`, or a
  changed path/params/response): the Swagger documentation MUST be written/updated first — an `@openapi`
  JSDoc block for each new or changed endpoint (and any new `components.schemas` in
  `src/config/swagger.ts`) — before running the commit and push.
- **Whenever a model gains, loses or changes a column, or a new model is added**: write the matching
  migration in `src/migrations/` **in the same commit** — there is no `sync({ alter: true })` fallback
  anywhere, dev included. If the schema object also backs a `sync({ force: true })` path (indexes!),
  declare it in `Model.init` too.
- **Whenever a change the frontend needs to consume lands** (a new/changed endpoint — path, params, request
  body, or response shape — a new value/column that reaches a response the storefront or admin panel reads,
  or an enum the frontend renders): add or update the matching phase in
  `../frontend/ROADMAP-BACKEND-INTEGRATION.md`. Add a row to its "Mapa de endpoints ↔ consumidor" table and
  a new `### Fase N —` section (mark it 🔴 **Pendiente** until the frontend is wired), matching that file's
  style: a "Lo que el backend ya hace (referencia — no tocar)" block and a "Trabajo del frontend"
  checklist. Purely internal changes the frontend never sees (cron jobs, webhooks, logging, graceful
  shutdown, migrations with no response impact) don't need an entry. **This is documentation only — never
  write frontend code unless the user asks.**
- **Whenever `src/` code changes** (new behavior, a bug fix, an edited condition/branch): check whether the
  existing tests under `tests/` still cover it, and update or add a test in the same change — don't leave a
  behavior change untested until someone notices in prod. A **new** test must cover more than the happy
  path: alongside the `201`/`200` success case, assert the adjacent failure/edge cases that same code path
  can hit (validation `400`, not-found `404`, conflict `409`/`503` where the code has that branch,
  authorization `401`/`403` where relevant, and boundary values — empty/zero/negative/duplicate input) —
  not just one assertion but the shape of the response for each (status code **and** the relevant body
  fields/`message`), and follow the three testing levels and fixtures already described in **Testing**
  (`tests/setup/factories.ts`, the SDK mocks, real Postgres, no controller-level mocking) rather than
  inventing a new pattern.
