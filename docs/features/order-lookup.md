# Public order lookup (Fase O.4)

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

**Token rotation (Fase O.6 — `POST /api/admin/orders/:id/rotate-token` `[auth]` →
`orders.service.rotatePublicToken`)**: the Aviso de Privacidad promises "si crees que tu código quedó
expuesto, escríbenos y lo invalidamos"; before this route the only way to honor it was a manual SQL
`UPDATE` against production. Setting `publicToken` to `NULL` was rejected as the fix — it also kills the
legitimate buyer's own tracking access, not just the leaked link — so this **rotates** it instead:
generates a fresh `randomUUID()` and persists it, and the old token simply stops matching in
`getOrderByPublicToken`'s `WHERE publicToken = token` (no blacklist needed). It works **regardless of
`order.status`** — unlike `cancelOrderByAdmin`/`updateOrderStatusByAdmin`, there's no state guard here,
since invalidating an exposed link has to work no matter what state the order is in. No transaction/lock:
it's a single-column write with no multi-row invariant, so a concurrent double-rotation is harmless
(last write wins, same as `updateOrderStatusByAdmin`'s loose field updates). No body, no `reason` field,
no audit of who requested it — the route is deliberately minimal.

The buyer is emailed the new code via `sendTokenRotatedEmail` (`payment.service.ts`), which reuses
`orderConfirmationTemplate` with a new `codeRotated` flag that swaps only the intro copy (everything
else — items, totals, address, the tracking-page block — renders unchanged, same as the confirmation/
shipped split). Its subject ("Actualizamos tu código de rastreo…") is deliberately distinct from
confirmation/shipped so it doesn't read as a duplicate. Its `idempotencyKey`
(`` `order-token-rotated/${order.id}/${order.publicToken}` ``) deliberately differs from the fixed,
once-ever keys `order-confirmation/${id}`/`order-shipped/${id}`: rotation is repeatable by design, so a
fixed key would make Resend silently dedupe every rotation after the first. Including the (fresh) token
itself gives each rotation a unique key for free, no counter/timestamp needed.
