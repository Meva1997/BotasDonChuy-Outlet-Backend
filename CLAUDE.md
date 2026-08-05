# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This project uses **pnpm** (`packageManager: pnpm@11.8.0`).

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

### Startup flow (`src/app.ts`)

`dotenv` → create app → `trust proxy` when `TRUST_PROXY` is set (it decides whether `req.ip`, and
therefore every rate limiter, sees the real client or the proxy — see **Conventions**) → global
middleware (`helmet`, `cors` with `CORS_ORIGIN` as a comma-separated list split/trimmed into an array,
JSON + urlencoded parsers) → Swagger UI at `/api/docs` (+ raw spec at `/api/docs.json`) → routers →
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

### Migrations (`src/migrations/`, Fase H.2)

The versioned, reproducible path to change schema, dev and prod alike. `sequelize-cli` is driven by
`.sequelizerc` at the repo root, which registers `ts-node/register` (migrations are authored in
TypeScript; this CLI version's glob matches `.ts` natively) and points
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

- `q` searches `name` and `code` with `Op.iLike` (`code` is nullable — a `NULL` simply doesn't match
  inside the `OR`), and the value **must** go through **`escapeLike` (`src/utils/escapeLike.ts`)**:
  Sequelize parameterizes the value but does **not** escape LIKE's `%`/`_`, so `?q=100%` would match
  the entire catalog. This repo already paid that bug once — in `productImport.service.ts` a row named
  `"Bota%Premium"` matched `"Bota Roja Premium"` and **renamed it**. `escapeLike` also escapes `\`
  itself (LIKE's default escape char in Postgres, so no explicit `ESCAPE` clause is needed) — without
  it, `?q=\` would leave a dangling escape and Postgres's `22025` would surface as a **500**.
- `orden` accepts `precio_asc`/`precio_desc`/`novedad` (`id DESC`), default `id ASC`. The two price
  orders carry an **`id` tiebreaker in the same direction as the price**: prices tie constantly and
  Postgres guarantees no stable order without it — page 2 would repeat and drop rows — plus it lets the
  `("salePrice","id")` index serve `precio_desc` as a plain backward scan.
- `precioMin`/`precioMax` use **`Number.isFinite` and `>= 0`, not `Number.isInteger`** (`salePrice` is
  `DECIMAL(10,2)`, so `precioMax=1499.99` is legitimate).
- **Every invalid param is silently ignored, never a `400`** — the precedent `talla` set here; a
  `precioMin` above `precioMax` is **not** swapped (zero results is the honest answer).

Two **partial** indexes back this (`20260729120000-products-catalog-indexes.ts`, mirrored in
`Product.init()`'s `indexes` as the rule requires): `products_type_visible` on `type`, and
`products_sale_price_visible` on **`("salePrice","id")`** — composite because a single-column index
can't satisfy `ORDER BY "salePrice", id` without an incremental sort, which is the whole reason it
exists. Both are partial on `visible = true AND "deletedAt" IS NULL`, the predicate every public query
carries verbatim (the one listing that doesn't, `adminGetProducts`, has no `WHERE` at all). A
`pg_trgm` GIN index on `name` was **deliberately deferred**: the blocker isn't the index but
`CREATE EXTENSION`, which `sync({ force: true })` never runs — the test DB and CI's Postgres container
would build a schema where the GIN index fails. Revisit when the seq-scan `ILIKE` shows up in latency.

`availableSizes` (all sizes with stock > 0 matching `categoria`, `q` and the price range, but
**independent of the `talla` already chosen**) is a separate raw `sequelize.query` aggregate over
`product_sizes` joined to `products`, since it must scan the whole filtered set rather than one page.
Each half of that rule guards a different dead-end: excluding `talla` means picking a size never
empties the size selector; including `q`/price means it never offers a size that returns zero products
under the active search. Its predicates are a **hand-maintained copy** of the shared `where` (it's raw
SQL) — **a new filter must be added on both sides**. Every value goes through `replacements`, never
interpolation: unlike `talla` (an already-validated integer), `q` is arbitrary client input.

**Admin product CRUD** lives in `src/routes/admin/adminProduct.routes.ts` (`/api/admin/products`,
`router.use(requireAuth)`) and reuses `product.controller.ts`. Unlike public reads it exposes
non-visible rows and `unitCost`. Create/update validate with `productSchema`/`productUpdateSchema`
(zod) and write tallas/stock to `ProductSize` inside a `sequelize.transaction`; `sizes` accepts a
`"25,25,26"` string or a number array (each repeat = one stock unit). `DELETE` soft-deletes
(`deletedAt` + `visible:false`) when the product is referenced by an `OrderItem`, otherwise
hard-deletes (its `ProductSize` rows cascade).

### Cupones y códigos de descuento (Fase N.2)

`src/models/Coupon.ts`, `CouponRedemption.ts`, `src/services/coupon.service.ts`,
`src/schemas/coupon.ts`, `src/utils/emailIdentity.ts`; `POST /api/coupons/validate` `[público]` + CRUD
en `/api/admin/coupons` `[auth]`.

La única palanca de descuento que no toca el catálogo. El cliente manda un **código** y **jamás un
monto** — misma regla que ya rige precios y envío. `Coupon` lleva `code` (alfanumérico en mayúsculas,
índice único), `type: percent|fixed`, `value`, `maxDiscount?` (tope en pesos, **solo** para `percent`),
`minSubtotal?`, `maxRedemptions?` (`null` = ilimitado), `redeemedCount`, `oncePerCustomer` (default
`true`), `startsAt?`/`expiresAt?`, `active` (ponerlo en `false` **es** "cancelar el cupón") y
`description?`. Puede haber varios activos, pero **uno solo por compra** (`couponCode` es un `string`).

**El descuento se calcula en `computeCouponDiscount` (`src/services/cart.ts`)**, única implementación,
compartida por `createOrder` y por `/validate` — si fueran dos, el preview podría prometer un descuento
distinto al que se cobra. `computeTotals` **no se tocó** (su test unitario afirma con `toEqual` sobre
exactamente cuatro claves, y lo que hacía falta compartir no eran "totales" sino "cuántos pesos quita
este cupón"). Tres invariantes, cada uno tapando una forma distinta de perder dinero:

1. La base es la **mercancía neta `subtotal − savings`** — aquí `subtotal` está a precio *original*,
   así que calcular sobre él regalaría porcentaje sobre un precio que nadie paga, y un `minSubtotal` de
   $1000 se cumpliría con un carrito que vale $600.
2. **El envío no entra**, y no es un parámetro de la función justamente para que no pueda colarse (un
   cupón de producto no debe regalar la paquetería, que se paga a un tercero).
3. **Clamp a `[0, neto]`**: un `fixed` de $5,000 sobre un carrito de $1,600 descuenta $1,600 y nunca
   deja un total negativo.

Todo se calcula en **centavos enteros** con un solo redondeo antes de tocar la BD: la columna es
`DECIMAL(10,2)` y sin eso Postgres redondearía por su cuenta (medio hacia afuera del cero) mientras
`/validate` —que no pasa por la BD— mostraría el de JS (medio hacia arriba), difiriendo un centavo en
los porcentajes que caen justo a la mitad. **El invariante nuevo de toda la app es
`total = subtotal − savings − couponDiscount + shipping`.**

**La identidad de "una persona" es el correo del pedido, NO la IP** (`normalizeEmailIdentity`:
minúsculas, `+tag` recortado en todos los dominios, puntos quitados solo en
`gmail.com`/`googlemail.com`). La IP era la opción intuitiva y es la peor: detrás de CGNAT (cualquier
plan móvil, Izzi, Totalplay) media colonia sale por una sola dirección, y además `req.ip` depende de
`TRUST_PROXY` — desplegado detrás de un proxy sin esa env, **todos** los compradores se ven con la IP
del proxy y el primer canje mataría el cupón para la tienda entera. Se guarda en
`coupon_redemptions.ip` **solo como dato forense** (viaja como `CheckoutContext.clientIp` desde
`req.ip`, nunca desde el body) y ninguna decisión la consulta. La normalización **sobre-fusiona a
propósito** (alguien cuyo buzón realmente distinto sea `juan+trabajo@` queda bloqueado, y por eso el
mensaje de error nombra el correo). La barrera **dura** contra el abuso no es la identidad sino
`maxRedemptions`: acota la pérdida máxima a `usos × descuento` sin importar quién canjee.

**El canje es atómico y va dentro de la transacción del checkout**, con dos candados y ningún `SELECT`
+ `if` (dos compradores simultáneos leerían los dos "sí se puede"):

1. El tope global es un `Coupon.update({ redeemedCount: literal('"redeemedCount" + 1') }, { where: {
   id, active: true, maxRedemptions IS NULL OR redeemedCount < maxRedemptions, + ventana de vigencia
   } })` — `affected === 0` es el 409, misma forma que el descuento de stock. **Ojo con las
   comillas**: la columna es camelCase y Postgres pliega a minúsculas los identificadores sin comillas,
   así que `literal('redeemedCount + 1')` buscaría `redeemedcount` → 500.
2. El "un uso por cliente" lo decide el **índice único parcial** `coupon_redemptions (couponId,
   emailNormalized) WHERE releasedAt IS NULL AND enforced`, vía un `INSERT ... ON CONFLICT ... DO
   NOTHING` crudo y **no** un `try/catch` del `UniqueConstraintError`: un error `23505` deja la
   transacción de Postgres **abortada** y, como Sequelize no envuelve `Model.create` en un savepoint,
   cualquier consulta posterior falla con *"current transaction is aborted"* — o sea que el `catch`
   natural (releer la fila que bloquea para armar un mensaje decente) daría un **500 en vez del 409**.
   Con `ON CONFLICT` no se levanta excepción y el conteo de filas es la señal.

Ese 409 lleva **dos mensajes** según el estado del pedido que bloquea — si es `pending`, "ya tienes un
pedido sin pagar que usa este cupón", porque cuando Stripe falla *después* del commit la Fase O.2
conserva la clave y el cupón queda apartado hasta que `pendingOrderSweeper` lo alcance (30 min).

**`coupon_redemptions.enforced`** existe porque el índice parcial **no puede consultar el flag del
cupón**: si el dueño apaga `oncePerCustomer` en un cupón vivo, las filas ya escritas seguirían
bloqueando esos correos para siempre. Se escribe fila para **todo** canje (es la bitácora —quién,
cuándo, cuánto, desde qué IP— y `releaseCouponForOrder` se apoya en su existencia), y solo las escritas
con el flag encendido participan en la restricción.

**La liberación del uso** (`releaseCouponForOrder`) es lo que el roadmap no pedía y sin lo cual la
promoción muere sola: el uso es una reserva igual que el stock, así que se devuelve **en el mismo punto
y dentro de la misma transacción** — en `releaseOrderStock` (que cubre a sus dos llamadores: el webhook
`payment_intent.canceled` y `pendingOrderSweeper`) y en la rama `paid` de `cancelOrderByAdmin`, después
del guard `status !== "paid"` para que dos cancelaciones concurrentes no decrementen dos veces. Sin
esto, un cupón de 50 usos se agota con carritos abandonados. Es auto-idempotente por el `UPDATE`
condicional (`releasedAt IS NULL`) y el decremento lleva `redeemedCount > 0`. **Un reembolso fallido no
libera** (el dinero no volvió), misma regla que el restock.

**`assertChargeableTotal`** valida el mínimo cobrable **antes** de persistir: si Stripe rechazara el
total, eso pasaría *después* del commit y —por `releaseKeyOnFailure` de la Fase O.2— con la clave
conservada, dejando un pedido `pending` que aparta stock y quema el cupón 30 min sin poder reintentar.
`MIN_CHARGE_MXN` vive en `coupon.service.ts` y **no en `src/config/stripe.ts`**: dos suites
(`cancelOrder.test.ts`, `pendingOrderSweeper.test.ts`) reemplazan ese módulo con un objeto literal de
exports fijos, así que un import nuevo resolvería a `undefined`, `total < undefined` sería `false`, y el
guard quedaría **muerto en todas las suites que mockean Stripe** mientras los tests pasan en verde.

**`checkoutFingerprint` incluye `couponCode`**: sin él el mismo carrito con y sin cupón daría la misma
huella, y al comprador que acaba de aplicar un descuento se le devolvería el pedido anterior **sin
descontarlo**. El código ya viene normalizado por `couponCodeSchema` (recortado y en mayúsculas). La IP
**no** entra: no es parte de la identidad del pedido, y un reintento desde otra red se leería como
pedido nuevo.

**`POST /api/coupons/validate`** `[público, couponRateLimiter 20/min]` valida **sin canjear** —ni mueve
`redeemedCount` ni escribe fila, así que abrir el checkout diez veces no gasta la promoción— y reusa
`assertProductAvailable` para que un producto oculto dé el mismo 409 que dará el checkout. El `email` es
**opcional** porque el campo del cupón vive en el paso 0 del checkout, antes de capturar los datos de
envío: sin correo no se verifica el uso por persona y la respuesta lo declara con
`perCustomerChecked: false`; `remainingRedemptions` es informativo y **no vinculante** (el tope global y
el uso por persona se re-deciden atómicamente al pagar, así que el front tiene que pintar el 409). Sus
mensajes **sí distinguen la causa** (no existe / venció / se agotó / no alcanza el mínimo), la inversión
deliberada de la regla anti-enumeración del resto del repo: un cupón existe para que un humano lo
teclee y un mensaje opaco lo volvería inusable. Consecuencia a decir en voz alta: **los códigos no son
secretos**, así que un cupón dirigido a una sola persona tiene que ser largo y aleatorio, nunca `VIP`.

**Reglas del CRUD admin.** `code` **no es editable** (ya pudo repartirse, y el `couponCode` congelado en
los pedidos dejaría de empatar; si está mal, desactivar y crear otro). `redeemedCount` **no entra en
ningún schema** (estado derivado que solo mueven el canje y la liberación). **Bajar `maxRedemptions` por
debajo de `redeemedCount` se permite y no se valida**: es justo el edit que hace un dueño para frenar
una promoción en caliente. `updateCoupon` re-valida las reglas cruzadas contra **el estado combinado**
(lo guardado + lo que cambia), porque los refines del schema solo ven el body y un `PUT` que manda solo
`maxDiscount` sobre un cupón `fixed` los pasaría. `DELETE` sigue el criterio de `adminDeleteProduct`:
**desactiva** si algún pedido lo usó, borra de verdad si no — y se cuentan **pedidos y no canjes**,
porque un canje liberado sigue siendo historia y una fila de canje puede desaparecer por cascada
mientras el pedido no. El listado devuelve `activeRedemptions` (conteo vivo) junto a `redeemedCount`
para que una divergencia (p. ej. un pedido borrado a mano, que se lleva su fila de canje por cascada) se
**vea** en vez de esconderse; ese es el riesgo residual asumido del `onDelete: "CASCADE"`.

**Fechas y zona horaria** (`couponDateSchema`): un `"2026-08-01"` interpretado como ISO es medianoche
**UTC**, o sea el 31 de julio a las 18:00 en México — el dueño perdería la última tarde de su promoción.
Una fecha sin hora se interpreta en `America/Mexico_City` (inicio de día para `startsAt`,
`23:59:59.999` para `expiresAt`); un instante ISO completo se respeta tal cual. Offset fijo `-06:00`
porque México no tiene DST desde 2022 y la tienda está en Celaya, GTO.

**Dónde aparece el cupón fuera del checkout:** la fila `Cupón <CÓDIGO> − $X` de
`orderConfirmationTemplate` va **después de "Ahorraste" y antes de "Envío"** (ese orden es la prueba
visual de que no tocó la paquetería) y la reciben los dos correos. `PublicOrderView` expone
`couponCode`/`couponDiscount` (sin ellos el total de la página de seguimiento no cuadraría) pero no
`couponId`. En `dashboard.service.ts`, `SaleRow` suma los dos campos —obligatorio, o la fila del panel
es irreconciliable— y hay un KPI nuevo **`DESCUENTOS POR CUPÓN`**: `agg.revenue += order.total` **se
queda** (ahora suma el efectivo realmente cobrado), pero sin ese KPI una campaña se leería como una
*caída* de ingresos aunque el volumen creciera. **`savings` no se toca** — sumar el cupón ahí falsearía
el margen. `reports.service.ts` **no cambia**: calcula `revenue = unitsSold × salePrice` actual, así que
los dos reportes son estructuralmente ciegos al cupón; su `totalRevenue` ya era ≥ caja real y el cupón
ensancha esa brecha, y **no** se "arregla" pasándolo a `order.total` porque rompería el desglose por
producto/categoría.

### Gastos y suscripciones (Fase N.3)

`src/models/Expense.ts`, `ExpenseAmount.ts`, `src/services/expenses.service.ts`,
`src/schemas/expense.ts`; CRUD + `/summary` + `/history` en `/api/admin/expenses` `[auth]`.

Sustituye la constante `GASTOS_FIJOS = 2000` que `dashboard.service.ts` restaba para calcular **GANANCIA
NETA** — el KPI que el dueño usa para decidir si el negocio gana dinero era un número inventado.

**El monto NO es una columna de `expenses`: vive versionado en `expense_amounts`** (`amount`,
`effectiveFrom DATEONLY`, `note`), y esa separación es toda la fase. El monto vigente es *la versión con
el `effectiveFrom` más grande que ya empezó* y el de julio es *la vigente en julio*, así que subir Render
de $290 a $340 **no reescribe** lo que costaba en meses cerrados. Guardar además un `expenses.amount`
"actual" habría dejado dos fuentes de verdad que se desincronizan con el primer edit mal hecho (mismo
riesgo que `redeemedCount` vs `activeRedemptions`); las tablas son de decenas de filas, así que
`currentAmount` se **calcula** en memoria. El **índice único parcial** `(expenseId, effectiveFrom)`
—declarado en `Model.init` además de en la migración, por `sync({ force: true })`— no es contabilidad:
convierte "re-editar el monto que capturé hoy" en una **corrección en su lugar** en vez de una versión
duplicada que dejaría el historial ambiguo. Esa misma lista alimenta el arreglo **`changes`** de cada mes
en `/history`, la respuesta consultable a "¿algo cambió?" — sin él un aumento solo se nota como un total
más alto sin causa visible.

**Todo en MXN**, sin `currency` ni tipo de cambio: Render y Vercel cobran en USD, pero lo que se captura
es lo que cobró la tarjeta, así que un movimiento del dólar **es** un cambio de monto y queda fechado en
el historial. Un `fxRate` por gasto se descartó porque se desactualiza en silencio.

**Dos números distintos, los dos necesarios, y confundirlos es el error caro:**
1. El **gasto real de un mes** (`buildHistory`) se calcula **generando las fechas de cargo** desde
   `startsAt` acotadas por `endsAt`/`active`, atribuyendo cada ocurrencia a su mes con el monto vigente
   **en esa fecha** — así una anualidad cae completa en su mes de renovación y no untada en el año.
2. La **carga mensual normalizada** (`monthlyRunRate`) convierte cada recurrente a su equivalente por mes
   vía `MONTHLY_FACTOR` (`yearly ÷ 12`, `quarterly ÷ 3`, **`weekly × 52/12` y no `× 4`** — usar 4
   subestima el año en casi un mes completo), responde "cuánto retirar cada mes" y es lo que el dashboard
   prorratea por `windowDays/30`. Los `once` valen 0 en el run-rate: cuentan completos en su mes y nunca
   más.

**Trampas ya resueltas.** Las fechas son **`DATEONLY`** porque un cargo es un día de calendario, no un
instante — esquiva de raíz el problema de zona horaria que `couponDateSchema` tuvo que resolver; **ojo,
Sequelize las devuelve como string `"YYYY-MM-DD"`, no como `Date`** (de ahí `utcDayFromIso` en
`src/utils/date.ts`, y que las comparaciones sean de strings, que para ese formato ya son cronológicas).
Las ocurrencias se generan **por índice** desde `startsAt` (`addMonthsClamped(anchor, n × paso)`) y
**nunca iterando sobre la fecha ya calculada**: iterar con `setUTCMonth(+1)` desde el 31 de enero
desborda al 3 de marzo, y si se itera sobre el resultado clampeado (28 feb → 28 mar) el día 31 se pierde
para siempre; por índice sale 31 ene → 28 feb → **31 mar**. `monthlyRunRate` consulta `active`
**directamente** y no vía `effectiveEnd`: apagar un gasto le fija `endsAt` en hoy y, como `endsAt` es
inclusivo (un cargo fechado ese día sí cuenta, y así debe ser para las ocurrencias), sin ese guard la
suscripción recién cancelada seguiría sumando a "cuánto retirar" el día entero de su cancelación. Y
**apagar escribe `endsAt`** en vez de dejar que "hasta cuándo cobró" se infiera de `updatedAt`, que
cualquier otra escritura bumpea — la lección de `shipmentClaimedAt` (Fase O.3); reactivar limpia un
`endsAt` viejo salvo que el body mande uno.

**`monthRange` se movió de `reports.service.ts` a `src/utils/date.ts`** y ahora la comparten el reporte
mensual de ventas y el historial de gastos: los dos necesitan el mismo rango sin huecos y el mismo clamp
de `from > to`.

**Reglas del CRUD.** `PUT` con `amount` **agrega una versión** (con `amountEffectiveFrom` o hoy), salvo
que ya exista una con esa misma vigencia (se corrige en su lugar) o que el monto no haya cambiado (editar
el concepto no debe ensuciar el historial de precios). La primera versión de un alta rige desde
**`startsAt`, no desde hoy**: registrar en agosto una suscripción que empezó en marzo tiene que dejar
cubiertos los cargos de marzo a julio. `DELETE` sigue el criterio de `deleteCoupon`/`adminDeleteProduct`:
**desactiva** (con `endsAt` en hoy) si el gasto ya generó algún cargo —ese dinero se gastó y borrarlo
dejaría el historial mintiendo sobre meses cerrados— y solo borra de verdad lo que nunca cobró nada. El
filtro `from`/`to` del listado es por **fecha de cargo y no por alta**. Los parámetros inválidos aquí son
**`400`, no se ignoran** (la inversión deliberada de la regla del catálogo público: quien consulta es el
dueño, y un filtro que no aplicó le haría leer mal sus propios números). Las categorías son un **ENUM
fijo** (`infraestructura`, `software`, `renta`, `servicios`, `paqueteria`, `publicidad`, `nomina`,
`impuestos`, `otro`) y no texto libre, porque con texto libre `"Infra"`/`"infraestructura"`/`"INFRA"`
serían tres grupos distintos en la misma gráfica; agregar una es un `ALTER TYPE ... ADD VALUE`, y los
catálogos se repiten literales en la migración (no se importan de `models/Expense.ts`, que arrastraría
`config/database.ts` a un proceso que no debe abrir una segunda conexión) — **al agregar un valor, tocar
los dos lados**.

**En el dashboard**, `buildKpisForWindow` recibe el run-rate y un `Map<isoDay, amount>` de gastos de única
vez (`oneTimeExpensesByDay`) y los suma en **el mismo recorrido día-por-día que ya hacía** sobre la
ventana actual y la previa. El KPI pasó de `GASTOS FIJOS` a **`GASTOS`** (con gastos de única vez adentro,
"fijos" sería falso) y su `subtitle` separa las dos mitades, porque un pico tiene dos causas muy distintas
—subió una suscripción vs. hubo una compra puntual— y el dueño debe distinguirlas sin abrir el historial.
La ventana previa ahora suma **sus propios** gastos de única vez: antes restaba exactamente los mismos que
la actual porque la constante no tenía cómo variar, y eso volvía el `trend` de GANANCIA NETA una
comparación a medias. **La forma de `DashboardData` no cambia**, así que el panel no se rompe con el
deploy. `src/seed.ts` crea una fila recurrente de `$2,000/mes` equivalente a la constante vieja para que la
GANANCIA NETA no dé un salto ese día; es una fila normal y editable.

**La línea derivada de envío** (`DerivedShippingCost`, Fase N.5) es el segundo costo más grande del
negocio y **no es un gasto capturado**: sale de `Order.shipping` y aparece en `/summary` (mes en curso a
la fecha) y en cada mes de `/history` como un campo `shippingCost` aparte. Tres decisiones que hay que
leer juntas:

1. **Nunca se persiste como `Expense`.** Una fila por pedido serían ~900 al mes a 30 ventas diarias:
   inundaría el `activeCount` y el `byCategory` de `/summary`, el `byExpense` de `/history` y la lista
   editable del panel, para representar algo que ya está en `orders`. Las dos tablas de gastos son de
   decenas de filas justamente porque las captura un humano.
2. **Va FUERA de `total`/`byCategory`/`byExpense`/`monthlyRunRate`.** El dashboard ya la resta en
   GANANCIA BRUTA (el envío es costo de venta, ver **Dashboard**), y como `OPERATIVA = BRUTA − GASTOS`,
   sumarla también a los totales de gastos la restaría **dos veces**. Se expone aparte para que el dueño
   la *vea* sin que los dos paneles se contradigan; las banderas `derived: true` e
   `includedInGrossProfit: true` son el contrato legible por máquina de eso.
3. **⚠️ Cajas y empaque sí se capturan como `Expense` de categoría `paqueteria`; las guías NO.** Es el
   único modo de reintroducir el doble conteo, y por eso está advertido en tres lugares: el comentario
   del enum en `models/Expense.ts`, la bandera en la API, y el copy obligatorio del frontend.

`buildSummary`/`buildHistory` **siguen siendo puras**: reciben el envío como **parámetro final con
default `new Map()`** en vez de consultarlo adentro (sus tests unitarios corren sin BD y el default deja
intacto a todo llamador anterior). La consulta vive en los wrappers, `loadShippingByMonth(from,
toExclusive)`, con `paymentStatus: "paid"` —el mismo predicado del dashboard— y bucketing por
`isoMonth` UTC para que los dos paneles nunca partan el mes distinto. **Sin `raw: true`**: el
`parseFloat` de `shipping` vive en el getter del modelo, que `raw` no ejecuta, así que devolvería el
string `"150.00"` y la suma **concatenaría**. `getExpenseSummary` toma **un solo `now`** para los límites
del mes y para `buildSummary`, o una llamada a las 23:59:59.9 podría cruzar la medianoche entre ambos.
Los campos `from`/`to`/`partial` de la línea existen para que un acumulado a media quincena no se lea
contra un `monthlyRunRate` de mes completo y parezca que el envío sale baratísimo.

### Aviso de venta al dueño (Fase N.4)

`src/services/ownerNotification.service.ts`, `dailySalesDigest.ts`,
`src/services/email/templates/newOrderNotification.ts` + `dailySalesDigest.ts`, `src/utils/storeDay.ts`.

Hasta esta fase `alert.service.ts` solo mandaba correo cuando algo **fallaba**, y no había nada para el
evento más importante del negocio — una venta. Son **dos correos que responden preguntas distintas**: el
**aviso por venta** es un *disparador de acción* ("empaca esto") y el **resumen diario** es
*reconciliación* ("cómo cerró el día"). Con solo el resumen, un pedido de las 3pm no se conocería hasta el
corte del día siguiente — hasta un día de retraso en despachar. Van a `OWNER_NOTIFICATION_EMAIL` con
**fallback a `ALERT_EMAIL_TO`** (resuelto en cada llamada, no al cargar el módulo, igual que
`sendAlertEmail`); **sin ninguna de las dos la fase queda apagada**, y ese es su interruptor. Sin dominio
verificado en Resend esta fase **sí funciona**, a diferencia de los correos al cliente: el destinatario *es*
el dueño de la cuenta.

**El aviso por venta** se dispara fire-and-forget desde `markOrderPaidFromWebhook` **dentro del guard
`affected === 1`**: ese `UPDATE` condicional ya serializa a nivel de BD el webhook de Stripe y
`pendingOrderSweeper`, así que sale exactamente una vez sin dedup propia (`idempotencyKey:
new-order/${id}` es el segundo cinturón). **No espera a `createShipmentForOrder`**: los dos datos
operativos que lleva (`skydropxRateId` y `shippingRequiresDropoff`) se persisten en el checkout, así que
encadenarlo solo retrasaría el aviso — o lo perdería si Skydropx falla. **Recarga el pedido en una
instancia nueva (`Order.findByPk`), nunca con `order.reload()`**: el correo de confirmación se dispara en
paralelo sobre esa misma instancia y también la recarga con otros `attributes`, y dos `reload()`
concurrentes se pisan a media renderización. El **asunto es autocontenido a propósito** (`Venta #142 —
$1,850.00 — 3 piezas`, con sufijo ` — GUÍA MANUAL` cuando `!skydropxRateId`): para que a 20–30 ventas
diarias siga sin ser ruido tiene que poder leerse **sin abrirlo**. El cuerpo lleva tallas, cantidades,
dirección con referencias y **el contacto completo del cliente** (a diferencia de `PublicOrderView`: son
los datos con los que el dueño resuelve un problema de entrega), más los dos **bloques de acción** que son
su razón de ser: `!skydropxRateId` ("se cobró con tarifa plana, genera la guía a mano") y
`shippingRequiresDropoff` ("hay que llevarlo a la sucursal"). **Nunca `unitCost` ni margen**, aunque el
correo sea del dueño: un correo no está autenticado, se reenvía y vive en una bandeja.

**El resumen diario** (`startDailySalesDigest`/`stopDailySalesDigest` en `app.ts` junto a los otros crons,
saltado bajo `NODE_ENV=test`, timer `unref()`ado) sale a las **`DAILY_DIGEST_HOUR` (8) hora de Celaya y
cubre el día anterior COMPLETO**: un corte a las 21:00 sería más inmediato pero truncado, y las ventas de
la noche no caerían en ningún resumen. Cada `DAILY_DIGEST_CHECK_INTERVAL_MINUTES` (15) `runDigestTick`
mira la hora local y, pasada la hora, manda el resumen de ayer si no lo ha mandado. **La ventana es un día
LOCAL, no UTC**, y de ahí `src/utils/storeDay.ts` — aparte de `src/utils/date.ts`, cuyo encabezado
garantiza que todo lo suyo está fijado a UTC para estabilidad de agregación: un "ayer" en UTC cubriría de
las 18:00 de antier a las 18:00 de ayer y **se comería la tarde-noche**, horario pico de compra. Offset
fijo `-06:00`; `MEXICO_CITY_OFFSET` se comparte con `src/schemas/coupon.ts`. Ojo con `storeHour`: usa
**`hourCycle: "h23"` y no `hour12: false`**, porque con este último varias versiones de ICU formatean la
medianoche como `"24"` y el resumen saldría a medianoche.

**Dos capas de idempotencia, y la segunda no es memoria**: `lastSentDay` vive en el módulo (misma decisión
y limitación asumida que los mapas de los otros crons) y **no sobrevive a un redeploy**, así que la segunda
es el **`idempotencyKey: daily-sales/<día>` de Resend**, cuya ventana de 24 h coincide con la cadencia
diaria y cubre el redeploy *y* varias instancias sin columna nueva. Se marca `lastSentDay` **antes** de
mandar (la función nunca lanza; reintentar en cada tick solo repetiría las consultas). **Se manda también
los días sin ventas** — un correo que no llega es ambiguo (¿día flojo o cron muerto?) y sirve de latido.
Tras una caída de varios días manda **solo el más reciente**, no un backfill. La ventana se mide sobre
**`createdAt`** porque **no existe columna `paidAt`** y agregarla exigiría un backfill imposible de
reconstruir, además de que el dashboard también agrupa por `createdAt`; consecuencia asumida: un pedido
creado 11:55pm y pagado 00:05 cuenta en el día anterior. El resumen filtra **`paymentStatus: "paid"`** (ver
**Dashboard**: filtrar por `status` le quitaría justo los pedidos despachados ese mismo día, lo peor que le
puede pasar a un correo de reconciliación). Trae totales del día, tabla por pedido con su hora local,
comparación contra el día anterior **en pesos y no en porcentaje** (con un día previo en cero el porcentaje
sería una división entre cero) y una sección **"requieren acción"** con los pedidos sin guía
(`skydropxShipmentId` en `null` o el centinela) o con dropoff. `runDigestTick(now?)` acepta el instante para
situarse a una hora concreta en los tests sin timers falsos, y `resetDailySalesDigestState()` se exporta
**solo para tests**.

`escapeHtml` se extrajo de `orderConfirmation.ts` a **`src/services/email/templates/escapeHtml.ts`**: con
tres plantillas, tres copias de una función de escape es lo que se desincroniza. **Sin migración, sin
columnas y sin rutas nuevas** ⇒ sin `@openapi` y **sin fase en el roadmap del frontend**. WhatsApp/Twilio
**descartado** en esta fase (proveedor, cuenta de negocio verificada y costo por mensaje para un problema
que el correo resuelve a este volumen).

### Seed

`src/seed.ts` (`pnpm seed`) populates every model from the frontend's mock data. Because it inserts rows
with explicit `id`s, Postgres SERIAL sequences are left behind; the seed resyncs each one
(`setval(pg_get_serial_sequence(table,'id'), MAX(id))`) at the end of the transaction so later
`id DEFAULT` inserts (e.g. `POST /api/admin/products`) don't collide with seeded ids.

### API docs (`src/config/swagger.ts`)

`swagger-jsdoc` builds an OpenAPI 3.0 spec from a base `definition` (info, `servers`, `bearerAuth` security
scheme, reusable `components.schemas` like `Product`, `LoginInput`, `Error`) plus JSDoc `@openapi`
annotations read from the `apis` globs (`./src/routes/**/*.ts` + `./src/app.ts` in dev, and the `./dist/...`
equivalents — both run with cwd at the backend root). `src/app.ts` serves the UI with `swagger-ui-express`
at `/api/docs` (no `NODE_ENV` gate — exposed everywhere) and the raw JSON at `/api/docs.json`. **When adding
a new resource, document each endpoint with an `@openapi` JSDoc block above its `router.<method>(...)`,
referencing shared schemas via `$ref: '#/components/schemas/...'` (add new schemas to `swagger.ts`).**

### Auth (`src/routes/auth/`, `src/controllers/auth.controller.ts`)

Mounted at `/api/auth`. `POST /api/auth/login` validates with `loginSchema` (zod), looks up `AdminUser` by
email, compares the bcrypt hash, and returns `{ token, user }`; an unknown email and a wrong password
return the **same** `401` message (anti-enumeration). `GET /api/auth/me` is protected by `requireAuth` and
returns the decoded `{ user }`. `/login`, `/forgot-password`, `/verify-reset-code` and `/reset-password`
are gated behind `authRateLimiter` (10 req / 15 min). `requireAuth` (`src/middlewares/requireAuth.ts`)
extracts the Bearer token, verifies it with `JWT_SECRET`, and attaches `req.user: AuthUser`.
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

`src/routes/public/order.routes.ts`, `src/controllers/order.controller.ts`,
`src/services/orders.service.ts`. `POST /api/orders` is **public**.

Body `{ items: [{ productId, size, quantity }], customer, shippingCarrier?, quotationId?, rateId?,
couponCode? }`, validated with `createOrderSchema` (zod, `src/schemas/checkout.ts`), capping `quantity` at
99/item and `items` at 50/order (the real per-size limit is enforced by the atomic decrement → `409`).

- `couponCode` is a single code — never an amount — resolved and **redeemed atomically inside the same
  transaction** that decrements stock; an invalid/expired/exhausted/already-used coupon rolls the whole
  transaction back (no order, no stock decrement) and is **never silently ignored**, the deliberate
  opposite of the catalog's "ignore any invalid param" rule.
- `quotationId`/`rateId` (Fase 8.4) are optional but **both-or-neither** (a `.refine()` rejects one
  without the other): present when the checkout quoted live via `POST /api/shipping/rates`, omitted when
  it fell back to the flat rate (Skydropx down at quote time).

`createOrder` does everything inside a single `sequelize.transaction`: it **aggregates** duplicate
`(productId, size)` lines, processes them in deterministic `(productId, size)` order (deadlock
avoidance), and per line runs an **atomic** `ProductSize.update({ stock: literal('stock - N') }, { where:
{ …, stock: { [Op.gte]: N } } })` — if `affectedCount === 0` it throws `AppError(409)`, so concurrent
buyers of the last unit get exactly one `201` and one `409`. Totals are **recomputed server-side** with
the `cart` service (the client never sends amounts) and prices are **frozen** into each `OrderItem`
(`unitOriginalPrice`/`unitSalePrice`/`unitCost`/`nameSnapshot`).

**Shipping is authoritative too**: with `quotationId`/`rateId`, `createOrder` **re-consults the Skydropx
quotation** (`getQuotationRate`, a single `GET`) and uses that rate's `total` as `shipping` (recomputing
`total = subtotal − savings − couponDiscount + shipping`) — never a client-sent amount, same rule as the
price recompute. It persists `skydropxQuotationId`/`skydropxRateId`, fills `shippingCarrier` from the
rate's carrier, and stores `shippingRequiresDropoff` — an operational flag for the owner (no home pickup,
must drop at the carrier's branch), **excluded from the public response** the same way `unitCost` is, and
`null` on the flat-rate fallback. The re-consult runs **before** the transaction opens (deliberately
deviating from the roadmap's "inside the transaction" wording): it's a network `GET` that touches no DB
row, so keeping it out avoids holding `ProductSize` locks across an up-to-5s call. A rate no longer
available → `409`; a network failure re-consulting → `503`. Without `quotationId`/`rateId` it uses
`computeShipping` (flat rate).

`unitCost` is frozen in the row but **excluded from the public response** (reloaded with
`attributes: { exclude: ['unitCost'] }` on `items`). Orders are created `status: "pending"` /
`paymentStatus: "unpaid"`; the response is `{ order, clientSecret }`.

The route is gated by `orderRateLimiter` (Fase H.3, `src/middlewares/rateLimit.ts`, 10 req/min per IP):
every successful request creates a real Stripe PaymentIntent and an `Order` row, so a sustained flood
would burn Stripe's account-level rate limit and bloat the orders table even though `pendingOrderSweeper`
eventually releases the unpaid ones. Only mounted on the public `POST /`, not on `adminOrder.routes.ts`
(already behind `requireAuth`).

#### Public order lookup (Fase O.4)

`GET /api/orders/lookup/:token` `[público]` → `lookupOrder` → `orders.service.getOrderByPublicToken`. Lets
the buyer check status and tracking without an account. There are no customer accounts and no other public
read of orders, so until this phase the only thing a buyer had after paying was the confirmation email —
deleted or spam-filtered, every "¿ya salió mi pedido?" became manual WhatsApp work.

The credential is **`Order.publicToken`**, an opaque UUID (unique index, `randomUUID()` generated inside
`createOrder`) that travels in the confirmation email **twice** — as the link behind the button
(`/pedido/<token>`, built by `publicOrderUrl` in `payment.service.ts` from `FRONTEND_URL`) and as the
**visible, copy-ready code** next to it (see *Emails / Resend*), because the `/pedido` page asks for the
code and a token buried in an `href` is unreachable for most people; `publicOrderUrl` and
`publicOrderLookupUrl` are the only URLs this backend builds toward the front — **and** in the checkout's
`201` (the order is the buyer's, so the front can send them to the
tracking page without waiting for the email). Deliberately **not** `id + email`: ids are sequential and an
email is guessable, so that pair would be enumerable even behind a rate limit.

The response is an **explicit projection** (`PublicOrderView`), not the row with exclusions — built field
by field with the `SELECT` narrowed to match, so a new `Order` column doesn't leak by someone forgetting an
exclusion list; it takes a deliberate edit to appear. **Out:** `unitCost`, `paymentIntentId`, `refundId`,
`labelUrl` (the printable label is the owner's — it carries the shipper's details), the Skydropx ids,
`shippingRequiresDropoff`, `couponId`, the token itself, and `customerEmail`/`customerPhone` (a tracking
page doesn't need them and the link gets forwarded over WhatsApp easily). **In:** status, `paymentStatus`,
tracking, frozen item prices, totals, `couponCode`/`couponDiscount`, the shipping address, and
`refundedAt` — a cancelled order has to say *when* the money went back.

A **malformed token is rejected before touching the DB**: the column is `uuid`, so
`WHERE "publicToken" = 'abc'` makes Postgres throw a syntax error that `errorHandler` would degrade to a
**500** (the same problem `parseId` solves for numeric `:id`s). With the format check, missing / tampered /
malformed all return the **same 404 with the same message**. Gated by `orderLookupRateLimiter` (30 req/min
per IP) — deliberately loose, since brute-forcing a UUID is infeasible either way and the person reloading
that page is a buyer waiting on their order. The column ships with
`20260728130000-orders-public-token.ts`, which backfills existing rows with `gen_random_uuid()` (core since
Postgres 13) **before** creating the unique index, and is declared in `Order.init()`'s `indexes` because
`tests/setup/db.ts` builds the schema with `sync({ force: true })`.

#### Checkout idempotency (Fase O.2)

The controller calls `orders.service.placeOrder(input, idempotencyKey?)`, which wraps the whole checkout
(`createOrder` → `createPaymentIntentForOrder` → persist `paymentIntentId`) behind a **60 s dedup window**.
Without it a double click created a second `Order`, a second real PaymentIntent and **decremented stock
again**, and that phantom inventory stayed locked until `pendingOrderSweeper` reached the order
(`PENDING_ORDER_TTL_MINUTES`, 30) — 30–40 minutes of unsellable stock at peak. `orderRateLimiter` doesn't
cover it: two clicks are far under 10 req/min.

A replay **returns the original response** (same `order`, same `clientSecret`, same `201`) instead of the
`409` the bulk import returns for its own duplicate guard — the deliberate difference is that the checkout
customer is waiting to pay, and a `409` would leave them unable to buy *and* holding reserved stock.

Two key layers: an explicit `Idempotency-Key` header (optional, read by `readIdempotencyKey` — trimmed,
empty = absent, >200 chars = `400`), and, when absent, an automatic fingerprint of cart + customer
(`checkoutFingerprint`: lines aggregated by `(productId, size)` and sorted like `createOrder` does, so the
same cart in a different order is recognized; customer fields as a **positional array**, not the object, so
it doesn't depend on zod's key order; `quotationId`/`rateId`/`couponCode` included). Reusing an explicit key
with a **different** cart is a client bug, not a replay → `409`, so a buyer is never handed an order that
isn't theirs.

What's cached is the **in-flight promise**, not the result: the real double-click arrives before the first
request finishes, and both must await the same checkout — the `get`/`set` pair has no `await` between them,
so two concurrent requests can't both claim the key. A failed attempt **releases** the key **only while
nothing was persisted** (most failures — `409` stock, `503` quote, `400` validation — happen before any
write, and the buyer must be able to fix and retry immediately); `executeCheckout` flips a `persisted` flag
right after `createOrder` commits, and past that point the key is **kept** — the `Order` row and its stock
decrement already exist, so releasing it would turn the retry (the likeliest one of all) into exactly the
duplicate order + 30–40 min of locked stock this phase exists to prevent. The release goes through
`IdempotencyStore.deleteIf` (identity-checked), never a bare `delete`: an attempt can outlive the 60 s TTL
(Stripe's SDK default timeout is 80 s), and by then its entry may belong to another request.

A replay is flagged with an **`Idempotency-Replayed: true` response header** — the body is byte-identical
to the original by design, so without it the client can't tell "your order was created" from "you already
had this one"; it's listed in the CORS `exposedHeaders` in `app.ts` or the browser wouldn't let the front
read it.

The store is `IdempotencyStore` from `src/utils/idempotency.ts`, **in memory and deliberately not
persisted** (same decision and accepted limitation as `assertNotDuplicateCommit` and
`pendingOrderSweeper`'s failure counter: it protects against the accident, not the abuse —
`orderRateLimiter` is the hard barrier). `resetCheckoutIdempotency()` is exported **only for tests**.

### Payments / Stripe (Fase 8)

`src/config/stripe.ts` (its own `dotenv.config()`, since imports run before `app.ts`'s) **hard-requires**
`STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` (throws at startup — no inert fallback) and exports the
shared `stripe` client, `STRIPE_CURRENCY` (default `"mxn"`) and the sweeper knobs
`PENDING_ORDER_TTL_MINUTES` (30) / `PENDING_ORDER_SWEEP_INTERVAL_MINUTES` (10). Keys are **test/sandbox**
for now. `Order` carries nullable `paymentIntentId` + `paymentStatus`
(`unpaid|processing|paid|failed|refunded`).

`src/services/payment.service.ts`:
- `createPaymentIntentForOrder(order)` creates a **real** PaymentIntent
  (`amount: Math.round(order.total * 100)`, `currency`, `metadata.orderId`,
  `automatic_payment_methods`) and returns `{ clientSecret, paymentIntentId }`; the checkout persists that
  id (+ `paymentStatus: "processing"`) and returns the `clientSecret`.
- `markOrderPaidFromWebhook` (→ `paid`) and `markOrderPaymentFailed` (→ `paymentStatus: "failed"`, keeps
  `status: "pending"` so a transient decline can be retried on the same PaymentIntent) are **idempotent**
  and **tolerant of a missing order** (log + return, never `throw`, so a verified event always 200s and
  Stripe doesn't retry in a loop).

**The paid transition is one atomic conditional UPDATE** — `Order.update({ status:"paid",
paymentStatus:"paid" }, { where: { id, status:"pending", paymentStatus: { [Op.ne]:"paid" } } })` — and the
confirmation email, the owner's sale notification and the shipment creation only fire on
`affectedCount === 1`. This is the single funnel every order passes through (both the
`payment_intent.succeeded` webhook and `pendingOrderSweeper`'s recovery path call it), and the guard
**serializes at the DB level** against concurrent webhook + sweeper runs. A plain in-memory check
(`if (order.paymentStatus === "paid")`) would **not**: two callers could both read `processing` before
either writes, and both would send.

The `status: "pending"` half of the guard (Fase H.5 fix) exists because this transition is only ever valid
`pending → paid`: without it, a late/duplicate `payment_intent.succeeded` could "resurrect" an order an
admin already cancelled (stock already restocked, possibly resold) back to `paid`, re-sending the email and
creating a Skydropx label for a closed order — the exact failure `cancelOrderByAdmin`'s best-effort
`stripe.paymentIntents.cancel` can trigger when the PaymentIntent had already succeeded (that call fails
silently, logged as a warning, and the order is left `cancelled` while Stripe already captured the charge).
When the guard's `affected === 0` **and** the order is `cancelled`, `markOrderPaidFromWebhook` logs an
error, reports to Sentry and calls `sendAlertEmail` — a payment captured against a cancelled order needs a
human to decide whether a manual refund is owed.

The confirmation send is a thin `sendOrderConfirmationEmail(order)` over a shared `sendOrderEmail(order, {
subject, idempotencyKey, tracking? })` (Fase 8.6 refactor) that `order.reload({ include: items excluding
unitCost })` then templates + `sendEmail`, wrapped in its own `try/catch` that only logs; the same helper
backs `sendShipmentEmail`. Resend's `idempotencyKey: order-confirmation/${order.id}` is a second 24 h
safety net. It is dispatched **fire-and-forget** (`void`, **not** awaited): if Resend were slow, Stripe
could exceed its response timeout and retry the event in a loop.

`POST /api/webhooks/stripe` (`webhook.routes.ts` → `stripeWebhook`) is mounted with
`express.raw({ type: "application/json" })` **before** the global `express.json()` (so `req.body` is the raw
`Buffer` `stripe.webhooks.constructEvent` needs to verify the `Stripe-Signature` header). A
missing/invalid signature returns **400** (Stripe won't count it as delivered); any verified event returns
`{ received: true }` (200) even when unhandled, to avoid retry loops. Handled:
`payment_intent.succeeded` → `markOrderPaidFromWebhook`; `payment_intent.payment_failed` →
`markOrderPaymentFailed`; `payment_intent.canceled` → `releaseOrderStock`.

**`orders.service.releaseOrderStock(orderId)`** is the exact inverse of the checkout's atomic decrement: in
a transaction it locks the `Order` row **alone** (`FOR UPDATE` — *not* with the `items` include, since
Postgres rejects `FOR UPDATE` on the nullable side of the LEFT JOIN), loads its `OrderItem`s separately,
`ProductSize.update({ stock: literal('stock + N') })` per line, calls `releaseCouponForOrder`, and sets
`status:"cancelled"` / `paymentStatus:"failed"`. It's **idempotent** (only acts while
`status === "pending"`) and **never restocks a paid order**.

**`src/services/pendingOrderSweeper.ts`** (started after `connectDB()`, skipped under `NODE_ENV=test`,
timer `unref()`ed) runs every `PENDING_ORDER_SWEEP_INTERVAL_MINUTES`, finds `pending` orders older than
`PENDING_ORDER_TTL_MINUTES` and **reconciles each against Stripe** (`retrieve`): if the PaymentIntent is
`succeeded` it marks the order `paid` (recovers a missed webhook), otherwise it cancels the PaymentIntent
and calls `releaseOrderStock`. An order **without** a `paymentIntentId` skips Stripe and goes straight to
`releaseOrderStock`: the sweep deliberately does **not** filter on `paymentIntentId != null` (it did until
Fase O.2), because a `pending` order can lack one when Stripe failed *after* `createOrder` had already
committed and decremented stock — and those are precisely the orders nothing else will ever touch, since no
webhook can arrive for a PaymentIntent that doesn't exist, so their stock stayed reserved forever.
Restocking them is safe because the client never received a `clientSecret`. `sweepOnce` is exported for
tests.

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

**Empaque y validación (Fase N.6 — ver *Empaque multi-caja* abajo).** `src/services/packing.ts`'s
`packOrder` acomoda el pedido en las cajas reales de la tienda y `buildParcels` devuelve un bulto por
caja; la cotización manda ese arreglo completo como `parcels`. `shipping.controller.ts` valida, antes de
cotizar, que cada producto tenga `weightKg`/`lengthCm`/`widthCm`/`heightCm` > 0 (mismo invariante que
`productSchema` exige desde Fase 8.2) — un producto con alguna dimensión en `0` daría una caja válida
pero subdimensionada, así que en ese caso se **salta la cotización en vivo directo al fallback de tarifa
plana**; lo mismo pasa si el acomodo pasa de `MAX_PARCELS_QUOTED` (10) bultos.
`POST /api/shipping/rates` está gateado por `shippingRateLimiter` (20 req/min por IP) — es público y sin
él un solo cliente podría acaparar el presupuesto de 2 req/s de toda la cuenta.

#### Empaque multi-caja (Fase N.6)

`src/services/packing.ts` (`packOrder`/`buildParcels`/`DEFAULT_CARTONS`), `cart.computeShipping`,
`Order.packageCount`.

Hasta esta fase el envío se calculaba asumiendo **un solo bulto**, por dos caminos y los dos mal.
`buildParcel` armaba **una caja apilada** (peso y alto sumados por unidad, largo/ancho al máximo): el
volumen salía bien, pero producía bultos que la tienda nunca arma —3 botas + 1 sombrero daban 45×45×**80
cm**— y como la paquetería cobra **por bulto**, la factura real llegaba más cara que lo cotizado. Peor:
`computeShipping` era un `Math.max` por tipo que **ignoraba la cantidad**, así que 3 botas + 1 sombrero
cobraba $160, lo mismo que una sola bota, y 50 piezas de ropa cobraban $100. Ese camino no es raro —se usa
cada vez que Skydropx está caído, no devuelve tarifas a tiempo, o un producto trae una dimensión en 0— así
que cada caja extra salía de la utilidad del dueño. Y la guía declaraba `packages: [1]` fijo.

**`DEFAULT_CARTONS` es el catálogo de cajas de la tienda** (chica 40×35×25/8 kg, mediana 55×40×35/15 kg,
grande 60×45×50/25 kg, con su tara) y es **el único lugar que editar** cuando el dueño mida las suyas: la
cotización, la guía y la tarifa plana se mueven todas con él. El acomodo es un *first-fit-decreasing* por
volumen contra la caja grande **más una pasada de downgrade** que reasigna cada caja cerrada al cartón más
chico que la aguante — sin esa segunda pasada, un pedido de una bota se cotizaría con la caja maestra y se
sobrecobraría el envío de **casi todas las ventas**. No es empaquetado 3D exacto (NP-difícil, y aquí no
paga): aproxima por volumen con `FILL_FACTOR` (0.8 — el 20% restante son huecos de aire, relleno y cajas
que no teselan), exige que cada pieza quepa **dimensionalmente** (con las medidas ordenadas, o sea
girándola) y respeta el tope de peso. Puede abrir una caja de más; nunca mete más de lo que cabe.
`FILL_FACTOR` es literalmente la constante que decide entre subcotizar y sobrecotizar.

Los casos borde están todos sesgados a **no subcotizar**: una pieza más grande que cualquier cartón viaja
sola con sus propias medidas (`carton: null`) en vez de tumbar la cotización, y una pieza con alguna
dimensión ≤ 0 (fila anterior a que `productSchema` exigiera `.positive()`) **no comparte caja con nada** —
no se puede afirmar que quepa, así que se cobra un bulto completo.

**`computeShipping` y la cotización en vivo salen del MISMO `packOrder`**, y eso es el punto: caer al
respaldo cambia el precio del bulto, nunca cuántos bultos son. El respaldo suma, por caja, la tarifa del
tipo más caro que esa caja lleva (los montos `SHIPPING_BY_TYPE` no cambiaron). Por eso `CartLineItem` ganó
las cuatro dimensiones — los tres llamadores (`createOrder`, `shipping.controller`, `previewCoupon`) ya
tenían el `Product` cargado, así que no hay consulta nueva.

**`isUsableRate` descarta los rates `multishipment`.** Skydropx ofrece tres formas de convertir una
cotización en envío (`shipment_creation_type`): `single`, `multipackage` (una guía con varios bultos) y
`multishipment` (**una guía por bulto**). Este modelo guarda un solo
`skydropxShipmentId`/`trackingNumber`/`labelUrl` por pedido y el webhook localiza la orden por
`relationships.shipment.data.id`, así que con un `multishipment` solo una de las N guías quedaría visible y
las demás serían dinero cobrado que nadie puede rastrear ni entregar. Un rate **sin** el campo sigue siendo
utilizable (el sandbox no siempre lo manda; leer la ausencia como `multishipment` apagaría la cotización en
vivo entera).

**`Order.packageCount`** (nullable, migración `20260804120000-orders-package-count.ts`) congela cuántos
bultos ampara la tarifa cobrada, y `createShipment` declara ese número de `packages` numerados. Tiene que
ser una columna y no un recálculo: la guía se genera minutos después y en otro proceso, donde las
dimensiones del catálogo pudieron cambiar y `GET /quotations/{id}` **no devuelve los `parcels` cotizados**.
`null` = tarifa plana o pedido previo a la fase, y el generador lo lee como 1 — que es exactamente lo que
esos pedidos declararon. La rama de re-cotización de `createShipmentForOrder` rehace el acomodo con las
dimensiones actuales y **persiste el conteo nuevo** (`order.shipping`/`order.total` siguen sin tocarse: ya
se cobraron). El `packageCount` que viaja en `NormalizedShippingRate` sale de `parcels.length`, no de la
respuesta de Skydropx, y `getQuotationRate` lo recupera del mismo `Map` en memoria donde ya recordaba la
dirección cotizada (mismo TTL de 24 h; si el proceso se reinició esa función ya falla cerrado, así que
siempre que hay rate hay conteo).

`src/services/productAvailability.ts`'s `assertProductAvailable(product)` es la guardia compartida de
"producto disponible" (existe, `visible`, no soft-deleted) entre `createOrder`, `getShippingRates` y
`/api/coupons/validate` — todos deben mostrar el mismo mensaje accionable.

`productSchema`/`productUpdateSchema` exigen las cuatro dimensiones **> 0** (`.positive()`) desde Fase 8.2:
con cotización en vivo, un producto en `0` no solo generaría una guía mala, tumbaría la cotización del
carrito completo. `ProductForm.tsx` valida lo mismo para que un producto legado en `0` se marque como
inválido en el formulario en vez de fallar con un 400 desde un campo no relacionado.

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

`POST /api/admin/orders/:id/shipment/retry` `[auth]` (`adminRetryShipment` →
`payment.service.retryShipmentForOrder(id)`) más el cron gemelo `src/services/shipmentRetrySweeper.ts`.

La guía se genera en **una sola** llamada fire-and-forget al confirmarse el pago; si falla (Skydropx caído,
saldo agotado, o el proceso muere a media creación) el pedido queda pagado y sin guía **para siempre** —
ningún webhook puede llegar por una guía que nunca se creó. Además cerraba mal el caso del **centinela
huérfano**: si el proceso moría entre el `UPDATE` que escribe `"creating"` y el `POST /shipments`, ese valor
quedaba en la fila y cualquier intento futuro se retiraba.

**Los valores especiales de `skydropxShipmentId`** son la pieza central, y separarlos fue lo que hizo seguro
el reintento:
- `"creating"` (`SHIPMENT_CREATION_SENTINEL`) = **solo** "alguien está creando la guía ahora", por eso
  liberarlo por antigüedad es seguro.
- `unreconciled:<id real>` (`unreconciledShipmentId()` lo desempaqueta) = "Skydropx ya la creó y **la
  cobró**, solo no se pudo guardar el id".
- `unreconciled:desconocido` (`UNCERTAIN_SHIPMENT_MARKER`) = "pudo haberla creado y cobrado, ni su id
  sabemos".

Antes los tres eran el mismo `"creating"`, así que un reintento por antigüedad habría pagado una **segunda**
guía en el peor caso. Ni el endpoint ni el barrido tocan una fila `unreconciled:` (el `WHERE` de
`pendingShipmentWhere` solo acepta `null` o el centinela exacto); el webhook de esa guía, si llega con un id
real, la sana sola.

**El caso incierto** (`SkydropxShipmentUncertainError`) es el que más cuesta si se trata mal: cada `fetch`
sale con `AbortSignal.timeout` de 5 s, así que un `POST /shipments` que Skydropx **sí procesó y cobró**
puede terminar en excepción. `createShipment` clasifica su propio fallo antes de propagarlo: un `4xx` (salvo
408/429) es un rechazo explícito —no creó ni cobró nada, seguro reintentar— mientras que un timeout, un
socket cortado o un `5xx` son **inciertos**. Para que la clasificación sea fiable, `createShipment` resuelve
el token OAuth **fuera** del `try` (un fallo de token nunca es incierto: el POST jamás salió). Un fallo
incierto marca la orden `unreconciled:desconocido` en vez de liberar el centinela —liberarlo es exactamente
lo que pagaría la segunda guía— y alerta incondicionalmente con severidad `fatal`. El webhook **no** puede
sanar este caso solo (no hay id que empatar), así que es el único que el dueño puede desbloquear con
`force`.

**Endpoint** (body opcional `{ force? }`, `retryShipmentSchema`): rechaza con `409` todo lo que no sea
"falta la guía y se puede generar" — guía real ya presente (con su id en el mensaje), `unreconciled:` (con
el id a buscar en el panel de Skydropx), `unreconciled:desconocido` (pidiendo verificar antes de forzar),
centinela reciente ("se está generando"), pedido `pending` o `cancelled`, pedido ya `shipped`/`delivered`
(ese es precisamente el camino del dueño que generó la guía a mano y la capturó con el `PATCH /status` de
la Fase O.1: sin este guard el botón cobraría una segunda guía por un pedido que ya salió), y pedido con
**tarifa plana de respaldo** (sin `skydropxRateId` no hay tarifa que convertir en guía). `force: true`
**solo** desbloquea `unreconciled:desconocido`, y significa "ya revisé el panel de Skydropx y no existe
ninguna guía". A diferencia del camino automático **espera el resultado** (`createShipmentForOrder` nunca
lanza, así que `attemptShipment` relee la fila y devuelve un `ShipmentAttempt` tipado — `created` ·
`in-progress` · `unreconciled` · `failed`) y responde `502` si Skydropx vuelve a fallar: el dueño está
mirando la respuesta. Dos reintentos concurrentes los serializa el mismo centinela.

**Liberación del huérfano**: `releaseOrphanSentinel` hace `UPDATE ... SET skydropxShipmentId = null WHERE
skydropxShipmentId = 'creating' AND (shipmentClaimedAt IS NULL OR shipmentClaimedAt < now −
SHIPMENT_RETRY_DELAY_MINUTES)` (15). La antigüedad se mide con **`orders.shipmentClaimedAt`**, columna
propia poblada al reclamar el centinela (migración `20260728120000-orders-shipment-claimed-at.ts`), y no con
`updatedAt`: cualquier otra escritura sobre el pedido lo bumpea, así que un pedido realmente atorado en
`"creating"` reiniciaba su reloj cada vez que el dueño lo tocaba desde el panel. Las filas anteriores a la
columna quedan en `NULL` y cuentan como huérfanas de inmediato, que es lo correcto. Un intento normal se
resuelve o falla en segundos, así que 15 min nunca le quita el turno a una creación real en vuelo, y el
`WHERE` condicional hace que dos liberaciones concurrentes no puedan ganar las dos. Esa misma columna acota
el `pendingCreation` del webhook: solo un centinela **reciente** justifica pedir reintento con un `503`.

**Todas las escrituras de este flujo van condicionadas al centinela**, incluida `persistShipmentId`: sin esa
condición, una creación lenta cuyo centinela ya se liberó podía pisar en su intento 2 o 3 lo que un intento
más nuevo hubiera escrito (otro id real, o un marcador `unreconciled:`), borrando justo el dato que un
humano necesita para reconciliar. Cuando el `UPDATE` no afecta ninguna fila (`claim-lost`) la guía **ya está
cobrada** y no se toca nada: se alerta `fatal` para que alguien revise si el pedido terminó con dos guías.

**Barrido automático** (`shipmentRetrySweeper.ts`, arrancado/detenido en `app.ts`, saltado bajo
`NODE_ENV=test`, timer `unref()`ado): cada `SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES` (10) toma hasta 20
pedidos `paid` **con** `skydropxQuotationId` **y** `skydropxRateId` (los dos, porque
`createShipmentForOrder` exige ambos y se retira sin llamar a Skydropx si falta cualquiera — filtrar solo por
el rate metía en cada ciclo pedidos que gastaban sus tres intentos y disparaban la alerta sin una sola
llamada) creados en las últimas **24h** (`MAX_ORDER_AGE_HOURS`: pasado ese punto el fallo no es transitorio y
hace falta una decisión humana) que sigan sin guía pasados los 15 min, y reintenta **secuencialmente** (el
límite de 2 req/s es de la cuenta entera y lo comparten los checkouts en vivo). Solo el desenlace `failed`
gasta intento: `in-progress` (otra llamada tiene el centinela) no es un fallo, y `unreconciled` ya alertó por
su cuenta. Tras `MAX_ATTEMPTS_PER_ORDER` (3) fallos manda **una** alerta y deja de intentar; esos pedidos se
excluyen **en la consulta** (`id NOT IN`) y no con un `continue`, porque si no seguirían ocupando lugares del
`LIMIT` y —con el orden `createdAt ASC`— veinte pedidos atorados al frente dejarían sin turno a todos los más
nuevos. El contador es un `Map` en memoria con el momento del último intento, deliberadamente **no
persistido**; caduca **por tiempo** (`MAX_ORDER_AGE_HOURS`) y no por "no apareció en este ciclo", que era lo
que hacía que un pedido rotando dentro y fuera de la página del `LIMIT` reiniciara su cuenta y volviera a
alertar. `sweepShipmentsOnce` y `resetShipmentRetryAttempts()` se exportan para los tests.

Por eso `createShipmentForOrder` acepta `{ notifyOnFailure }` (default `true`): el camino automático sigue
alertando al instante, mientras que el reintento manual y el barrido lo apagan porque ya tienen canal propio
— si no, cada ciclo mandaría un correo. Los casos `unreconciled:` alertan **siempre**, ignorando la bandera.

**Riesgo residual asumido:** si la BD está caída lo suficiente para que también falle el marcado
`unreconciled:`, la fila queda en `"creating"` y a los 15 min el barrido podría pagar una segunda guía. Por
eso la alerta de ese caso es incondicional y `fatal`.

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
the owner can see it in the expenses panel without the two numbers contradicting each other (see **Gastos
y suscripciones**, `DerivedShippingCost`). ⚠️ The corollary the owner must respect: boxes and packing
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

`src/routes/admin/adminReports.routes.ts`, `src/controllers/reports.controller.ts`,
`src/services/reports.service.ts`; mounted at `/api/admin/reports` (`router.use(requireAuth)`).

Both endpoints are computed **in memory** from a single shared fetch (`loadReportData`) of
`paymentStatus: "paid"` orders (with `items`, `attributes` trimmed to `id`/`createdAt` on `Order` and
`productId`/`quantity` on `items` — the only fields the aggregation reads) + **all** products (with
`productSizes` via the shared `productSizesInclude` from `src/utils/productSizesInclude.ts` — also reused
by `dashboard.service.ts` and `product.controller.ts` — so the `Product.stock` virtual resolves). Since
neither report can be time-windowed the way the dashboard's 180-day queries are (they cover full history by
design), `loadReportData` caches its in-flight/settled promise for `REPORT_CACHE_TTL_MS` (60s); a failed
fetch clears the cache immediately instead of repeating the error until the TTL expires. This keeps a
single admin page load hitting both `/monthly` and `/replenishment` from scanning the full order history
twice. It deliberately includes soft-deleted (discontinued) products, since a product with sales history is
soft-deleted precisely because an `OrderItem` references it — excluding them would erase past sales.

**`GET /api/admin/reports/monthly`** returns `MonthlyReport[]`: units sold grouped by
`(UTC month, productId)` from `OrderItem.quantity`, then for **every** month in `[earliest paid-order month
… current UTC month]` (inclusive, no gaps — empty months emitted as `$0`) it builds `byProduct`.
`monthRange` clamps its start to `to` if `from` is somehow after `to` (clock drift, corrupt/future
`createdAt`), so it returns at least the current month instead of `[]`. Each month's `byProduct` includes
**every live product** (`unitsSold` 0 if unsold) **plus any discontinued product that actually sold that
month** (discontinued ones don't appear as $0 rows in months without activity, so they never clutter recent
months); `revenue = unitsSold × Product.salePrice`, **current** price not the frozen `OrderItem` price;
sorted desc by `unitsSold`. `byCategory` (grouped by `type`, `label` from a plural map replicating
`frontend/lib/categories.ts`, sorted desc by revenue) is derived from that `byProduct`, so discontinued
sales flow into their category too. The month equal to the current UTC month is flagged `partial: true`
(`isoMonth`/`formatMonthLabel`/`utcMonthStart` live in the shared `src/utils/date.ts` alongside the
day-granularity `isoDay`/`formatShortDate`/`utcDayStart` — both **UTC-pinned** for the same reason;
`formatMonthLabel` turns `"enero de 2026"` into the front's `"Enero 2026"`).

**`GET /api/admin/reports/replenishment`** returns `ReplenishmentRow[]` computed on-the-fly (never
persisted): per **live** product (discontinued filtered out — you don't restock a soft-deleted product) it
feeds a monthly `unitsSold` series into `computeForecast` (`src/services/forecast.ts`, the Fase 0 port).
The series uses **complete months only** (`monthlyReports.filter(r => !r.partial)`) — except when there are
**zero** complete months yet (the store's first calendar month), where that rule would leave every series
permanently empty and hide a real day-one stockout for up to a month; in that one case the current partial
month is used as a single low-confidence data point. The month range starts at the **whole store's**
earliest paid order, so a recently-added product would carry a tail of leading `$0` months from before it
existed; those are **trimmed** per product (`rawSeries.slice(firstSale)`) so the padding doesn't dilute the
average or push a short-lived product into the 4+-month exponential-smoothing branch seeded at level 0
(understating demand). `$0` months **after** the first sale are kept (real dry-month demand signal); a
product that never sold gets an empty series → `computeForecast` returns `0`/"Sin datos".

`forecastNextMonth` is rounded to an integer, which can round a real-but-thin demand (~0.4 units/month)
down to `0`; an `effectiveForecast` (the raw average of the trimmed series) is used as a floor whenever
that happens, so `diasCobertura`/`suggestedOrder` don't fall back to the "no sales" sentinel for a product
that actually has sales history and zero stock — `forecastNextMonth` in the response still reports the raw
rounded forecast. From that it derives `diasCobertura` (`round(stock / effectiveForecast × 30)`, `999`
sentinel only when there's neither a rounded forecast nor sales history), `suggestedOrder`
(`max(0, round(effectiveForecast × 2) − stock)`, a 2-month target minus stock),
`ingresoMensual`/`margenMensual` (from the avg of the trimmed complete-month series × price/margin),
`costoEstimadoPedido`, and `priority` (`urgente` <15 días · `pronto` <45 · `ok`). Rows are sorted by
priority rank then `margenMensual` desc. Rounding mirrors the frontend mock exactly:
`ingresoMensual`/`margenMensual`/`diasCobertura`/`suggestedOrder`/`forecastNextMonth` are integers, while
`revenue`/`totalRevenue`/`costoEstimadoPedido` are left raw.

Per the ROADMAP, the backend serves only the raw monthly + replenishment rows; derived metrics (% del
total, promedios, tendencia vs mes anterior) are computed by the frontend. Cost fields appear here because
these are authenticated admin routes. The per-product series extraction transposes each month's `byProduct`
into a `Map<productId, unitsSold>` once (`unitsByMonthMaps`) rather than a `.find()` per product×month
pair, keeping it O(months×products) instead of O(months×products²).

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

`src/services/productImport.service.ts`, `src/schemas/productImport.ts`, `src/utils/excelCell.ts`,
`src/utils/sizesSpec.ts`.

El dueño da de alta mercancía nueva y restockea la existente subiendo una hoja de cálculo. Son **dos
pasos**, y esa separación es la decisión central de la fase:

1. `POST /api/admin/products/import/preview` `[auth]` — recibe el `.xlsx` por multipart/form-data (campo
   `file`, máx. 2 MB, máx. **500 filas**, `uploadProductImportFile`, mismo patrón `memoryStorage()` que las
   imágenes, mimetype fijo de OOXML) y devuelve el plan **sin escribir nada**: por fila, su `action`
   (`create`/`update`/`unchanged`/`error`), el producto con el que empareja (`before`, `null` si se
   creará), cómo quedaría (`after`), los campos que cambian (`changes`) y el stock por talla
   (`sizeChanges`, con `before`/`added`/`after`).
2. `POST /api/admin/products/import` `[auth]` — recibe **JSON** `{ rows }` (los `input` que devolvió el
   preview, con las ediciones que el dueño haya hecho en pantalla) y los aplica.

Es JSON y no el `.xlsx` original a propósito: lo que se escribe es lo que se revisó y corrigió. El paso de
revisión **no es cosmético** — el restock SUMA stock y no hay forma de deshacerlo desde la app, así que
aplicar un archivo a ciegas (con una fórmula que no se leyó, una columna mal escrita o un nombre que
empareja con el producto equivocado) sale caro. Por eso el diseño entero está sesgado a **fallar la fila
antes que aplicarla en silencio**: el modo de fallo caro no es el error visible, es la fila que responde
"actualizado" sin haber actualizado nada.

**Lectura de celdas** (`src/utils/excelCell.ts`): `exceljs` (no `xlsx`/SheetJS — sin historial de CVEs de
prototype pollution) parsea el workbook, pero `ExcelJS.CellValue` **no es solo `string | number`**: una
celda llega como `{ formula, result }`, `{ sharedFormula, result }`, `{ richText }`, `{ text, hyperlink }`
o `{ error }`. Sin desempaquetar cada forma, `String(value)` da `"[object Object]"` — que en una columna
de texto se guardaba tal cual como nombre del producto y en una numérica se volvía `NaN`.
`readCellText`/`readCellNumber`/`readCellBoolean` distinguen **tres** resultados:
- **vacío** → la clave se OMITE de la fila, así que una actualización parcial no toca esa columna (crítico
  porque `code`/`description` aceptan cadena vacía como valor válido en el schema base: una clave presente
  con `""` blanquearía la columna al hacer `existing.update(fields)`);
- **`problem`** → la celda tiene contenido pero es ilegible (fórmula sin `result` calculado, `#REF!`,
  `Visible: "quizá"`) → se acumula en `cellErrors` y **la fila falla**;
