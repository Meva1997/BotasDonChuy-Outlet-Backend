import { Op, type WhereOptions } from "sequelize";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { Product } from "../models/Product";
import { AppError } from "../middlewares/AppError";
import { stripe, STRIPE_CURRENCY } from "../config/stripe";
import {
  SHIP_FROM_EXTERNAL_NUMBER,
  SHIP_FROM_NAME,
  SHIP_FROM_NEIGHBORHOOD,
  SHIP_FROM_PHONE,
  SHIP_FROM_STREET,
  SHIPMENT_RETRY_DELAY_MINUTES,
} from "../config/skydropx";
import { EMAIL_FROM, FRONTEND_URL } from "../config/resend";
import { sendEmail } from "./email.service";
import { sendAlertEmail } from "./alert.service";
import { sendNewOrderNotification } from "./ownerNotification.service";
import { orderConfirmationTemplate } from "./email/templates/orderConfirmation";
import { buildParcels, type ParcelLineItem } from "./packing";
import {
  createShipment,
  getOriginAddress,
  getQuotationRate,
  getShippingRates,
  SkydropxShipmentUncertainError,
  toSkydropxAddress,
  type SkydropxContact,
} from "./skydropx.service";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";

/**
 * Integración de pagos con Stripe (Fase 8, activa).
 *
 * `createPaymentIntentForOrder` crea el PaymentIntent real de la orden recién
 * persistida; su `clientSecret` viaja al cliente para confirmar el pago. La
 * conciliación (orden → `paid`/`failed`) ocurre por webhook verificado por firma
 * (ver `stripeWebhook` en order.controller.ts), nunca por callback del cliente.
 */

export interface PaymentIntentResult {
  clientSecret: string | null;
  paymentIntentId: string | null;
}

/**
 * Crea el PaymentIntent de una orden. El monto se calcula en el servidor a partir
 * del `total` ya recalculado (autoritativo) y se convierte a centavos. Se guarda
 * `orderId` en metadata para conciliar el webhook aunque el lookup por
 * `paymentIntentId` fallara.
 */
export async function createPaymentIntentForOrder(
  order: Order,
): Promise<PaymentIntentResult> {
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(order.total * 100), // total en pesos → centavos
    currency: STRIPE_CURRENCY,
    metadata: { orderId: String(order.id) },
    automatic_payment_methods: { enabled: true },
  });
  return { clientSecret: intent.client_secret, paymentIntentId: intent.id };
}

/**
 * Marca una orden como pagada a partir de un evento de webhook ya verificado.
 * Idempotente: si ya estaba pagada no hace nada. Tolerante a "orden no
 * encontrada" (loguea y retorna sin lanzar) para que un evento verificado siempre
 * responda 200 y Stripe no reintente en bucle por un PaymentIntent ajeno.
 */
export async function markOrderPaidFromWebhook(
  paymentIntentId: string,
): Promise<void> {
  const order = await Order.findOne({ where: { paymentIntentId } });
  if (!order) {
    logger.warn(
      { paymentIntentId, event: "payment_intent.succeeded" },
      "[stripe] payment_intent.succeeded sin orden asociada",
    );
    return;
  }
  // Transición atómica a "paid". El `WHERE paymentStatus != 'paid'` serializa a nivel
  // de BD el webhook y el sweeper (ambos llaman aquí): ante dos ejecuciones concurrentes
  // solo un UPDATE afecta la fila, así que el correo de confirmación se dispara una única
  // vez (el `idempotencyKey` de Resend es un segundo cinturón de seguridad). Un guard en
  // memoria (`if (order.paymentStatus === "paid")`) NO daría esta garantía: dos webhooks
  // podrían leer "processing" antes de que cualquiera escriba y ambos enviarían el correo.
  // `status: "pending"` en el WHERE es igual de necesario: esta transición solo es válida
  // pending → paid. Sin ella, una orden que un admin ya canceló/reembolsó (`status:
  // "cancelled"`, con el stock ya repuesto) podría "resucitarse" a `paid` si este evento
  // llega tarde o duplicado — p. ej. porque el intento best-effort de cancelar el
  // PaymentIntent en `cancelOrderByAdmin` falló en silencio al ya haber tenido éxito el
  // cobro en Stripe.
  const [affected] = await Order.update(
    { status: "paid", paymentStatus: "paid" },
    {
      where: {
        id: order.id,
        status: "pending",
        paymentStatus: { [Op.ne]: "paid" },
      },
    },
  );
  if (affected === 0) {
    if (order.status === "cancelled") {
      // El pago se capturó en Stripe para una orden que ya quedó cancelada (y su stock
      // ya se devolvió a la tienda, quizás ya revendido). No se puede reactivar a ciegas
      // ni reservar stock de nuevo aquí: se deja cancelada y se alerta para que alguien
      // revise si corresponde un reembolso manual.
      logger.error(
        { orderId: order.id, paymentIntentId },
        "[stripe] payment_intent.succeeded para una orden ya cancelada; revisar reembolso manual",
      );
      Sentry.captureException(
        new Error("payment_intent.succeeded en orden ya cancelada"),
        { extra: { orderId: order.id, paymentIntentId } },
      );
      void sendAlertEmail({
        subject: `Pago capturado para la orden cancelada #${order.id}`,
        context: { orderId: order.id, paymentIntentId },
      });
    }
    return; // ya estaba pagada, o no está en pending: no reenviar
  }

  // Fire-and-forget: NO se hace `await`. El correo no debe bloquear la respuesta 200 del
  // webhook — si Resend va lento, Stripe podría exceder su timeout y reintentar el evento
  // en bucle. La orden ya está `paid`; el envío ocurre en segundo plano y su propio
  // try/catch garantiza que un fallo (correo o recarga) nunca propague.
  void sendOrderConfirmationEmail(order);

  // Aviso de venta al dueño (Fase N.4), mismo disparo fire-and-forget y bajo el mismo guard
  // `affected === 1`, que es lo que garantiza que salga UNA vez por pedido aunque el webhook de
  // Stripe y `pendingOrderSweeper` lleguen a la vez. No espera a `createShipmentForOrder`: los dos
  // datos operativos que lleva (`skydropxRateId` y `shippingRequiresDropoff`) se persisten en el
  // checkout, así que encadenarlo solo retrasaría el aviso sin agregar información.
  void sendNewOrderNotification(order);

  // Guía automática (Fase 8.5), mismo disparo fire-and-forget y misma razón: crear la guía
  // contra Skydropx puede tardar y no debe bloquear el 200 del webhook. Solo llega aquí UNA
  // vez por orden gracias al guard atómico de arriba (`affected === 1`), que ya sirve de
  // primera línea de defensa contra doble guía (dinero real, ver roadmap-skydropx.md §8);
  // `createShipmentForOrder` añade su propio guard (ver abajo) como segunda línea, por si en
  // el futuro se agrega otro punto de entrada (p. ej. un reintento manual/automático).
  void createShipmentForOrder(order);
}

