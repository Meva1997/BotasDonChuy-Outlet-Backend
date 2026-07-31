import { Op, type WhereOptions } from "sequelize";
import { Order } from "../models/Order";
import { retryShipmentFromSweeper, pendingShipmentWhere } from "./payment.service";
import { sendAlertEmail } from "./alert.service";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";
import {
  SHIPMENT_RETRY_DELAY_MINUTES,
  SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES,
} from "../config/skydropx";

/**
 * Barrido de guías pendientes (Fase O.3), cron gemelo del de órdenes `pending`.
 *
 * La guía se genera fire-and-forget al confirmarse el pago (`createShipmentForOrder` desde
 * `markOrderPaidFromWebhook`). Si esa única llamada falla —Skydropx caído, saldo agotado, o el
 * proceso muere y deja el centinela `"creating"` huérfano— el pedido queda pagado y sin guía
 * **para siempre**: no hay webhook que llegue por una guía que nunca se creó. Hasta esta fase
 * el único desenlace era un correo de alerta y que alguien lo resolviera a mano.
 *
 * Cada ciclo toma los pedidos `paid` con tarifa de Skydropx que siguen sin guía pasado
 * `SHIPMENT_RETRY_DELAY_MINUTES` (ver `pendingShipmentWhere`, que también libera el criterio del
 * centinela huérfano) y reintenta. Nunca toca una orden con guía real ni una marcada como
 * "cobrada sin persistir": generar una segunda guía cuesta dinero, así que ante la duda no se
 * genera.
 *
 * Exportado `sweepShipmentsOnce` para los tests, igual que `sweepOnce` del otro barrido:
 * `startShipmentRetrySweeper` no corre en `NODE_ENV=test`, así que la suite ejecuta un ciclo
 * suelto en vez de esperar al `setInterval`.
 */

/**
 * Intentos por pedido antes de rendirse y alertar. En memoria y deliberadamente **no
 * persistido** — misma decisión y misma limitación asumida que el contador de fallos de
 * `pendingOrderSweeper` y que los mapas de idempotencia: se reinicia con el proceso, y ahí el
 * tope real lo pone `MAX_ORDER_AGE_HOURS`, que saca del barrido a los pedidos viejos.
 */
const MAX_ATTEMPTS_PER_ORDER = 3;

/**
 * Intentos fallidos por pedido, con el momento del último para poder caducarlos.
 *
 * La caducidad se mide en el tiempo y **no** por "ya no aparece en el resultado del ciclo": ese
 * resultado viene recortado a `MAX_ORDERS_PER_SWEEP`, así que un pedido que se cae de la página
 * por un ciclo perdía su contador y volvía a empezar en cero — tres llamadas más a Skydropx y una
 * segunda alerta idéntica, repitiéndose mientras el pedido siguiera entrando y saliendo de la
 * página. `MAX_ORDER_AGE_HOURS` ya acota cuánto tiempo puede vivir una entrada, así que el mapa
 * tampoco crece sin límite.
 */
const attemptsByOrderId = new Map<number, { failures: number; lastAttemptAt: number }>();

/**
 * Antigüedad máxima de un pedido para seguir intentando su guía. Pasado ese punto el fallo ya
 * no es transitorio y el pedido necesita una decisión humana (¿otra paquetería?, ¿reembolso?);
 * seguir reintentando solo gastaría llamadas y llenaría el log.
 */
const MAX_ORDER_AGE_HOURS = 24;

/** Tope de pedidos por ciclo: Skydropx limita a 2 req/s la cuenta entera (ver skydropx.service). */
const MAX_ORDERS_PER_SWEEP = 20;

