import { Order } from "../models/Order";
import { stripe, STRIPE_CURRENCY } from "../config/stripe";

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
  if (order.paymentStatus === "paid") return;
  await order.update({ status: "paid", paymentStatus: "paid" });
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
