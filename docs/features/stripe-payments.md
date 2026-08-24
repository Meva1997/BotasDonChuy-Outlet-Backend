# Payments / Stripe (Fase 8)

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
`markOrderPaymentFailed`; `payment_intent.canceled` → `releaseOrderStock`; `charge.dispute.created` /
`.updated` / `.closed` → `applyDisputeFromWebhook` (Fase 28, en **Disputas / contracargos** de `CLAUDE.md`).

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
