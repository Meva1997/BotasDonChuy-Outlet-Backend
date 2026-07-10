import { Op, type WhereOptions } from "sequelize";
import { Order } from "../models/Order";
import { releaseOrderStock } from "./orders.service";
import { markOrderPaidFromWebhook } from "./payment.service";
import {
  stripe,
  PENDING_ORDER_TTL_MINUTES,
  PENDING_ORDER_SWEEP_INTERVAL_MINUTES,
} from "../config/stripe";

/**
 * Barrido de órdenes `pending` abandonadas.
 *
 * Una orden nace `pending` y reserva stock al crearse (descuento atómico en
 * `createOrder`). Si el cliente nunca completa el pago, ese stock quedaría
 * reservado para siempre. Este barrido, cada `PENDING_ORDER_SWEEP_INTERVAL_MINUTES`,
 * busca órdenes `pending` con más de `PENDING_ORDER_TTL_MINUTES` de antigüedad y las
 * **reconcilia contra Stripe** antes de liberar nada:
 *
 *  - Si el PaymentIntent está `succeeded` → la marca `paid` (recupera un webhook
 *    `payment_intent.succeeded` que se hubiera perdido).
 *  - En otro caso → cancela el PaymentIntent (si es cancelable) y repone el stock
 *    vía `releaseOrderStock` (idempotente y con lock: si el webhook `canceled`
 *    llega a la vez, no se repone dos veces).
 *
 * Reconciliar contra Stripe evita el peor caso: liberar el stock de una orden que
 * en realidad sí se pagó pero cuyo webhook aún no llegaba.
 */
async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_ORDER_TTL_MINUTES * 60_000);
  // WhereOptions (sin genérico) admite `createdAt`, que el timestamp automático de
  // Sequelize agrega a la tabla pero no figura en OrderAttributes.
  const where: WhereOptions = {
    status: "pending",
    createdAt: { [Op.lt]: cutoff },
    paymentIntentId: { [Op.ne]: null },
  };
  const stale = await Order.findAll({ where });

  for (const order of stale) {
    const paymentIntentId = order.paymentIntentId;
    if (!paymentIntentId) continue;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status === "succeeded") {
        await markOrderPaidFromWebhook(paymentIntentId);
        continue;
      }

      // Cancelable: requires_payment_method | requires_capture | requires_confirmation
      // | requires_action | processing. Si ya está canceled, Stripe rechaza el cancel;
      // por eso lo intentamos dentro de su propio try.
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
      } catch (cancelErr) {
        console.warn(
          `[sweeper] no se pudo cancelar el PaymentIntent ${paymentIntentId}: ${(cancelErr as Error).message}`,
        );
      }

      await releaseOrderStock(order.id);
    } catch (err) {
      // Un fallo con una orden no debe frenar el barrido de las demás.
      console.error(
        `[sweeper] error reconciliando la orden ${order.id}:`,
        (err as Error).message,
      );
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Arranca el barrido periódico. No corre en entorno de test. `unref()` evita que
 * el timer mantenga vivo el proceso por sí solo.
 */
export function startPendingOrderSweeper(): void {
  if (process.env.NODE_ENV === "test") return;
  if (timer) return; // ya arrancado

  const intervalMs = PENDING_ORDER_SWEEP_INTERVAL_MINUTES * 60_000;
  timer = setInterval(() => {
    sweepOnce().catch((err) =>
      console.error("[sweeper] fallo en el ciclo de barrido:", err),
    );
  }, intervalMs);
  timer.unref();

  console.log(
    `🧹 Barrido de órdenes pending activo (cada ${PENDING_ORDER_SWEEP_INTERVAL_MINUTES} min, TTL ${PENDING_ORDER_TTL_MINUTES} min)`,
  );
}
