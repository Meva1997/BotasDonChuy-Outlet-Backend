import { Op, type WhereOptions } from "sequelize";
import { Order } from "../models/Order";
import { releaseOrderStock } from "./orders.service";
import { markOrderPaidFromWebhook } from "./payment.service";
import { sendAlertEmail } from "./alert.service";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";
import {
  stripe,
  PENDING_ORDER_TTL_MINUTES,
  PENDING_ORDER_SWEEP_INTERVAL_MINUTES,
} from "../config/stripe";

// Rastreo en memoria de fallos consecutivos por orden (Fase H.4): no existía ningún estado de
// este tipo antes — se resetea en cada restart/redeploy, aceptable porque es una alerta operativa
// blanda, no una garantía de correctitud. Se alerta UNA vez al cruzar el umbral (no en cada ciclo
// posterior) y se olvida la orden si sale de la ventana de "pending" vencidas o si tiene éxito.
const consecutiveFailuresByOrderId = new Map<number, number>();
const REPEATED_FAILURE_ALERT_THRESHOLD = 3;

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

  // Olvida el contador de cualquier orden que ya no esté en la ventana de "pending" vencidas
  // (se resolvió o salió del alcance del barrido) — evita que el Map crezca sin límite.
  const staleIds = new Set(stale.map((o) => o.id));
  for (const id of consecutiveFailuresByOrderId.keys()) {
    if (!staleIds.has(id)) consecutiveFailuresByOrderId.delete(id);
  }

  for (const order of stale) {
    const paymentIntentId = order.paymentIntentId;
    if (!paymentIntentId) continue;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status === "succeeded") {
        await markOrderPaidFromWebhook(paymentIntentId);
        consecutiveFailuresByOrderId.delete(order.id);
        continue;
      }

      // Cancelable: requires_payment_method | requires_capture | requires_confirmation
      // | requires_action | processing. Si ya está canceled, Stripe rechaza el cancel;
      // por eso lo intentamos dentro de su propio try.
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
      } catch (cancelErr) {
        logger.warn(
          { paymentIntentId, err: cancelErr },
          "[sweeper] no se pudo cancelar el PaymentIntent",
        );
      }

      await releaseOrderStock(order.id);
      consecutiveFailuresByOrderId.delete(order.id);
    } catch (err) {
      // Un fallo con una orden no debe frenar el barrido de las demás.
      logger.error({ orderId: order.id, err }, "[sweeper] error reconciliando la orden");
      Sentry.captureException(err, { extra: { orderId: order.id } });

      const failures = (consecutiveFailuresByOrderId.get(order.id) ?? 0) + 1;
      consecutiveFailuresByOrderId.set(order.id, failures);
      if (failures === REPEATED_FAILURE_ALERT_THRESHOLD) {
        void sendAlertEmail({
          subject: `Orden #${order.id} falla repetidamente en el barrido de pendientes`,
          context: {
            orderId: order.id,
            consecutiveFailures: failures,
            lastError: (err as Error).message,
          },
        });
      }
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
    sweepOnce().catch((err) => {
      logger.error({ err }, "[sweeper] fallo en el ciclo de barrido");
      Sentry.captureException(err);
    });
  }, intervalMs);
  timer.unref();

  logger.info(
    {
      intervalMinutes: PENDING_ORDER_SWEEP_INTERVAL_MINUTES,
      ttlMinutes: PENDING_ORDER_TTL_MINUTES,
    },
    "Barrido de órdenes pending activo",
  );
}