- **`warning`** → se leyó con una interpretación a confirmar (coma decimal `"1,5"` → `1.5` en vez de los
  `15` que salían al quitar todas las comas; celda con formato de fecha, que es como Excel autoformatea un
  código tipo `1-2`). El preview los muestra y el dueño decide.

**Encabezados**: canónico en español (`Código | Nombre | Categoría | Descripción | Precio original |
Precio oferta | Costo unitario | Tallas | Peso (kg) | Largo (cm) | Ancho (cm) | Alto (cm) | Visible`),
insensible a acentos/mayúsculas y con alias comunes (`sku`→`code`, `tipo`→`type`, …) vía `HEADER_ALIASES`.
Una columna **no reconocida** no se descarta en silencio: se reporta en el `warnings` a nivel archivo. Dos
columnas que normalizan al **mismo** campo son un **400** — antes ganaba la última no vacía.

**Tallas** (`src/utils/sizesSpec.ts`): además de la notación heredada del `ProductForm` (`"25, 26, 26"`,
una ocurrencia = una unidad) se acepta **`"26x20"`** (20 piezas de la talla 26), mezclables
(`"25x3, 26, 27x2"`). La notación `x` existe porque el caso de uso central es el **restock**: repetir
`"26,"` veinte veces es inviable en una hoja de cálculo. Hay topes (talla 1–999, 9 999 piezas por entrada,
60 tallas distintas, 10 000 piezas por fila) porque el modelo no valida tallas: sin ellos entraba una talla
de 8 dígitos sin chistar.