/**
 * Valor centinela para reclamar el derecho a crear la guía de una orden ANTES de llamar a
 * Skydropx: a diferencia del correo (donde el guard es la propia transición atómica de
 * `paymentStatus`), aquí el id real de la guía solo se conoce DESPUÉS del `POST /shipments` —
 * que ya cuesta dinero real (roadmap-skydropx.md §8) — así que no se puede escribir el id real
 * como guard de antemano. Se reclama con este centinela primero; si el `UPDATE` no afecta
 * ninguna fila, otra llamada ya está creando (o ya creó) la guía y esta se retira sin llamar a
 * Skydropx.
 *
 * Exportado desde la Fase O.3: el reintento (`retryShipmentForOrder`) y su barrido tienen que
 * distinguir este valor de un id de guía real — uno significa "nadie tiene guía todavía", el
 * otro "ya se pagó una, no generes la segunda".
 */
export const SHIPMENT_CREATION_SENTINEL = "creating";

/**
 * Prefijo del marcador que queda cuando Skydropx **sí creó (y cobró) la guía** pero no se pudo
 * guardar su id (falla de BD justo después del `POST /shipments`). Conserva el id real detrás
 * del prefijo para que un humano pueda reconciliarlo en el panel de Skydropx.
 *
 * Existe desde la Fase O.3 y es lo que hace seguro el reintento: antes, ese caso dejaba el
 * centinela `"creating"` para siempre — indistinguible de un centinela huérfano por un proceso
 * caído — así que un reintento por antigüedad habría pagado una **segunda** guía. Ni el
 * endpoint de reintento ni el barrido tocan una orden marcada así.
 */
const UNRECONCILED_PREFIX = "unreconciled:";

/**
 * id "desconocido" del marcador anterior, para el caso en que **ni siquiera se sabe** si la guía
 * se creó: el `POST /shipments` se fue sin respuesta concluyente (timeout, conexión cortada, 5xx —
 * ver `SkydropxShipmentUncertainError`). Skydropx pudo haberla creado y cobrado sin que nosotros
 * viéramos nunca su id.
 *
 * Se marca igual que el caso "cobrada sin persistir" porque la regla es la misma —ningún reintento
 * automático la toca, para no pagar una segunda— pero con dos diferencias: el mensaje no puede dar
 * un id que buscar (solo el pedido, la paquetería y la fecha), y es el único marcador que el dueño
 * puede **forzar** desde el panel (`force: true`) una vez que confirmó en Skydropx que no existe
 * ninguna guía. Sin esa salida el pedido quedaría atorado para siempre, que es justo lo que esta
 * fase vino a eliminar.
 */
const UNKNOWN_SHIPMENT_ID = "desconocido";

/** Marcador completo de "quizá se creó, no sabemos su id". */
const UNCERTAIN_SHIPMENT_MARKER = `${UNRECONCILED_PREFIX}${UNKNOWN_SHIPMENT_ID}`;

/**
 * id real de la guía si el valor guardado es el marcador de "cobrada sin persistir"; `null` si
 * es un id normal, el centinela o nada.
 */
export function unreconciledShipmentId(value: string | null): string | null {
  return value?.startsWith(UNRECONCILED_PREFIX)
    ? value.slice(UNRECONCILED_PREFIX.length)
    : null;
}

/** `true` si el valor guardado es un id de guía real (ni centinela ni marcador de conflicto). */
function isRealShipmentId(value: string | null): value is string {
  return (
    value != null &&
    value !== SHIPMENT_CREATION_SENTINEL &&
    unreconciledShipmentId(value) === null
  );
}

/** Reintentos (y espera entre ellos) para guardar el id de una guía ya creada y cobrada. */
const SHIPMENT_PERSIST_ATTEMPTS = 3;
const SHIPMENT_PERSIST_RETRY_DELAY_MS = 1_000;

/**
 * Resultado de guardar el id de una guía ya cobrada:
 *  - `saved`      → persistido.
 *  - `claim-lost` → el `UPDATE` corrió pero no afectó ninguna fila: el centinela ya no es nuestro
 *                   (se liberó por antigüedad y otro intento lo reclamó, o se marcó de otra forma).
 *  - `db-error`   → los tres intentos fallaron contra la BD.
 */
type PersistShipmentIdResult = "saved" | "claim-lost" | "db-error";

/**
 * Guarda el id de una guía **ya creada y cobrada** en Skydropx, reintentando ante un fallo de
 * BD. Vale la pena insistir aquí y en ningún otro punto de esta función: perder este `UPDATE`
 * es el único fallo que cuesta dinero (deja la guía pagada sin rastro en el pedido), y la causa
 * típica es transitoria (pool agotado, conexión reciclada), no una BD caída de verdad.
 *
 * El `WHERE` exige que el centinela **siga siendo nuestro**, igual que el resto de escrituras de
 * este flujo (reclamar/liberar/marcar). Sin esa condición, una creación lenta cuyo centinela ya se
 * liberó por huérfano podía pisar en su intento 2 o 3 lo que un intento más nuevo hubiera escrito
 * — otro id de guía real, o un marcador `unreconciled:` — borrando en silencio justo el dato que
 * un humano necesita para reconciliar.
 */
async function persistShipmentId(
  orderId: number,
  shipmentId: string,
): Promise<PersistShipmentIdResult> {
  for (let attempt = 1; attempt <= SHIPMENT_PERSIST_ATTEMPTS; attempt++) {
    try {
      const [saved] = await Order.update(
        { skydropxShipmentId: shipmentId, shipmentClaimedAt: null },
        { where: { id: orderId, skydropxShipmentId: SHIPMENT_CREATION_SENTINEL } },
      );
      return saved === 1 ? "saved" : "claim-lost";
    } catch (err) {
      logger.warn(
        { orderId, skydropxShipmentId: shipmentId, attempt, err },
        "[skydropx] no se pudo guardar el id de la guía recién creada; reintentando",
      );
      if (attempt < SHIPMENT_PERSIST_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, SHIPMENT_PERSIST_RETRY_DELAY_MS),
        );
      }
    }
  }
  return "db-error";
}

const STORE_COMPANY_NAME = "Botas Don Chuy Outlet";

/** Opciones de `createShipmentForOrder`. */
export interface CreateShipmentOptions {
  /**
   * Manda el correo de alerta operativa cuando la creación falla **sin haber cobrado nada**.
   * Por defecto `true` (el camino automático del webhook: nadie más se va a enterar). El
   * reintento manual y el barrido lo apagan porque tienen su propio canal — el endpoint
   * responde el error al dueño en el momento, y el barrido alerta una sola vez al agotar sus
   * intentos, en vez de un correo por ciclo. El caso "guía cobrada sin persistir" alerta
   * SIEMPRE, sin importar esta bandera: ahí ya hay dinero de por medio.
   */
  notifyOnFailure?: boolean;
}

/**
 * Genera la guía de envío de una orden ya pagada contra Skydropx (Fase 8.5). Idempotente
 * (guard con centinela, ver `SHIPMENT_CREATION_SENTINEL`), tolerante a fallos (nunca lanza —
 * llamada fire-and-forget desde `markOrderPaidFromWebhook`) y tolerante a que la orden no
 * tenga cotización de Skydropx (cayó al fallback de tarifa plana en el checkout): en ese caso
 * no hay `rate_id` que convertir en guía, así que se omite y el dueño la genera manualmente.
 *
 * Si el `rateId` guardado ya no está disponible (cotización vencida — vigentes 24h — o el
 * proceso se reinició y perdió la memoria de direcciones de `getQuotationRate`), se re-cotiza
 * desde cero para poder generar la guía de todos modos. El monto ya cobrado al cliente
 * (`order.shipping`/`order.total`) NUNCA cambia por esto — la re-cotización solo sirve para
 * obtener un `rate_id` vigente con el que crear el envío físico.
 */
