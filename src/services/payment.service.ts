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
 * Recarga la orden con sus `items` (sin `unitCost`) y envía el correo de confirmación.
 * Aislado y con try/catch propio para poder dispararse en segundo plano (fire-and-forget)
 * desde `markOrderPaidFromWebhook` sin bloquear la respuesta del webhook ni propagar
 * errores. `sendEmail` ya "loguea pero no lanza"; el try/catch cubre además la recarga.
 */
async function sendOrderConfirmationEmail(order: Order): Promise<void> {
  try {
    await order.reload({
      include: [
        { model: OrderItem, as: "items", attributes: { exclude: ["unitCost"] } },
      ],
    });
    await sendEmail({
      to: order.customerEmail,
      subject: `Confirmación de tu pedido #${order.id} — Botas Don Chuy Outlet`,
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
      }),
      idempotencyKey: `order-confirmation/${order.id}`,
    });
  } catch (err) {
    console.error(
      "[email] No se pudo enviar la confirmación de pedido:",
      err,
    );
  }
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