**Emparejamiento**: si la fila trae `código`, por `code` **insensible a mayúsculas** (columna con **índice
único parcial**); si no, por `nombre` exacto insensible a mayúsculas usando `lower(name) = lower(?)` —
**nunca `iLike`**, que interpreta `%`/`_` como comodines: una fila llamada `"Bota%Premium"` emparejaba con
`"Bota Roja Premium"` y, al aplicarse el campo `name`, la **renombraba**. Un valor que empareja con **más
de un producto** es ambiguo (`name` no tiene índice único) y la fila falla pidiendo un código, en vez del
`findOne` arbitrario de antes. Si el código de la hoja solo difiere en mayúsculas del guardado, empareja
pero **no** reescribe el código (sería renombrar la clave del catálogo por una diferencia de tecleo).

Sin match → crea un producto nuevo (mismos campos requeridos que `POST /api/admin/products`). Con match →
actualiza **solo** los campos presentes en la fila **y que realmente cambian** (una columna ausente nunca
borra un valor guardado); si la fila trae `Tallas`, **suma** esas unidades al stock ya guardado por talla
vía un upsert `INSERT ... ON CONFLICT ("productId","size") DO UPDATE SET stock = product_sizes.stock +
EXCLUDED.stock` — **nunca** el destroy+recreate que usa `adminUpdateProduct` para una edición manual,
porque ahí sí se quiere reemplazar. Una fila que empareja pero no cambia nada es `unchanged`, no
`updated`. Un producto **soft-deleted** que hace match se **reactiva** (`deletedAt: null`, y `visible:
true` salvo que la fila diga lo contrario) — restockear implica que vuelve a venderse.