export async function createShipmentForOrder(
  order: Order,
  { notifyOnFailure = true }: CreateShipmentOptions = {},
): Promise<void> {
  if (!order.skydropxQuotationId || !order.skydropxRateId) {
    logger.warn(
      { orderId: order.id },
      "[skydropx] orden sin cotización de Skydropx (tarifa plana de respaldo); no se genera guía automática",
    );
    return;
  }

  // El claim va en su propio try/catch (en vez de vivir fuera de cualquier try, como antes):
  // esta función se dispara fire-and-forget (`void createShipmentForOrder(order)`) y no hay
  // ningún handler global de `unhandledRejection` en el proceso, así que un fallo de DB acá
  // (pool agotado, conexión caída) no debe convertirse en una promesa rechazada sin capturar
  // que tumbe todo el servidor por una orden.
  let claimed = 0;
  try {
    [claimed] = await Order.update(
      // `shipmentClaimedAt` es el reloj del centinela: con él se decide más tarde si quedó
      // huérfano. Va aquí (y no se apoya en `updatedAt`) porque cualquier otra escritura sobre el
      // pedido bumpea `updatedAt` y reiniciaría la cuenta — ver el comentario de la columna.
      { skydropxShipmentId: SHIPMENT_CREATION_SENTINEL, shipmentClaimedAt: new Date() },
      { where: { id: order.id, skydropxShipmentId: null } },
    );
  } catch (err) {
    logger.error(
      { orderId: order.id, err },
      "[skydropx] no se pudo reclamar la creación de guía",
    );
    Sentry.captureException(err, { extra: { orderId: order.id } });
    return; // no se llamó a Skydropx todavía; nada que reconciliar
  }
  if (claimed === 0) return; // otra llamada ya está creando (o ya creó) la guía de esta orden

  // Si `createShipment` llega a completarse, esto guarda su id ANTES de intentar persistirlo:
  // el `catch` de abajo lo usa para distinguir "no se llegó a crear nada en Skydropx" (seguro
  // liberar el centinela) de "sí se creó y cobró, solo falló guardarlo" (NUNCA liberarlo, o un
  // reintento futuro pagaría una segunda guía para la misma orden).
  let createdShipmentId: string | null = null;

  try {
    const destinationAddress = toSkydropxAddress({
      postalCode: order.postalCode,
      state: order.state,
      city: order.city,
      neighborhood: order.neighborhood,
    });

    let rateId = order.skydropxRateId;
    // Cuántos bultos declarar en la guía. Sale de la columna congelada en el checkout; `null`
    // (tarifa plana o pedido anterior a la Fase N.6) se lee como el único bulto que esos
    // pedidos cotizaron. Si hay que re-cotizar, más abajo lo reemplaza el conteo fresco.
    let packageCount = order.packageCount ?? 1;
    const currentRate = await getQuotationRate(
      order.skydropxQuotationId,
      order.skydropxRateId,
      destinationAddress,
    );
    if (!currentRate) {
      logger.warn(
        { orderId: order.id },
        "[skydropx] cotización vencida; re-cotizando para poder generar la guía",
      );
      const items = await OrderItem.findAll({ where: { orderId: order.id } });
      const products = await Product.findAll({
        where: { id: { [Op.in]: items.map((item) => item.productId) } },
      });
      const productsById = new Map(products.map((p) => [p.id, p]));
      const parcelItems: ParcelLineItem[] = items.map((item) => {
        const product = productsById.get(item.productId);
        if (!product) {
          throw new Error(
            `El producto ${item.productId} de la orden #${order.id} ya no existe; no se puede re-cotizar el envío.`,
          );
        }
        return {
          product: {
            type: product.type,
            weightKg: product.weightKg,
            lengthCm: product.lengthCm,
            widthCm: product.widthCm,
            heightCm: product.heightCm,
          },
          quantity: item.quantity,
        };
      });
      const parcels = buildParcels(parcelItems);
      const requoted = await getShippingRates(getOriginAddress(), destinationAddress, parcels);
      const matched =
        requoted.rates.find((r) => r.carrier === order.shippingCarrier) ?? requoted.rates[0];
      if (!matched) {
        throw new Error(
          `No se pudo re-cotizar el envío de la orden #${order.id}: Skydropx no devolvió tarifas utilizables.`,
        );
      }
      rateId = matched.rateId;
      // El acomodo se rehace con las dimensiones ACTUALES del catálogo, así que puede dar un
      // número de bultos distinto al del checkout. Manda el nuevo: es el que ampara el rate con
      // el que se va a crear la guía. `order.shipping`/`order.total` siguen sin tocarse — ya se
      // cobraron.
      packageCount = matched.packageCount;
      await Order.update(
        {
          skydropxQuotationId: requoted.quotationId,
          skydropxRateId: matched.rateId,
          packageCount: matched.packageCount,
        },
        { where: { id: order.id } },
      );
    }

    const addressFrom: SkydropxContact = {
      name: SHIP_FROM_NAME,
      street1: `${SHIP_FROM_STREET} ${SHIP_FROM_EXTERNAL_NUMBER}`,
      company: STORE_COMPANY_NAME,
      phone: SHIP_FROM_PHONE,
      email: EMAIL_FROM,
      reference: SHIP_FROM_NEIGHBORHOOD,
    };
    const addressTo: SkydropxContact = {
      name: order.customerName,
      street1: order.street,
      company: "N/A",
      phone: order.customerPhone,
      email: order.customerEmail,
      reference: order.neighborhood,
    };

    const { shipmentId } = await createShipment(
      rateId,
      addressFrom,
      addressTo,
      packageCount,
    );
    createdShipmentId = shipmentId; // a partir de aquí, Skydropx ya cobró la guía

    const persisted = await persistShipmentId(order.id, shipmentId);
    if (persisted === "claim-lost") {
      // El centinela ya no es nuestro: otra ejecución lo reclamó (típicamente porque esta creación
      // tardó tanto que su centinela se liberó por huérfano). NO se escribe nada — pisar la fila
      // borraría el id o el marcador del dueño actual. La guía ya está cobrada, así que esto
      // necesita a un humano sí o sí.
      logger.error(
        { orderId: order.id, skydropxShipmentId: shipmentId },
        "[skydropx] CRÍTICO: guía cobrada pero otro intento se quedó con el turno; posible guía duplicada",
      );
      Sentry.captureException(
        new Error("Guía Skydropx cobrada sin poder persistirse: centinela perdido"),
        { level: "fatal", extra: { orderId: order.id, skydropxShipmentId: shipmentId } },
      );
      void sendAlertEmail({
        subject: `CRÍTICO: guía Skydropx cobrada sin guardar — orden #${order.id}`,
        context: {
          orderId: order.id,
          skydropxShipmentId: shipmentId,
          motivo:
            "Otro intento reclamó la creación de la guía mientras esta se completaba. Revisa en el panel de Skydropx si el pedido terminó con dos guías cobradas.",
        },
      });
      return;
    }
    if (persisted === "db-error") {
      throw new Error(
        `La guía ${shipmentId} de la orden #${order.id} se creó en Skydropx pero no se pudo guardar en la base de datos.`,
      );
    }
  } catch (err) {
    logger.error(
      { orderId: order.id, err },
      "[skydropx] no se pudo generar la guía de envío",
    );
    Sentry.captureException(err, { extra: { orderId: order.id } });

    // Dos situaciones en las que NO se puede liberar el centinela, porque la guía puede existir
    // (y estar cobrada) del lado de Skydropx:
    //
    //  1. `createdShipmentId` → se creó y sabemos su id; solo falló guardarlo.
    //  2. `SkydropxShipmentUncertainError` → el `POST /shipments` se fue sin respuesta
    //     concluyente (timeout de 5s, conexión cortada a media petición, 5xx). Skydropx pudo
    //     haberla procesado y cobrado sin que llegáramos a ver su id. Liberar aquí —que es lo que
    //     se hacía antes, cuando era inofensivo porque nada reintentaba— convertiría el reintento
    //     de la Fase O.3 en una segunda guía pagada, justo el desenlace que toda esta mecánica
    //     existe para impedir. Un 4xx sí libera: ahí Skydropx rechazó la petición explícitamente
    //     (saldo insuficiente, datos mal armados) y no creó nada.
    const uncertain = err instanceof SkydropxShipmentUncertainError;
    if (createdShipmentId || uncertain) {
      // No basta con dejar el centinela tal cual: un `"creating"` viejo se interpreta como
      // huérfano y se libera por antigüedad. Se marca con `UNRECONCILED_PREFIX` + el id real (o
      // `desconocido` cuando ni eso se sabe), que ningún reintento automático toca.
      // Es best-effort por definición: si tampoco se puede escribir, la orden queda en
      // `"creating"` y su liberación por antigüedad es el riesgo residual asumido — por eso la
      // alerta de abajo es incondicional.
      const markerId = createdShipmentId ?? UNKNOWN_SHIPMENT_ID;
      try {
        await Order.update(
          {
            skydropxShipmentId: `${UNRECONCILED_PREFIX}${markerId}`,
            shipmentClaimedAt: null,
          },
          { where: { id: order.id, skydropxShipmentId: SHIPMENT_CREATION_SENTINEL } },
        );
      } catch (markErr) {
        logger.error(
          { orderId: order.id, skydropxShipmentId: markerId, err: markErr },
          "[skydropx] no se pudo marcar la orden como guía-cobrada-sin-persistir",
        );
      }

      logger.error(
        { orderId: order.id, skydropxShipmentId: markerId, uncertain },
        createdShipmentId
          ? "[skydropx] CRÍTICO: guía cobrada pero no persistida — requiere reconciliación manual"
          : "[skydropx] CRÍTICO: no se pudo confirmar si la guía se creó — requiere revisión manual",
      );
      Sentry.captureException(err, {
        level: "fatal",
        extra: { orderId: order.id, skydropxShipmentId: markerId, uncertain },
      });
      // Alerta incondicional (sin umbral): puede haber dinero real ya cobrado, necesita atención
      // humana ya. Ignora `notifyOnFailure` a propósito.
      void sendAlertEmail({
        subject: createdShipmentId
          ? `CRÍTICO: guía Skydropx cobrada sin persistir — orden #${order.id}`
          : `CRÍTICO: no se pudo confirmar la guía Skydropx — orden #${order.id}`,
        context: {
          orderId: order.id,
          skydropxShipmentId: markerId,
          paqueteria: order.shippingCarrier,
          motivo: createdShipmentId
            ? "La guía se creó en Skydropx pero no se pudo guardar su id en el pedido."
            : "Skydropx no respondió al crear la guía, así que pudo haberse creado y cobrado. Búscala en el panel de Skydropx por fecha y paquetería: si NO existe, reintenta desde el panel con la opción de forzar; si existe, captura su número de guía al marcar el pedido como enviado.",
        },
      });
      return;
    }

    // Ningún cargo real ocurrió todavía (el fallo fue antes de o durante `createShipment`):
    // es seguro liberar el centinela para que un reintento posterior (manual o automático, ver
    // roadmap-skydropx.md §8) pueda volver a intentarlo — nunca debe quedar "creating" para
    // siempre por un fallo transitorio (Skydropx caído, saldo insuficiente, etc.). Esta
    // liberación también va en su propio try/catch: si fallara, no debe escapar como una
    // rechazo sin capturar de una función fire-and-forget.
    //
    // Alerta operativa del camino automático (webhook): severidad de advertencia porque, a
    // diferencia del caso de arriba, aún no se cobró nada. Se omite cuando quien llama tiene su
    // propio canal (`notifyOnFailure: false`): el reintento manual le responde el error al dueño
    // en el momento, y el barrido de la Fase O.3 alerta una sola vez al agotar sus intentos en
    // vez de mandar un correo por ciclo.
    if (notifyOnFailure) {
      void sendAlertEmail({
        subject: `Fallo generando guía Skydropx — orden #${order.id}`,
        context: { orderId: order.id, message: (err as Error).message },
      });
    }
    try {
      await Order.update(
        { skydropxShipmentId: null, shipmentClaimedAt: null },
        { where: { id: order.id, skydropxShipmentId: SHIPMENT_CREATION_SENTINEL } },
      );
    } catch (releaseErr) {
      logger.error(
        { orderId: order.id, err: releaseErr },
        "[skydropx] no se pudo liberar el centinela tras el fallo anterior",
      );
      Sentry.captureException(releaseErr, { extra: { orderId: order.id } });
    }
  }
}

