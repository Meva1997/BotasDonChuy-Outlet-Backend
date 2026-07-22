import { Op } from "sequelize";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { Product } from "../models/Product";
import { stripe, STRIPE_CURRENCY } from "../config/stripe";
import {
  SHIP_FROM_EXTERNAL_NUMBER,
  SHIP_FROM_NAME,
  SHIP_FROM_NEIGHBORHOOD,
  SHIP_FROM_PHONE,
  SHIP_FROM_STREET,
} from "../config/skydropx";
import { EMAIL_FROM } from "../config/resend";
import { sendEmail } from "./email.service";
import { orderConfirmationTemplate } from "./email/templates/orderConfirmation";
import { buildParcel, type ParcelLineItem } from "./packing";
import {
  createShipment,
  getOriginAddress,
  getQuotationRate,
  getShippingRates,
  toSkydropxAddress,
  type SkydropxContact,
} from "./skydropx.service";

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
    console.warn(
      `[stripe] payment_intent.succeeded sin orden asociada: ${paymentIntentId}`,
    );
    return;
  }
  // Transición atómica a "paid". El `WHERE paymentStatus != 'paid'` serializa a nivel
  // de BD el webhook y el sweeper (ambos llaman aquí): ante dos ejecuciones concurrentes
  // solo un UPDATE afecta la fila, así que el correo de confirmación se dispara una única
  // vez (el `idempotencyKey` de Resend es un segundo cinturón de seguridad). Un guard en
  // memoria (`if (order.paymentStatus === "paid")`) NO daría esta garantía: dos webhooks
  // podrían leer "processing" antes de que cualquiera escriba y ambos enviarían el correo.
  const [affected] = await Order.update(
    { status: "paid", paymentStatus: "paid" },
    { where: { id: order.id, paymentStatus: { [Op.ne]: "paid" } } },
  );
  if (affected === 0) return; // ya estaba pagada (o perdimos la carrera): no reenviar

  // Fire-and-forget: NO se hace `await`. El correo no debe bloquear la respuesta 200 del
  // webhook — si Resend va lento, Stripe podría exceder su timeout y reintentar el evento
  // en bucle. La orden ya está `paid`; el envío ocurre en segundo plano y su propio
  // try/catch garantiza que un fallo (correo o recarga) nunca propague.
  void sendOrderConfirmationEmail(order);

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
 */
const SHIPMENT_CREATION_SENTINEL = "creating";

const STORE_COMPANY_NAME = "Botas Don Chuy Outlet";

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
export async function createShipmentForOrder(order: Order): Promise<void> {
  if (!order.skydropxQuotationId || !order.skydropxRateId) {
    console.warn(
      `[skydropx] La orden #${order.id} no tiene cotización de Skydropx (tarifa plana de respaldo); no se genera guía automática.`,
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
      { skydropxShipmentId: SHIPMENT_CREATION_SENTINEL },
      { where: { id: order.id, skydropxShipmentId: null } },
    );
  } catch (err) {
    console.error(
      `[skydropx] No se pudo reclamar la creación de guía de la orden #${order.id}:`,
      err,
    );
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
    const currentRate = await getQuotationRate(
      order.skydropxQuotationId,
      order.skydropxRateId,
      destinationAddress,
    );
    if (!currentRate) {
      console.warn(
        `[skydropx] La cotización de la orden #${order.id} ya no está disponible; re-cotizando para poder generar la guía.`,
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
            weightKg: product.weightKg,
            lengthCm: product.lengthCm,
            widthCm: product.widthCm,
            heightCm: product.heightCm,
          },
          quantity: item.quantity,
        };
      });
      const parcel = buildParcel(parcelItems);
      const requoted = await getShippingRates(getOriginAddress(), destinationAddress, parcel);
      const matched =
        requoted.rates.find((r) => r.carrier === order.shippingCarrier) ?? requoted.rates[0];
      if (!matched) {
        throw new Error(
          `No se pudo re-cotizar el envío de la orden #${order.id}: Skydropx no devolvió tarifas utilizables.`,
        );
      }
      rateId = matched.rateId;
      await Order.update(
        { skydropxQuotationId: requoted.quotationId, skydropxRateId: matched.rateId },
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

    const { shipmentId } = await createShipment(rateId, addressFrom, addressTo);
    createdShipmentId = shipmentId; // a partir de aquí, Skydropx ya cobró la guía
    await Order.update({ skydropxShipmentId: shipmentId }, { where: { id: order.id } });
  } catch (err) {
    console.error(`[skydropx] No se pudo generar la guía de envío de la orden #${order.id}:`, err);

    if (createdShipmentId) {
      // Skydropx ya creó (y cobró) la guía, pero no se pudo persistir su id — NO liberar el
      // centinela: hacerlo dejaría la orden como si nunca se hubiera intentado, y un reintento
      // futuro (manual o automático, ver roadmap-skydropx.md §8) generaría una SEGUNDA guía
      // pagada para la misma orden. Se deja "creating" y se loguea con máxima severidad para
      // reconciliación manual (el dueño puede confirmar el id real en el panel de Skydropx).
      console.error(
        `[skydropx] CRÍTICO: la guía ${createdShipmentId} de la orden #${order.id} se creó en Skydropx (dinero real cobrado) pero no se pudo guardar en la base de datos. Requiere reconciliación MANUAL — no reintentar automáticamente, generaría una guía duplicada.`,
      );
      return;
    }

    // Ningún cargo real ocurrió todavía (el fallo fue antes de o durante `createShipment`):
    // es seguro liberar el centinela para que un reintento posterior (manual o automático, ver
    // roadmap-skydropx.md §8) pueda volver a intentarlo — nunca debe quedar "creating" para
    // siempre por un fallo transitorio (Skydropx caído, saldo insuficiente, etc.). Esta
    // liberación también va en su propio try/catch: si fallara, no debe escapar como una
    // rechazo sin capturar de una función fire-and-forget.
    try {
      await Order.update(
        { skydropxShipmentId: null },
        { where: { id: order.id, skydropxShipmentId: SHIPMENT_CREATION_SENTINEL } },
      );
    } catch (releaseErr) {
      console.error(
        `[skydropx] No se pudo liberar el centinela de la orden #${order.id} tras el fallo anterior:`,
        releaseErr,
      );
    }
  }
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
        orderId: order.id,
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
      }),
      idempotencyKey: opts.idempotencyKey,
    });
  } catch (err) {
    console.error("[email] No se pudo enviar el correo del pedido:", err);
  }
}