`validateRow`/`projectSnapshot` son **compartidos** entre preview y confirmación: el diff que se muestra y
lo que se escribe salen del mismo código, así que no pueden divergir.

**El preview resuelve contra un catálogo virtual**: el estado real de la BD más lo que las filas anteriores
del mismo archivo ya proyectaron (`pendingByCode`/`pendingByName`/`projectedById`). Sin ese overlay, un
archivo donde la fila 2 crea `BTA-9` y la fila 5 lo restockea mostraría dos altas del mismo producto,
mientras que al confirmar sí sería un update. El preview hace **2 consultas** para todo el archivo.

En la **confirmación**, cada fila corre **independiente** (éxito parcial) y **secuencialmente**, nunca con
`Promise.all` — a propósito, para que una fila pueda crear un producto que una fila posterior del mismo
lote restockee por ese mismo código. El match se hace **dentro** de la transacción y con `FOR UPDATE` sobre
`products` (con `lock: { level, of: Product }`, porque `FOR UPDATE` con el include `hasMany` de
`productSizes` revienta en Postgres — lado nullable de un LEFT JOIN): cargarlo fuera dejaba una ventana
entre la lectura y el update.

**Doble envío**: `assertNotDuplicateCommit` rechaza con **409** el mismo lote enviado dos veces en menos de
60 s (hash sha256 del payload). Es un `Map` en memoria, deliberadamente **no persistido** — misma decisión
y limitación asumida que el contador de `pendingOrderSweeper.ts`. Protege del accidente (doble clic,
reintento del navegador), no del abuso; la barrera dura contra duplicados sigue siendo el índice único de
`code`. Desde la Fase O.2 el mapa con TTL y la huella salen de `src/utils/idempotency.ts`, compartidos con
el guard del checkout; lo que **no** se comparte es la política — aquí un reenvío se rechaza, en
`POST /api/orders` se le devuelve la respuesta del original.