/** Momento a partir del cual un centinela reclamado se considera todavía "en vuelo". */
function claimCutoff(): Date {
  return new Date(Date.now() - SHIPMENT_RETRY_DELAY_MINUTES * 60_000);
}

/**
 * Condición de "centinela huérfano": sigue siendo `"creating"` y se reclamó hace más de
 * `SHIPMENT_RETRY_DELAY_MINUTES` — o no tiene `shipmentClaimedAt` en absoluto, que es como quedan
 * las filas anteriores a esa columna (llevan ahí desde antes del deploy, así que son huérfanas por
 * definición).
 *
 * La antigüedad se mide con `shipmentClaimedAt` y **no** con `updatedAt`: este último lo bumpea
 * cualquier otra escritura sobre el pedido (webhook de envío, avance manual de estado, marcado de
 * pago), así que un pedido atorado en `"creating"` cuyo estado editara el dueño desde el panel
 * reiniciaba su reloj en cada edición y no podía liberarse nunca.
 */
function staleSentinelWhere(): WhereOptions {
  const cutoff = claimCutoff();
  return {
    skydropxShipmentId: SHIPMENT_CREATION_SENTINEL,
    [Op.or]: [
      { shipmentClaimedAt: null },
      { shipmentClaimedAt: { [Op.lt]: cutoff } },
    ],
  };
}

/**
 * Libera el centinela **huérfano** de una orden: el `"creating"` que quedó escrito porque el
 * proceso murió entre reclamarlo y terminar la llamada a Skydropx (redeploy, OOM, crash). Sin
 * esto la orden nunca podría volver a generar guía — cualquier intento futuro se retira creyendo
 * que otra llamada la está creando.
 *
 * El `WHERE` exige que siga siendo el centinela **y** que se haya reclamado hace más de
 * `SHIPMENT_RETRY_DELAY_MINUTES`, así que nunca le quita el turno a una creación realmente en
 * vuelo (que se resuelve en segundos) y dos liberaciones concurrentes no pueden ganar las dos.
 * Devuelve `true` solo si esta llamada fue la que lo liberó.
 */
