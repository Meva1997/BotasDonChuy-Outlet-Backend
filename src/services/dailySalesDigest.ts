import { Op, type WhereOptions } from "sequelize";
import { Order, type OrderAttributes } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { FRONTEND_URL } from "../config/resend";
import { sendEmail } from "./email.service";
import { ownerNotificationRecipient } from "./ownerNotification.service";
import { SHIPMENT_CREATION_SENTINEL } from "./payment.service";
import {
  dailySalesDigestSubject,
  dailySalesDigestTemplate,
  type DigestOrderRow,
} from "./email/templates/dailySalesDigest";
import {
  formatStoreTime,
  previousStoreDay,
  storeDay,
  storeDayRange,
  storeHour,
} from "../utils/storeDay";
import { positiveNumberEnv } from "../utils/env";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";

/**
 * Resumen diario de ventas (Fase N.4), tercer cron del proceso junto a `pendingOrderSweeper` y
 * `shipmentRetrySweeper`.
 *
 * Complementa —no sustituye— al aviso por venta: aquel es un disparador de acción ("empaca esto")
 * y este es reconciliación ("cómo cerró el día"). Con solo el resumen, un pedido de las 3pm no se
 * conocería hasta el corte del día siguiente, o sea hasta un día de retraso en despachar.
 */

/**
 * Hora local de la tienda a la que se manda el resumen del día ya cerrado. Las 8:00 y no un corte
 * a las 21:00 porque el día anterior COMPLETO no está truncado: sus números cuadran con el panel y
 * no hay ventas de la noche que queden sin caer en ningún resumen.
 *
 * Ojo: `positiveNumberEnv` rechaza `0`, así que el rango útil es 1–23. Es una limitación conocida y
 * sin costo real (un resumen a medianoche no lo lee nadie), preferible a duplicar el parser solo
 * por ese valor.
 */
const DAILY_DIGEST_HOUR = positiveNumberEnv("DAILY_DIGEST_HOUR", 8);

/**
 * Cada cuánto se revisa si toca mandar. No es la cadencia del correo (ese es diario): es la
 * resolución con la que se detecta que ya pasó `DAILY_DIGEST_HOUR`. 15 min significa que el resumen
 * sale, a más tardar, 15 min después de la hora configurada.
 */
const DAILY_DIGEST_CHECK_INTERVAL_MINUTES = positiveNumberEnv(
  "DAILY_DIGEST_CHECK_INTERVAL_MINUTES",
  15,
);

/**
 * Último día ya resumido. En memoria y deliberadamente **no persistido**, misma decisión y misma
 * limitación asumida que los mapas de `pendingOrderSweeper`/`shipmentRetrySweeper` y que
 * `IdempotencyStore`: se reinicia con el proceso.
 *
 * Aquí esa limitación sí importaba (un redeploy a las 8:05 mandaría el resumen dos veces), y por eso
 * la segunda capa **no es memoria sino Resend**: el `idempotencyKey: daily-sales/<día>` tiene una
 * ventana de 24 h que coincide exactamente con la cadencia diaria, así que cubre el redeploy *y*
 * varias instancias sin necesidad de una columna ni una tabla nuevas.
 */
let lastSentDay: string | null = null;

/** Olvida el día ya enviado. Solo para los tests: el estado vive en el módulo y sobrevive al truncate. */
export function resetDailySalesDigestState(): void {
  lastSentDay = null;
}

/**
 * Pedidos que cuentan como venta de un día.
 *
 * `paymentStatus: "paid"` y **no** `status: "paid"`: el `status` avanza a `shipped`/`delivered` en
 * cuanto sale la guía, así que filtrar por él dejaría fuera justo los pedidos despachados el mismo
 * día — lo peor que le puede pasar a un correo de reconciliación. Es el mismo arreglo que esta fase
 * aplicó a `dashboard.service.ts` y `reports.service.ts`.
 *
 * La ventana se mide sobre `createdAt` y no sobre "cuándo se pagó" porque **no existe una columna
 * `paidAt`**; agregarla exigiría una migración con un backfill imposible de reconstruir, y además
 * dejaría este resumen midiendo algo distinto del dashboard, que también agrupa por `createdAt`.
 * Consecuencia asumida: un pedido creado a las 11:55pm y pagado a las 00:05 cuenta en el día
 * anterior.
 */
function salesOfDayWhere(day: string): WhereOptions<OrderAttributes> {
  const { from, to } = storeDayRange(day);
  return {
    paymentStatus: "paid",
    createdAt: { [Op.between]: [from, to] },
  } as WhereOptions<OrderAttributes>;
}

interface DayTotals {
  orderCount: number;
  pieces: number;
  revenue: number;
  shipping: number;
  couponDiscount: number;
  savings: number;
}

function emptyTotals(): DayTotals {
  return { orderCount: 0, pieces: 0, revenue: 0, shipping: 0, couponDiscount: 0, savings: 0 };
}

/** Un pedido sigue "sin guía" mientras no tenga un id real: `null` o el centinela de creación. */
function needsLabel(order: Order): boolean {
  return (
    order.skydropxShipmentId === null ||
    order.skydropxShipmentId === SHIPMENT_CREATION_SENTINEL
  );
}