Errores por fila se traducen a un mensaje en español con prefijo `Fila N:` (zod, `AppError`, o un
`UniqueConstraintError` del índice de `code`). Un `ZodError` compone **hasta 3 mensajes de campo** + "(y N
campos más por corregir)", igual que `messageFromDetails` en `errorHandler.ts`: reportar solo `issues[0]`
obligaba a corregir una columna, volver a subir y descubrir la siguiente — y como el restock suma, cada
reintento del archivo completo volvía a sumar el stock de las filas que sí habían funcionado. Cualquier
error no esperado se loguea con `logger.error` antes de degradarse a fila de error. Un `.xlsx` corrupto (o
un `.csv`/`.xls` renombrado, que pasa el filtro de mimetype) da un **400** accionable en vez del 500
genérico. Respuestas: `{ summary: { total, created, updated, unchanged, failed }, warnings, rows }` en el
preview y `{ summary, rows: [{ row, status, code, name, productId?, message }] }` al confirmar.

El límite de `express.json()` en `src/app.ts` está en **1 mb** (no los 100 kb por defecto) porque la
confirmación manda hasta 500 filas de producto en un solo body.

`products.code` (nullable, sin restricción antes de esta fase — líneas como `ropa` legítimamente no lo
usan) ganó un **índice único parcial** (`WHERE code IS NOT NULL AND code != ''`) vía
`20260727120000-products-code-unique-index.ts`; declarado también en `Product.init()`'s `indexes` (mismo
motivo que el índice de `product_sizes`: `tests/setup/db.ts` construye el esquema con
`sync({ force: true })`, no con migraciones). Esta migración falla si ya existen códigos duplicados no
vacíos — intencional, no se deduplica en silencio.