async function releaseOrphanSentinel(orderId: number): Promise<boolean> {
  const [released] = await Order.update(
    { skydropxShipmentId: null, shipmentClaimedAt: null },
    { where: { id: orderId, ...staleSentinelWhere() } },
  );
  if (released === 1) {
    logger.warn(
      { orderId },
      "[skydropx] centinela huérfano liberado: la creación anterior murió sin terminar",
    );
  }
  return released === 1;
}

/**
 * Candidatos del barrido de guías pendientes (Fase O.3): pedidos `paid` con tarifa de Skydropx
 * que siguen sin guía —o con un centinela huérfano— pasado el margen de reintento. Vive aquí
 * (y no en el barrido) porque la condición depende del significado de los centinelas.
 *
 * Ojo con lo que **no** entra: una orden marcada con `UNRECONCILED_PREFIX` (guía ya cobrada,
 * solo no guardada) queda fuera por construcción — el `WHERE` solo acepta `null` o el centinela
 * exacto —, que es justo lo que impide que un reintento pague la segunda guía.
 */
export function pendingShipmentWhere(oldestCreatedAt: Date): WhereOptions {
  return {
    status: "paid",
    // Los dos, no solo el rate: `createShipmentForOrder` exige ambos y se retira sin llamar a
    // Skydropx si falta cualquiera. Una orden con rate pero sin cotización entraría en cada ciclo
    // solo para salirse en la primera línea, gastando los tres intentos y disparando la alerta de
    // "no se pudo generar la guía" sin haber hecho una sola llamada.
    skydropxQuotationId: { [Op.ne]: null },
    skydropxRateId: { [Op.ne]: null },
    createdAt: { [Op.between]: [oldestCreatedAt, claimCutoff()] },
    [Op.or]: [{ skydropxShipmentId: null }, staleSentinelWhere()],
  };
}

/**
 * Desenlace de un intento de guía. Distinguir `in-progress` de `failed` importa: son los dos
 * casos que antes se colapsaban en `null`, y el barrido contaba como fallo (gastando uno de sus
 * tres intentos y acercando la alerta) el caso en que simplemente **otra llamada tenía el turno**
 * — p. ej. un pedido que se paga tarde, cuyo webhook está creando la guía en ese preciso momento.
 */
export type ShipmentAttempt =
  | { outcome: "created"; shipmentId: string }
  /** Otra llamada tiene el centinela: la guía se está creando ahora mismo. No es un fallo. */
  | { outcome: "in-progress" }
  /** Puede existir una guía cobrada; `shipmentId` es `null` cuando ni su id se conoce. */
  | { outcome: "unreconciled"; shipmentId: string | null }
  | { outcome: "failed" };

/**
 * Deja la orden lista para un nuevo intento de guía y lo ejecuta. Es el tronco común del reintento
 * manual (`retryShipmentForOrder`) y del barrido automático: los dos tienen que liberar el
 * centinela huérfano igual y apagar la alerta por intento igual, y sería un error que divergieran.
 */
async function attemptShipment(order: Order): Promise<ShipmentAttempt> {
  if (order.skydropxShipmentId === SHIPMENT_CREATION_SENTINEL) {
    // Sigue en vuelo (o ya la tomó otro): no es un fallo, solo no es nuestro turno.
    if (!(await releaseOrphanSentinel(order.id))) return { outcome: "in-progress" };
  }
  // `notifyOnFailure: false`: quien llama informa por su cuenta (respuesta HTTP o alerta al
  // agotar intentos), en vez de un correo de alerta por cada intento.
  await createShipmentForOrder(order, { notifyOnFailure: false });

  const after = await Order.findByPk(order.id, {
    attributes: ["id", "skydropxShipmentId"],
  });
  const value = after?.skydropxShipmentId ?? null;

  if (isRealShipmentId(value)) return { outcome: "created", shipmentId: value };
  const unreconciled = unreconciledShipmentId(value);
  if (unreconciled) {
    return {
      outcome: "unreconciled",
      shipmentId: unreconciled === UNKNOWN_SHIPMENT_ID ? null : unreconciled,
    };
  }
  // El centinela sigue puesto y no lo pusimos nosotros (`createShipmentForOrder` se retiró con
  // `claimed === 0`): otra llamada está creando la guía en este momento.
  if (value === SHIPMENT_CREATION_SENTINEL) return { outcome: "in-progress" };
  return { outcome: "failed" };
}

/** Opciones de `retryShipmentForOrder`. */
export interface RetryShipmentOptions {
  /**
   * Confirma que el dueño ya revisó el panel de Skydropx y **no existe** ninguna guía, para el
   * único caso en que no se puede saber desde aquí: Skydropx no respondió al crear la guía
   * (marcador `unreconciled:desconocido`). Nunca fuerza nada más — un id de guía real es prueba
   * de que la guía existe y está cobrada, y ahí no hay nada que confirmar.
   */
  force?: boolean;
}

/**
 * Reintento manual de la guía de un pedido desde el panel (Fase O.3,
 * `POST /api/admin/orders/:id/shipment/retry`).
 *
 * Existe porque hasta ahora un fallo de `createShipmentForOrder` terminaba en un correo de
 * alerta y nada más: el pedido quedaba pagado, el cliente esperando y **ninguna ruta** podía
 * volver a intentarlo. Además cierra el bug latente del centinela: si el proceso moría entre
 * reclamar `"creating"` y llamar a Skydropx, ese valor quedaba huérfano en la BD y bloqueaba
 * para siempre cualquier intento posterior.
 *
 * Rechaza con `409` todo lo que no sea "falta la guía y se puede generar" — en especial un
 * pedido que **ya tiene guía real** o una **cobrada sin persistir**: cada guía cuesta dinero,
 * así que la regla es no generar una segunda ante la duda. A diferencia del camino automático
 * (fire-and-forget), aquí se espera el resultado y un fallo responde `502`: el dueño está
 * mirando la respuesta y necesita saber si tiene que insistir o resolverlo a mano.
 */
