import { Op } from "sequelize";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { stripe, STRIPE_CURRENCY } from "../config/stripe";
import { sendEmail } from "./email.service";
import { orderConfirmationTemplate } from "./email/templates/orderConfirmation";

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
