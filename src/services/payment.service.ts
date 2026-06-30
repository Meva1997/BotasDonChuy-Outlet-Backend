import { Order } from "../models/Order";
import { AppError } from "../middlewares/AppError";

/**
 * Seam de pagos — listo para Stripe, hoy inerte.
 *
 * El paquete `stripe` NO está instalado todavía (es tarea de Fase 8). Estas dos
 * funciones definen el contrato que el resto del backend usa, de modo que
 * activar Stripe sea solo rellenar el cuerpo:
 *
 *   import Stripe from "stripe";
 *   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
 *
 * En `createPaymentIntentForOrder`:
 *   const intent = await stripe.paymentIntents.create({
 *     amount: Math.round(order.total * 100), // centavos
 *     currency: "mxn",
 *     metadata: { orderId: String(order.id) },
 *   });
 *   return { clientSecret: intent.client_secret, paymentIntentId: intent.id };
 *
 * Y el webhook (ver webhook.routes.ts) verificará la firma con
 * `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` antes de
 * llamar a `markOrderPaidFromWebhook`.
 */

export interface PaymentIntentResult {
  clientSecret: string | null;
  paymentIntentId: string | null;
}

/**
 * Crea (o simula) el PaymentIntent de una orden recién creada.
 * Hoy devuelve nulls: la orden queda en `pending`/`unpaid` sin cobro real.
 */
export async function createPaymentIntentForOrder(
  _order: Order,
): Promise<PaymentIntentResult> {
  // TODO Fase 8: crear el PaymentIntent real con Stripe (ver cabecera).
  return { clientSecret: null, paymentIntentId: null };
}

/**
 * Marca una orden como pagada a partir de un evento de webhook.
 * Idempotente: si ya estaba pagada no hace nada.
 */
export async function markOrderPaidFromWebhook(
  paymentIntentId: string,
): Promise<void> {
  const order = await Order.findOne({ where: { paymentIntentId } });
  if (!order) {
    throw new AppError("Orden no encontrada para el pago recibido", 404);
  }
  if (order.paymentStatus === "paid") return;
  await order.update({ status: "paid", paymentStatus: "paid" });
}