export async function retryShipmentForOrder(
  orderId: number,
  { force = false }: RetryShipmentOptions = {},
): Promise<Order> {
  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new AppError("No se encontró el pedido cuya guía quieres generar.", 404);
  }
  if (order.status === "cancelled") {
    throw new AppError(
      "Este pedido está cancelado, así que no se le puede generar una guía de envío.",
      409,
    );
  }
  if (order.status === "pending") {
    throw new AppError(
      "Este pedido todavía no está pagado. Espera a que se confirme el pago para generar su guía.",
      409,
    );
  }
  // Un pedido ya marcado como enviado/entregado no lleva guía nueva. El caso real: la guía
  // automática falló, el dueño la generó a mano en el panel de Skydropx y capturó su número con
  // `PATCH /api/admin/orders/:id/status` — eso deja el pedido `shipped` con `skydropxShipmentId`
  // en `null`, así que sin este guard el botón de reintentar generaría (y cobraría) una segunda
  // guía para un pedido que ya salió. El barrido no necesita el guard: solo mira pedidos `paid`.
  if (order.status === "shipped" || order.status === "delivered") {
    throw new AppError(
      `Este pedido ya está marcado como ${
        order.status === "shipped" ? "enviado" : "entregado"
      }, así que no se le genera una guía nueva: cada guía se cobra. Si necesitas reemplazar la guía, genérala en el panel de Skydropx y captura su número al actualizar el estado del pedido.`,
      409,
    );
  }
  if (!order.skydropxQuotationId || !order.skydropxRateId) {
    throw new AppError(
      "Este pedido se cobró con la tarifa plana de respaldo, así que no tiene una tarifa de Skydropx que convertir en guía. Genérala en el panel de Skydropx y captura el número de guía al marcar el pedido como enviado.",
      409,
    );
  }

  const unreconciled = unreconciledShipmentId(order.skydropxShipmentId);
  if (unreconciled && unreconciled !== UNKNOWN_SHIPMENT_ID) {
    throw new AppError(
      `Este pedido ya tiene una guía cobrada en Skydropx (${unreconciled}) que no se alcanzó a guardar. Búscala en el panel de Skydropx y captura su número de guía al marcar el pedido como enviado; generar otra la cobraría dos veces.`,
      409,
    );
  }
  if (unreconciled === UNKNOWN_SHIPMENT_ID) {
    // Skydropx no respondió al crear la guía: pudo haberla creado y cobrado. No se puede decidir
    // por el dueño, pero tampoco dejarlo atorado — con `force` confirma que ya revisó el panel y
    // que no existe ninguna guía. Es la única puerta que abre `force`: un id real nunca se fuerza.
    if (!force) {
      throw new AppError(
        "Skydropx no respondió al generar la guía de este pedido, así que pudo haberse creado y cobrado sin que quedara registrada. Búscala en el panel de Skydropx por fecha y paquetería: si existe, captura su número al marcar el pedido como enviado; si no existe, vuelve a intentarlo confirmando que quieres generarla de todos modos.",
        409,
      );
    }
    const [cleared] = await Order.update(
      { skydropxShipmentId: null, shipmentClaimedAt: null },
      { where: { id: orderId, skydropxShipmentId: UNCERTAIN_SHIPMENT_MARKER } },
    );
    if (cleared === 0) {
      throw new AppError(
        "El pedido cambió mientras se procesaba tu solicitud. Recárgalo y revisa su guía antes de volver a intentarlo.",
        409,
      );
    }
    order.skydropxShipmentId = null;
    logger.warn(
      { orderId },
      "[skydropx] el dueño confirmó que no existe guía y forzó un nuevo intento",
    );
  }
  if (isRealShipmentId(order.skydropxShipmentId)) {
    throw new AppError(
      `Este pedido ya tiene una guía generada en Skydropx (${order.skydropxShipmentId}). Imprímela desde el pedido en vez de generar otra: cada guía se cobra.`,
      409,
    );
  }

  const attempt = await attemptShipment(order);
  switch (attempt.outcome) {
    case "created":
      break;
    // Dos reintentos simultáneos (doble clic en el panel) los serializa el centinela: uno crea la
    // guía y el otro llega aquí. No es un error.
    case "in-progress":
      throw new AppError(
        "La guía de este pedido se está generando en este momento. Espera unos segundos y recarga el pedido para ver el resultado.",
        409,
      );
    case "unreconciled":
      throw new AppError(
        attempt.shipmentId
          ? `La guía se creó y se cobró en Skydropx (${attempt.shipmentId}) pero no se pudo guardar en el pedido. Búscala en el panel de Skydropx: no generes otra.`
          : "Skydropx no respondió al generar la guía, así que pudo haberse creado y cobrado. Búscala en el panel de Skydropx por fecha y paquetería antes de volver a intentarlo: si no existe, reintenta confirmando que quieres generarla de todos modos.",
        502,
      );
    case "failed":
      throw new AppError(
        "No se pudo generar la guía con Skydropx. Revisa el saldo de la cuenta y los datos de envío del pedido, y vuelve a intentarlo.",
        502,
      );
  }

  logger.info(
    { orderId, skydropxShipmentId: attempt.shipmentId },
    "[skydropx] guía regenerada manualmente desde el panel",
  );

  const full = await Order.findByPk(orderId, {
    include: [{ model: OrderItem, as: "items" }],
  });
  return full!;
}

/**
 * Un intento de guía del barrido automático (Fase O.3). Misma mecánica que el reintento manual
 * pero sin traducir el resultado a HTTP: devuelve el id creado o `null`.
 */
export async function retryShipmentFromSweeper(order: Order): Promise<ShipmentAttempt> {
  return attemptShipment(order);
}

/**
 * Link a la página pública de seguimiento (Fase O.4). `undefined` cuando el pedido no tiene token
 * (filas anteriores a la columna): en ese caso el correo simplemente no lleva el botón, en vez de
 * mandar un link roto a una página que respondería 404.
 *
 * La ruta `/pedido/<token>` es la que el frontend registra para esta fase; si cambia allá, cambia
 * aquí — junto con `publicOrderLookupUrl`, son las únicas URLs que este backend construye hacia el
 * front, y por eso viven las dos juntas.
 */
function publicOrderUrl(publicToken: string | null): string | undefined {
  if (!publicToken) return undefined;
  return `${FRONTEND_URL.replace(/\/+$/, "")}/pedido/${publicToken}`;
}

/**
 * La página de consulta sin token: donde el comprador pega el código que ahora lleva el correo.
 * No depende del pedido, así que no puede faltar como `publicOrderUrl`.
 */
function publicOrderLookupUrl(): string {
  return `${FRONTEND_URL.replace(/\/+$/, "")}/pedido`;
}

/**
 * Recarga la orden con sus `items` (sin `unitCost`) y le manda un correo con el mismo
 * `orderConfirmationTemplate`. Aislado y con try/catch propio para poder dispararse en segundo
 * plano (fire-and-forget) desde los webhooks sin bloquear su respuesta ni propagar errores.
 * `sendEmail` ya "loguea pero no lanza"; el try/catch cubre además la recarga.
 *
 * El template renderiza el bloque de rastreo cuando recibe `tracking` (correo "pedido enviado",
 * Fase 8.6) y el placeholder "estamos preparando tu envío" cuando no (correo de confirmación,
 * Fase 9.3) — de ahí que `sendOrderConfirmationEmail`/`sendShipmentEmail` compartan este helper.
 */