/** Correo de confirmación de pago (Fase 9.3), sin datos de rastreo. */
function sendOrderConfirmationEmail(order: Order): Promise<void> {
  return sendOrderEmail(order, {
    subject: `Confirmación de tu pedido #${order.id} — Botas Don Chuy Outlet`,
    idempotencyKey: `order-confirmation/${order.id}`,
  });
}

/** Correo "tu pedido va en camino" (Fase 8.6), con el número de guía ya disponible. */
function sendShipmentEmail(
  order: Order,
  tracking: { number: string; url?: string; carrier?: string },
): Promise<void> {
  return sendOrderEmail(order, {
    subject: `Tu pedido #${order.id} va en camino — Botas Don Chuy Outlet`,
    idempotencyKey: `order-shipped/${order.id}`,
    tracking,
  });
}

/**
 * Rango de avance del `status` de una orden para aplicar las actualizaciones del webhook de
 * Skydropx SOLO hacia adelante: un evento tardío o fuera de orden (p. ej. un `in_transit` que
 * llega después de un `delivered`) nunca debe retroceder la orden. Una orden `cancelled` no se
 * reactiva desde este webhook (no está en el rango, así que queda excluida del avance).
 */
const ORDER_STATUS_RANK: Record<string, number> = {
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
function statusesBelow(target: "shipped" | "delivered"): string[] {
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

  const order = await Order.findOne({
    where: { skydropxShipmentId: event.shipmentId },
  });
  if (!order) {
    // La guía puede existir ya en Skydropx pero aún no estar persistida: `createShipmentForOrder`
    // marca la fila con el centinela `"creating"` ANTES del `POST /shipments` y solo escribe el id
    // real al volver. Si un webhook llega en esa ventana, todavía no hay fila que encontrar por el
    // `skydropxShipmentId` real. En vez de descartarlo (perdiéndolo para siempre), se le pide a
    // Skydropx que reintente: cuando reintente, el id real ya estará persistido y el evento
    // encontrará su orden. Solo se pide reintento si HAY una guía en creación; un envío realmente
    // ajeno se descarta con 200 para no entrar en bucle de reintentos.
    const pendingCreation = await Order.count({
      where: { skydropxShipmentId: SHIPMENT_CREATION_SENTINEL },
    });
    if (pendingCreation > 0) {
      console.warn(
        `[skydropx] webhook de paquete para el envío ${event.shipmentId} llegó mientras una guía se está creando; se pedirá reintento.`,
      );
      return "retry-later";
    }
    console.warn(
      `[skydropx] webhook de paquete sin orden asociada (skydropxShipmentId ${event.shipmentId}).`,
    );
    return "unknown";
  }

  // Campos "último gana": estado crudo + urls. Se escriben en todo evento. Los `*Url` solo cuando
  // vienen no nulos, para que un evento posterior que los omita no borre lo que uno anterior fijó.
  const fieldUpdates: {
    shipmentStatus: string | null;
    trackingUrl?: string;
    labelUrl?: string;
  } = { shipmentStatus: status };
  if (trackingUrl) fieldUpdates.trackingUrl = trackingUrl;
  if (labelUrl) fieldUpdates.labelUrl = labelUrl;

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
    console.warn(
      `[stripe] payment_intent.payment_failed sin orden asociada: ${paymentIntentId}`,
    );
    return;
  }
  if (order.paymentStatus === "paid") return; // ya pagada: ignorar un failed tardío
  await order.update({ paymentStatus: "failed" });
}