export async function sweepShipmentsOnce(): Promise<void> {
  const now = Date.now();
  const oldestCreatedAt = new Date(now - MAX_ORDER_AGE_HOURS * 3_600_000);

  // Olvida los contadores más viejos que la ventana del barrido: esos pedidos ya salieron de
  // candidatura por antigüedad y nunca volverán a entrar.
  for (const [id, entry] of attemptsByOrderId) {
    if (entry.lastAttemptAt < oldestCreatedAt.getTime()) attemptsByOrderId.delete(id);
  }

  // Los pedidos que ya agotaron sus intentos se excluyen **en la consulta**, no con un `continue`:
  // si no, seguirían ocupando lugares del `LIMIT` en cada ciclo y —como el orden es por
  // `createdAt ASC`— veinte pedidos atorados al frente dejarían sin turno a todos los pedidos más
  // nuevos hasta que envejecieran 24 h.
  const exhaustedIds = [...attemptsByOrderId]
    .filter(([, entry]) => entry.failures >= MAX_ATTEMPTS_PER_ORDER)
    .map(([id]) => id);

  const where: WhereOptions = {
    [Op.and]: [
      pendingShipmentWhere(oldestCreatedAt),
      ...(exhaustedIds.length > 0 ? [{ id: { [Op.notIn]: exhaustedIds } }] : []),
    ],
  };

  const pending = await Order.findAll({
    where,
    order: [["createdAt", "ASC"]], // el más viejo primero: lleva más tiempo esperando
    limit: MAX_ORDERS_PER_SWEEP,
  });

  for (const order of pending) {
    const attempts = attemptsByOrderId.get(order.id)?.failures ?? 0;

    try {
      // Secuencial a propósito (no `Promise.all`): cada guía son varias llamadas a Skydropx y
      // el throttle de 2 req/s es de la cuenta completa, compartido con las cotizaciones que
      // están atendiendo checkouts en vivo.
      const attempt = await retryShipmentFromSweeper(order);

      if (attempt.outcome === "created") {
        attemptsByOrderId.delete(order.id);
        logger.info(
          { orderId: order.id, skydropxShipmentId: attempt.shipmentId, attempt: attempts + 1 },
          "[shipment-sweeper] guía recuperada automáticamente",
        );
        continue;
      }

      if (attempt.outcome === "in-progress") {
        // Otra llamada tiene el turno (lo más común: el pedido se pagó tarde y el webhook está
        // creando su guía justo ahora). No se cuenta como fallo — hacerlo gastaba intentos y
        // adelantaba la alerta de un pedido cuya guía se estaba generando perfectamente.
        logger.debug(
          { orderId: order.id },
          "[shipment-sweeper] la guía ya se está creando en otra llamada; sin contar el intento",
        );
        continue;
      }

      if (attempt.outcome === "unreconciled") {
        // Puede haber una guía cobrada: `createShipmentForOrder` ya alertó de forma incondicional
        // y la orden queda marcada, fuera de los candidatos de los próximos ciclos. Nada que
        // reintentar aquí — hace falta una decisión humana.
        logger.error(
          { orderId: order.id, skydropxShipmentId: attempt.shipmentId },
          "[shipment-sweeper] el pedido quedó con una posible guía cobrada sin conciliar",
        );
        attemptsByOrderId.delete(order.id);
        continue;
      }

      const failures = attempts + 1;
      attemptsByOrderId.set(order.id, { failures, lastAttemptAt: Date.now() });
      logger.warn(
        { orderId: order.id, attempt: failures },
        "[shipment-sweeper] el reintento de guía no produjo guía",
      );
      if (failures === MAX_ATTEMPTS_PER_ORDER) {
        // Una sola alerta al agotar los intentos, no una por ciclo: por eso los reintentos
        // pasan `notifyOnFailure: false` a `createShipmentForOrder`.
        void sendAlertEmail({
          subject: `No se pudo generar la guía del pedido #${order.id} tras ${failures} reintentos`,
          context: {
            orderId: order.id,
            attempts: failures,
            skydropxRateId: order.skydropxRateId,
          },
        });
      }
    } catch (err) {
      // `retryShipmentFromSweeper` no lanza por un fallo de Skydropx (lo traga
      // `createShipmentForOrder`), pero sí puede lanzar por la BD. Un pedido no debe frenar el
      // barrido de los demás.
      logger.error(
        { orderId: order.id, err },
        "[shipment-sweeper] error reintentando la guía",
      );
      Sentry.captureException(err, { extra: { orderId: order.id } });
    }
  }
}

/**
 * Olvida los intentos acumulados. Existe **solo para los tests**: el mapa vive en el módulo y
 * sobrevive al `truncateAll` entre casos, así que sin esto un caso heredaría los intentos que
 * otro dejó para el mismo id (los SERIAL se reinician con cada truncate).
 */
export function resetShipmentRetryAttempts(): void {
  attemptsByOrderId.clear();
}

let timer: NodeJS.Timeout | null = null;

/**
 * Arranca el barrido periódico de guías pendientes. No corre en entorno de test. `unref()`
 * evita que el timer mantenga vivo el proceso por sí solo.
 */
export function startShipmentRetrySweeper(): void {
  if (process.env.NODE_ENV === "test") return;
  if (timer) return; // ya arrancado

  timer = setInterval(() => {
    sweepShipmentsOnce().catch((err) => {
      logger.error({ err }, "[shipment-sweeper] fallo en el ciclo de barrido");
      Sentry.captureException(err);
    });
  }, SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES * 60_000);
  timer.unref();

  logger.info(
    {
      intervalMinutes: SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES,
      retryDelayMinutes: SHIPMENT_RETRY_DELAY_MINUTES,
      maxAttempts: MAX_ATTEMPTS_PER_ORDER,
    },
    "Barrido de guías pendientes activo",
  );
}

/**
 * Detiene el barrido. Se llama en el apagado ordenado (ver `app.ts`) para que no arranque un
 * ciclo nuevo mientras se cierra el pool de la BD. Idempotente.
 */
export function stopShipmentRetrySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