async function sendOrderEmail(
  order: Order,
  opts: {
    subject: string;
    idempotencyKey: string;
    tracking?: { number: string; url?: string; carrier?: string };
  },
): Promise<void> {
  try {
    await order.reload({
      include: [
        { model: OrderItem, as: "items", attributes: { exclude: ["unitCost"] } },
      ],
    });
    await sendEmail({
      to: order.customerEmail,
      subject: opts.subject,
      html: orderConfirmationTemplate({
        createdAt: order.createdAt,
        customerName: order.customerName,
        items: (order.items ?? []).map((it) => ({
          nameSnapshot: it.nameSnapshot,
          size: it.size,
          quantity: it.quantity,
          unitSalePrice: it.unitSalePrice,
          unitOriginalPrice: it.unitOriginalPrice,
        })),
        subtotal: order.subtotal,
        savings: order.savings,
        shipping: order.shipping,
        // Los dos correos (confirmación y "va en camino") comparten este helper, así que el
        // cupón se ve en el que el comprador conserve, que es impredecible.
        couponCode: order.couponCode,
        couponDiscount: order.couponDiscount,
        total: order.total,
        shippingAddress: {
          street: order.street,
          neighborhood: order.neighborhood,
          city: order.city,
          state: order.state,
          postalCode: order.postalCode,
          references: order.references,
        },
        shippingCarrier: order.shippingCarrier,
        tracking: opts.tracking,
        trackingPageUrl: publicOrderUrl(order.publicToken),
        // El token también va suelto: el botón sirve para el clic, pero la página de consulta pide
        // el código y dentro de un `href` no hay forma de copiarlo.
        trackingCode: order.publicToken,
        trackingLookupUrl: publicOrderLookupUrl(),
      }),
      idempotencyKey: opts.idempotencyKey,
    });
  } catch (err) {
    // Sin sendAlertEmail aquí: es un problema tolerado por diseño (ver CLAUDE.md) y, si Resend
    // está caído, alertar por el mismo canal caería en el mismo bucle que se evita en alert.service.ts.
    logger.error({ orderId: order.id, err }, "[email] no se pudo enviar el correo del pedido");
    Sentry.captureException(err, { extra: { orderId: order.id } });
  }
}

/**
 * Correo de confirmación de pago (Fase 9.3), sin datos de rastreo.
 *
 * El asunto no lleva el número de pedido por el mismo motivo que el cuerpo (ver `introBody` en
 * `orderConfirmation.ts`): `Order.id` es un consecutivo de la tienda, no del comprador. La
 * `idempotencyKey` sí lo conserva — es interna de Resend, no la ve el cliente, y es la garantía de
 * "un correo por pedido".
 */
function sendOrderConfirmationEmail(order: Order): Promise<void> {
  return sendOrderEmail(order, {
    subject: "Confirmación de tu pedido — Botas Don Chuy Outlet",
    idempotencyKey: `order-confirmation/${order.id}`,
  });
}

/**
 * Correo "tu pedido va en camino" (Fase 8.6), con el número de guía ya disponible.
 * Exportado porque el avance manual de estado (`updateOrderStatusByAdmin`, Fase O.1) manda
 * exactamente el mismo correo cuando el dueño captura la guía a mano: los dos caminos
 * (webhook de Skydropx y panel) comparten template, asunto e `idempotencyKey`, así que el
 * correo sale una sola vez por pedido sin importar cuál de los dos lo dispare.
 */
export function sendShipmentEmail(
  order: Order,
  tracking: { number: string; url?: string; carrier?: string },
): Promise<void> {
  return sendOrderEmail(order, {
    subject: "Tu pedido va en camino — Botas Don Chuy Outlet",
    idempotencyKey: `order-shipped/${order.id}`,
    tracking,
  });
}

/**
 * Rango de avance del `status` de una orden para aplicar las actualizaciones del webhook de
 * Skydropx SOLO hacia adelante: un evento tardío o fuera de orden (p. ej. un `in_transit` que
 * llega después de un `delivered`) nunca debe retroceder la orden. Una orden `cancelled` no se
 * reactiva desde este webhook (no está en el rango, así que queda excluida del avance).
 *
 * Exportado (junto con `statusesBelow`) porque el avance manual desde el panel
 * (`updateOrderStatusByAdmin`, Fase O.1) usa exactamente el mismo rango: si el dueño y un
 * webhook tardío se pelean por el estado del mismo pedido, la regla "solo hacia adelante" tiene
 * que ser la misma en los dos caminos o el ganador dependería de quién escribió al último.
 */
export const ORDER_STATUS_RANK: Record<string, number> = {
  pending: 0,
  paid: 1,
  shipped: 2,
  delivered: 3,
};

/**
 * Mapea el `status` del paquete de Skydropx al `status` destino de la orden, o `null` si el evento
 * no representa un avance con actividad real de rastreo. Un status ausente/vacío NO avanza la orden:
 * sin evidencia de rastreo no hay por qué marcarla `shipped` (la creación de la guía es asíncrona y
 * puede emitir un primer evento sin estado). `delivered` → `delivered`; cualquier otro estado con
 * actividad → `shipped`. El estado crudo de Skydropx se guarda íntegro en `Order.shipmentStatus`,
 * así que este mapeo grueso no pierde información.
 */
function targetOrderStatus(packageStatus: string | null): "shipped" | "delivered" | null {
  if (!packageStatus) return null; // sin status no hay actividad que reportar: no avanzar
  return packageStatus.toLowerCase() === "delivered" ? "delivered" : "shipped";
}

/**
 * Status estrictamente por debajo de `target` en `ORDER_STATUS_RANK`: los únicos desde los que el
 * avance solo-hacia-adelante puede saltar a `target`. Se usa como `WHERE status IN (...)` para que
 * el avance sea atómico a nivel de BD — dos eventos concurrentes/fuera de orden no pueden retroceder
 * la orden. `cancelled` no está en el rango, así que nunca aparece aquí (no se reactiva).
 */
export function statusesBelow(target: "shipped" | "delivered"): string[] {
  const targetRank = ORDER_STATUS_RANK[target];
  return Object.keys(ORDER_STATUS_RANK).filter((s) => ORDER_STATUS_RANK[s] < targetRank);
}

/**
 * Normaliza una cadena que puede venir en blanco: `""` o solo espacios → `null`; en otro caso, la
 * cadena recortada. Skydropx puede mandar un campo presente pero vacío, y un truthy check trataría
 * `""` como ausente pero `"   "` (solo espacios) como presente — normalizar aquí evita que un
 * tracking en blanco dispare el correo o se persista como valor "real".
 */
