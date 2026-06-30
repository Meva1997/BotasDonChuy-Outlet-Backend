import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler";
import { createOrderSchema } from "../schemas/checkout";
import * as ordersService from "../services/orders.service";
import * as paymentService from "../services/payment.service";

/**
 * POST /api/orders — checkout público.
 * Valida el body, crea la orden (totales recalculados + stock descontado
 * atómicamente) y prepara el pago. Devuelve la orden y el clientSecret (null
 * hasta que Stripe se active en Fase 8).
 */
export const createOrder: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = createOrderSchema.parse(req.body);

    const order = await ordersService.createOrder(input);

    // Seam de pago: hoy no-op (clientSecret null). Si en Fase 8 devuelve un
    // paymentIntentId, se persiste en la orden para que el webhook la concilie.
    const payment = await paymentService.createPaymentIntentForOrder(order);
    if (payment.paymentIntentId) {
      await order.update({
        paymentIntentId: payment.paymentIntentId,
        paymentStatus: "processing",
      });
    }

    res.status(201).json({ order, clientSecret: payment.clientSecret });
  },
);

/**
 * POST /api/webhooks/stripe — stub de webhook de pagos.
 *
 * Fase 8: aquí se verificará la firma del evento con
 * `stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET)`, lo que
 * requiere montar la ruta con `express.raw({ type: "application/json" })` (el
 * cuerpo crudo, antes del `express.json()` global). Por ahora acepta JSON y, si
 * trae un paymentIntentId, marca la orden como pagada.
 */
export const stripeWebhook: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const paymentIntentId =
      req.body?.data?.object?.id ?? req.body?.paymentIntentId;

    if (paymentIntentId) {
      await paymentService.markOrderPaidFromWebhook(String(paymentIntentId));
    }

    res.json({ received: true });
  },
);
