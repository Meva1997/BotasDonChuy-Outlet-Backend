# Checkout

`src/routes/public/order.routes.ts`, `src/controllers/order.controller.ts`,
`src/services/orders.service.ts`. `POST /api/orders` is **public**.

Body `{ items: [{ productId, size, quantity }], customer, acceptedTerms, termsVersion,
shippingCarrier?, quotationId?, rateId?, couponCode? }`, validated with `createOrderSchema` (zod,
`src/schemas/checkout.ts`), capping `quantity` at
99/item and `items` at 50/order (the real per-size limit is enforced by the atomic decrement → `409`).

- `acceptedTerms`/`termsVersion` (Fase 27) are the **only required fields besides `items`/`customer`**.
  `acceptedTerms` is `z.literal(true)`, not `z.boolean()`: an explicit `false` must be rejected exactly
  like an absent field, because they state the same fact (no consent) — with `z.boolean()` a `false`
  would validate and get persisted as a record asserting the opposite of what it means. `termsVersion`
  is the ISO date of the legal documents the buyer was shown (`/^\d{4}-\d{2}-\d{2}$/`); only the client
  knows which text it rendered, hence it travels in the body.
  **This deliberately breaks compatibility**: any client posting without consent now gets a `400`. It's
  what makes Términos §8 ("sin esa aceptación el proceso no avanza") true at the system level rather
  than only for whoever uses the UI.
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

**Constancia de aceptación (Fase 27).** `Order.create` also writes three columns: `termsVersion`
(from the body), `termsAcceptedAt` (`new Date()` — **server clock**, not the client's) and
`termsAcceptedIp` (`req.ip`, reusing the existing `CheckoutContext.clientIp` seam built for coupon
redemptions — the same "IP comes from the request and NEVER from the body" rule). The timestamp is
the transaction's, not the checkbox click's (they can differ by minutes); that's the moment Términos
§15 actually refers to. All three are **nullable with no backfill**: `null` means *"no hay
constancia"* — an order predating the phase — and must never be rendered as "accepted".

Three scope decisions worth not reverting blindly:

1. **`termsAcceptedIp` is in the reload's `attributes.exclude` list.** That list is an *exclusion*
   list, so every new `Order` column serializes itself into the public `201` until someone adds it.
   Returning the buyer their own IP adds nothing. `termsAcceptedAt`/`termsVersion` do ride along —
   they're the record of what the buyer just accepted. Covered by a test.
2. **It never reaches `GET /api/orders/lookup/:token`.** That projection is an allow-list, so it
   didn't leak on its own; it's left out because the link gets shared over WhatsApp and the record is
   the merchant's evidence, not the buyer's tracking data.
3. **It does not enter `checkoutFingerprint`.** `acceptedTerms` can't vary (the schema forces `true`),
   and two attempts differing only in `termsVersion` — the documents were edited mid-session — must
   replay the original order rather than double-charge. Since the fingerprint is an explicit allow-list
   and not a hash of the raw body, adding payload fields changed no previously-issued fingerprint.

**⚠️ `TRUST_PROXY` is a deployment requirement, not a detail.** `app.ts` only calls
`app.set("trust proxy", …)` when that env var is set (deliberately opt-in — `true` on a directly
exposed server lets anyone spoof `X-Forwarded-For`). Without it in production, `req.ip` is the
proxy's and every order records the same address: worse than storing nothing, because it looks
like evidence.

The route is gated by `orderRateLimiter` (Fase H.3, `src/middlewares/rateLimit.ts`, 10 req/min per IP):
every successful request creates a real Stripe PaymentIntent and an `Order` row, so a sustained flood
would burn Stripe's account-level rate limit and bloat the orders table even though `pendingOrderSweeper`
eventually releases the unpaid ones. Only mounted on the public `POST /`, not on `adminOrder.routes.ts`
(already behind `requireAuth`).

## Checkout idempotency (Fase O.2)

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