function blankToNull(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resultado de procesar un evento del webhook de Skydropx:
 *  - `applied`     → se encontró la orden y se actualizó.
 *  - `retry-later` → no hay orden para ese envío todavía, pero alguna guía está en creación
 *                    (centinela `"creating"`); el evento puede ser para ella una vez persistido su
 *                    id real, así que se le pide a Skydropx que reintente (el controlador responde 503).
 *  - `unknown`     → no hay orden ni guía en creación: envío ajeno, se descarta con 200.
 */
export type ShipmentWebhookResult = "applied" | "retry-later" | "unknown";

/** Evento de paquete de Skydropx ya extraído del payload del webhook (ver `skydropxWebhook`). */
export interface SkydropxPackageEvent {
  shipmentId: string;
  status: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
}

/**
 * Aplica a la orden un evento de paquete ya verificado del webhook de Skydropx (Fase 8.6).
 * Tolerante a "orden no encontrada" (loguea y retorna, nunca lanza) para que un evento verificado
 * siempre responda 200 y Skydropx no reintente en bucle por un envío ajeno.
 *
 * La creación de la guía es asíncrona (ver `createShipmentForOrder`): `POST /shipments` no
 * devuelve `tracking_number`/`label_url`, así que este webhook es el PRIMER punto que los recibe.
 * Puebla `trackingNumber`/`trackingUrl`/`labelUrl`/`shipmentStatus`, avanza `Order.status`
 * (`shipped`/`delivered`, solo hacia adelante) y dispara el correo "pedido enviado" exactamente
 * una vez —la primera vez que llega un `tracking_number`— con un guard atómico
 * `WHERE trackingNumber IS NULL` (mismo patrón que el correo de confirmación): serializa a nivel
 * de BD para no reenviar en los eventos de actualización posteriores (`in_transit`, `delivered`).
 */
export async function applyShipmentUpdateFromWebhook(
  event: SkydropxPackageEvent,
): Promise<ShipmentWebhookResult> {
  // Normaliza los campos del evento: `""`/solo-espacios → `null` (ver `blankToNull`), así un
  // tracking en blanco no dispara el correo ni se persiste como valor "real".
  const status = blankToNull(event.status);
  const trackingNumber = blankToNull(event.trackingNumber);
  const trackingUrl = blankToNull(event.trackingUrl);
  const labelUrl = blankToNull(event.labelUrl);

  // Se busca también por el marcador de "guía cobrada sin persistir": ese evento es justo la
  // prueba de que la guía existe y de cuál es su id, así que se aprovecha para sanar la fila
  // (más abajo) en vez de dejarla esperando una reconciliación manual.
  const order = await Order.findOne({
    where: {
      skydropxShipmentId: {
        [Op.in]: [event.shipmentId, `${UNRECONCILED_PREFIX}${event.shipmentId}`],
      },
    },
  });
  if (!order) {
    // La guía puede existir ya en Skydropx pero aún no estar persistida: `createShipmentForOrder`
    // marca la fila con el centinela `"creating"` ANTES del `POST /shipments` y solo escribe el id
    // real al volver. Si un webhook llega en esa ventana, todavía no hay fila que encontrar por el
    // `skydropxShipmentId` real. En vez de descartarlo (perdiéndolo para siempre), se le pide a
    // Skydropx que reintente: cuando reintente, el id real ya estará persistido y el evento
    // encontrará su orden. Solo se pide reintento si HAY una guía en creación; un envío realmente
    // ajeno se descarta con 200 para no entrar en bucle de reintentos.
    //
    // "En creación" se acota a los centinelas reclamados hace menos de `SHIPMENT_RETRY_DELAY_MINUTES`:
    // un centinela viejo NO es una creación en vuelo (por eso el barrido lo libera por huérfano) y
    // contarlo hacía que cualquier evento de una guía ajena —p. ej. las que el dueño genera a mano
    // en el panel de Skydropx, que es justo lo que los mensajes de esta fase le piden hacer— se
    // respondiera 503 y Skydropx la reintentara en bucle mientras esa fila rancia existiera.
    const pendingCreation = await Order.count({
      where: {
        skydropxShipmentId: SHIPMENT_CREATION_SENTINEL,
        shipmentClaimedAt: { [Op.gte]: claimCutoff() },
      },
    });
    if (pendingCreation > 0) {
      logger.warn(
        { skydropxShipmentId: event.shipmentId, event: "packages" },
        "[skydropx] webhook de paquete llegó mientras una guía se está creando; se pedirá reintento",
      );
      return "retry-later";
    }
    logger.warn(
      { skydropxShipmentId: event.shipmentId, event: "packages" },
      "[skydropx] webhook de paquete sin orden asociada",
    );
    return "unknown";
  }

  // Campos "último gana": estado crudo + urls. Se escriben en todo evento. Los `*Url` solo cuando
  // vienen no nulos, para que un evento posterior que los omita no borre lo que uno anterior fijó.
  const fieldUpdates: {
    shipmentStatus: string | null;
    trackingUrl?: string;
    labelUrl?: string;
    skydropxShipmentId?: string;
  } = { shipmentStatus: status };
  if (trackingUrl) fieldUpdates.trackingUrl = trackingUrl;
  if (labelUrl) fieldUpdates.labelUrl = labelUrl;
  if (unreconciledShipmentId(order.skydropxShipmentId)) {
    // Sanado: el id real reemplaza al marcador, así la orden vuelve al camino normal (los
    // siguientes eventos la encuentran por id directo) y deja de pedir intervención humana.
    fieldUpdates.skydropxShipmentId = event.shipmentId;
    logger.warn(
      { orderId: order.id, skydropxShipmentId: event.shipmentId },
      "[skydropx] guía cobrada sin persistir reconciliada por su webhook",
    );
  }

  // Avance de `status` SOLO hacia adelante y atómico a nivel de BD: el objetivo se decide por el
  // `status` del paquete, pero el `WHERE status IN (<rangos por debajo>)` deja que la BD serialice
  // el cambio, así dos eventos concurrentes o fuera de orden no pueden retroceder la orden (p. ej.
  // un `in_transit` tardío tras un `delivered` no afecta ninguna fila). Va en su propio UPDATE (no
  // dentro de `fieldUpdates`) porque su condición de guarda es distinta: `fieldUpdates` es
  // "último gana" y el status es "solo hacia adelante".
  const target = targetOrderStatus(status);
  if (target) {
    await Order.update(
      { status: target },
      { where: { id: order.id, status: { [Op.in]: statusesBelow(target) } } },
    );
  }

  // Guard atómico del correo "pedido enviado": solo la PRIMERA vez que llega un número de guía se
  // reclama con `WHERE trackingNumber IS NULL` y se dispara el correo. El intento se omite cuando el
  // snapshot ya muestra un `trackingNumber` (caso común de los eventos de actualización posteriores),
  // ahorrando un UPDATE no-op seguido de su fallback; el `WHERE trackingNumber IS NULL` sigue
  // serializando el caso de dos primeros eventos concurrentes.
  let shipmentEmailClaimed = false;
  if (trackingNumber && order.trackingNumber == null) {
    const [claimed] = await Order.update(
      { ...fieldUpdates, trackingNumber },
      { where: { id: order.id, trackingNumber: null } },
    );
    shipmentEmailClaimed = claimed === 1;
    if (!shipmentEmailClaimed) {
      // Otra ejecución concurrente ya reclamó el trackingNumber: solo persistir estado/urls.
      await Order.update(fieldUpdates, { where: { id: order.id } });
    }
  } else {
    // Sin número de guía nuevo (o ya estaba): solo actualizar estado/urls, sin re-disparar el correo.
    await Order.update(fieldUpdates, { where: { id: order.id } });
  }

  if (shipmentEmailClaimed) {
    // Fire-and-forget, misma razón que en los demás correos: no debe bloquear el 200 del webhook.
    void sendShipmentEmail(order, {
      number: trackingNumber!,
      url: trackingUrl ?? undefined,
      carrier: order.shippingCarrier ?? undefined,
    });
  }

  return "applied";
}

/**
 * Marca una orden como pago fallido. Deja `status: "pending"` a propósito: un
 * `payment_intent.payment_failed` suele ser un rechazo transitorio que el cliente
 * reintenta con el MISMO PaymentIntent, así que no se libera el stock aquí; si la
 * orden sigue sin pagarse, el barrido de órdenes vencidas hará el restock tras el
 * TTL. Idempotente y tolerante a orden inexistente.
 */
export async function markOrderPaymentFailed(
  paymentIntentId: string,
): Promise<void> {
  const order = await Order.findOne({ where: { paymentIntentId } });
  if (!order) {
    logger.warn(
      { paymentIntentId, event: "payment_intent.payment_failed" },
      "[stripe] payment_intent.payment_failed sin orden asociada",
    );
    return;
  }
  if (order.paymentStatus === "paid") return; // ya pagada: ignorar un failed tardío
  await order.update({ paymentStatus: "failed" });
}