**Nota sobre `.partial()` en zod 4** (aplica a todo el repo): `.partial()` **NO** quita los `.default()`.
`z.object({ visible: z.boolean().default(true) }).partial().parse({})` devuelve `{ visible: true }`. Por eso
tanto `productImportUpdateSchema` como `productUpdateSchema` re-declaran `visible` —y `stock`— como
opcionales puros con un `.extend()` aplicado **después** de `.partial()`. Sin eso, un `PUT` que solo
cambiaba el nombre ponía `visible: true` y **publicaba un producto oculto**. Al agregar un campo con
`.default()` a `productBaseSchema`, hay que replicarlo en ambos `.extend()`.

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
  above.

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
alert, not a correctness guarantee), and a payment captured against a cancelled order. `email.service.ts`'s
own two failure branches stay log-only **by design** — routing them through `sendAlertEmail` would create a
loop where a Resend outage tries to alert about itself over the same broken channel. `src/seed.ts`'s
`console.log`s are unchanged (a one-off CLI script).

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
9 = brand/admin users; 10 = dashboard/reports aggregations) — **all twelve are done** (57 suites / 703 tests
at last count; new phases add their own suite, e.g. `adminOrderStatus.test.ts` (O.1),
`checkoutIdempotency.test.ts` + `pendingOrderSweeper.test.ts` (O.2), `shipmentRetry.test.ts` (O.3),
`orderLookup.test.ts` + `unit/services/orderConfirmationTemplate.test.ts` (O.4), the six coupon suites
(N.2), `adminExpenses.test.ts` + `unit/services/expenses.test.ts` (N.3), and `newOrderNotification.test.ts`
+ `dailySalesDigest.test.ts` + `unit/utils/storeDay.test.ts` +
`unit/services/newOrderNotificationTemplate.test.ts` (N.4), and `unit/services/packing.test.ts` (N.6)).
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