function summarize(orders: Order[]): { rows: DigestOrderRow[]; totals: DayTotals } {
  const totals = emptyTotals();
  const rows = orders.map((order) => {
    const pieces = (order.items ?? []).reduce((acc, item) => acc + item.quantity, 0);
    totals.orderCount += 1;
    totals.pieces += pieces;
    totals.revenue += order.total;
    totals.shipping += order.shipping;
    totals.couponDiscount += order.couponDiscount ?? 0;
    totals.savings += order.savings;
    return {
      id: order.id,
      time: formatStoreTime(order.createdAt),
      customerName: order.customerName,
      pieces,
      total: order.total,
      status: order.status,
      needsLabel: needsLabel(order),
      requiresDropoff: order.shippingRequiresDropoff === true,
    };
  });
  return { rows, totals };
}

/**
 * Arma y manda el resumen de un día concreto. Exportada para poder dispararla a mano (verificación
 * manual) y desde los tests, igual que `sweepOnce`/`sweepShipmentsOnce`.
 *
 * **Nunca lanza**: `sendEmail` ya "loguea pero no lanza" y el try/catch cubre las consultas, para
 * que un fallo no escape como rechazo sin capturar del `setInterval`.
 */
export async function sendDailySalesDigest(day: string): Promise<void> {
  const to = ownerNotificationRecipient();
  if (!to) {
    logger.warn(
      { day },
      "OWNER_NOTIFICATION_EMAIL/ALERT_EMAIL_TO no configurados; resumen diario omitido",
    );
    return;
  }

  try {
    const orders = await Order.findAll({
      where: salesOfDayWhere(day),
      // Solo se leen las cantidades: el resumen cuenta piezas, no renglones de producto.
      include: [{ model: OrderItem, as: "items", attributes: ["quantity"] }],
      order: [["createdAt", "ASC"]],
    });

    const { rows, totals } = summarize(orders);

    await sendEmail({
      to,
      subject: dailySalesDigestSubject({
        day,
        orderCount: totals.orderCount,
        revenue: totals.revenue,
      }),
      html: dailySalesDigestTemplate({
        day,
        orders: rows,
        totals,
        adminUrl: `${FRONTEND_URL.replace(/\/+$/, "")}/admin`,
      }),
      // Segunda capa de idempotencia: ventana de 24 h de Resend, que coincide con la cadencia
      // diaria. Es lo que hace que un redeploy (o una segunda instancia) no mande el resumen dos
      // veces, ya que `lastSentDay` vive solo en memoria.
      idempotencyKey: `daily-sales/${day}`,
    });

    logger.info(
      { day, orderCount: totals.orderCount, revenue: totals.revenue },
      "[digest] resumen diario de ventas enviado",
    );
  } catch (err) {
    logger.error({ day, err }, "[digest] no se pudo enviar el resumen diario");
    Sentry.captureException(err, { extra: { day } });
  }
}

/**
 * Un tick del cron: decide si toca mandar y, en su caso, manda.
 *
 * Una vez pasada `DAILY_DIGEST_HOUR` en hora de la tienda, el día objetivo es **ayer** (ya cerrado
 * y completo). Si el proceso estuvo caído varios días, al arrancar manda **solo el más reciente
 * pendiente**, no un backfill: el histórico completo vive en el dashboard y una ráfaga de correos
 * viejos al volver de una caída no le sirve a nadie.
 *
 * Exportada para los tests (el `setInterval` no corre bajo `NODE_ENV=test`); `now` es inyectable
 * para poder situarse a una hora concreta sin timers falsos.
 */
export async function runDigestTick(now: Date = new Date()): Promise<void> {
  if (storeHour(now) < DAILY_DIGEST_HOUR) return;

  const targetDay = previousStoreDay(storeDay(now));
  if (lastSentDay === targetDay) return;

  // Se marca ANTES de mandar y no después: `sendDailySalesDigest` nunca lanza, así que un fallo de
  // correo no debe provocar un reintento en cada tick de los siguientes 15 min (Resend lo
  // deduplicaría, pero se estarían repitiendo las consultas). El día siguiente vuelve a intentar.
  lastSentDay = targetDay;
  await sendDailySalesDigest(targetDay);
}

let timer: NodeJS.Timeout | null = null;

/**
 * Arranca la revisión periódica. No corre en entorno de test. `unref()` evita que el timer
 * mantenga vivo el proceso por sí solo.
 */
export function startDailySalesDigest(): void {
  if (process.env.NODE_ENV === "test") return;
  if (timer) return; // ya arrancado

  timer = setInterval(() => {
    runDigestTick().catch((err) => {
      logger.error({ err }, "[digest] fallo en el ciclo del resumen diario");
      Sentry.captureException(err);
    });
  }, DAILY_DIGEST_CHECK_INTERVAL_MINUTES * 60_000);
  timer.unref();

  logger.info(
    {
      hour: DAILY_DIGEST_HOUR,
      checkIntervalMinutes: DAILY_DIGEST_CHECK_INTERVAL_MINUTES,
      configured: Boolean(ownerNotificationRecipient()),
    },
    "Resumen diario de ventas activo",
  );
}

/**
 * Detiene la revisión periódica. Se llama en el apagado ordenado (ver `app.ts`). Idempotente.
 */
export function stopDailySalesDigest(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