## Conventions

- TypeScript runs in `strict` mode with decorators enabled (`experimentalDecorators`,
  `emitDecoratorMetadata`); source in `src/`, output in `dist/`.
- **Configuration comes exclusively from environment variables.** `.env` is gitignored — never commit it
  (the Stripe/Resend keys are test/sandbox; Skydropx points at its own separate sandbox account).
  - **Required (server throws at startup without them):** `DATABASE_URL`, `JWT_SECRET`,
    `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, the three
    `CLOUDINARY_*` keys, `SKYDROPX_CLIENT_ID`, `SKYDROPX_CLIENT_SECRET`, `SKYDROPX_WEBHOOK_SECRET`, and all
    eight `SHIP_FROM_*`
    (`POSTAL_CODE`/`STATE`/`CITY`/`NEIGHBORHOOD`/`STREET`/`EXTERNAL_NUMBER`/`NAME`/`PHONE`).
  - **Optional:** `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `JWT_EXPIRES_IN`, `FRONTEND_URL`, `STRIPE_CURRENCY`,
    `PENDING_ORDER_TTL_MINUTES` (30), `PENDING_ORDER_SWEEP_INTERVAL_MINUTES` (10), `SKYDROPX_BASE_URL`
    (sandbox host), `SKYDROPX_CARRIERS`, `SHIPMENT_RETRY_DELAY_MINUTES` (15),
    `SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES` (10), `HEALTH_READY_TIMEOUT_MS` (3000), `MIN_CHARGE_MXN` (10),
    `DAILY_DIGEST_HOUR` (8), `DAILY_DIGEST_CHECK_INTERVAL_MINUTES` (15), `SENTRY_DSN` (enables Sentry if
    set), `ALERT_EMAIL_TO` (operational alerts), `OWNER_NOTIFICATION_EMAIL` (business notifications, falls
    back to `ALERT_EMAIL_TO`; with neither set, Fase N.4 is off — deliberately its only switch),
    `LOG_LEVEL`, and `TRUST_PROXY`.
  - **Numeric knobs go through `positiveNumberEnv` (`src/utils/env.ts`)**, not a bare
    `Number(process.env.X ?? default)`: `??` only falls back on `undefined`, so a blank line in `.env`
    parses as `0` and a typo as `NaN` — and a `0` retry margin means a sentinel claimed milliseconds ago
    counts as orphaned, so a concurrent retry would pay for a second label. **Use it for any new numeric
    env knob.** Note it rejects `0`, so the valid digest hour is 1–23 (a known, costless limitation).
    `MIN_CHARGE_MXN` and the digest knobs live in their services, **not** in a `config/*`, for the
    mock-shadowing reason documented in the coupon section.
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
- `sequelize-cli` + `ts-node` (devDependencies) drive schema migrations via `.sequelizerc` /
  `src/config/sequelize-cli.js`. Both are devDependencies: a production deploy step running `pnpm migrate`
  needs them installed at that point (`pnpm install` without `--prod`, or promote them to `dependencies` —
  a decision for whenever the deploy pipeline is built).

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
