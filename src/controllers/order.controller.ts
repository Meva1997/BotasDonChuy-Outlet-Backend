import type { Request, RequestHandler, Response } from "express";
import Stripe from "stripe";
import { asyncHandler } from "../middlewares/asyncHandler";
import { createOrderSchema } from "../schemas/checkout";
import * as ordersService from "../services/orders.service";
import * as paymentService from "../services/payment.service";
import { stripe, STRIPE_WEBHOOK_SECRET } from "../config/stripe";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";

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
 * POST /api/webhooks/stripe — webhook de pagos de Stripe.
 *
 * La ruta se monta con `express.raw({ type: "application/json" })` (antes del
 * `express.json()` global), así que `req.body` es el `Buffer` crudo que exige
 * `constructEvent` para verificar la firma `Stripe-Signature`. Una firma inválida
 * responde 400 (Stripe no lo cuenta como entregado); cualquier evento verificado
 * responde 200 aunque no lo manejemos, para no provocar reintentos en bucle.
 *
 * Eventos manejados:
 *  - `payment_intent.succeeded`      → orden `paid`.
 *  - `payment_intent.payment_failed` → orden `failed` (sigue `pending`; el barrido
 *                                      repondrá el stock si se abandona).
 *  - `payment_intent.canceled`       → restock inmediato + orden `cancelled`.
 */
export const stripeWebhook: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
      res.status(400).json({ message: "Falta la firma de Stripe" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.warn(
        `[stripe] firma de webhook inválida: ${(err as Error).message}`,
      );
      res.status(400).json({ message: "Firma de webhook inválida" });
      return;
    }

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await paymentService.markOrderPaidFromWebhook(pi.id);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await paymentService.markOrderPaymentFailed(pi.id);
        break;
      }
      case "payment_intent.canceled": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = Number(pi.metadata?.orderId);
        if (orderId) await ordersService.releaseOrderStock(orderId);
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  },
);

/**
 * GET /api/admin/orders — listado paginado de pedidos (admin).
 * Incluye items congelados con unitCost (a diferencia de las rutas públicas).
 */
export const adminGetOrders: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const perPage = Number(req.query.perPage) || 20;

    // Conteo aparte (sin include) para evitar el conteo inflado de findAndCountAll
    // con asociaciones hasMany; count() sobre Order cuenta pedidos, no filas unidas.
    const total = await Order.count();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const pageClamped = Math.min(Math.max(page, 1), totalPages); // clamp a [1, totalPages]
    const offset = (pageClamped - 1) * perPage;

    // limit + include hasMany: Sequelize aplica subQuery, así que el limit acota
    // pedidos (no filas unidas) y los items se cargan completos.
    const orders = await Order.findAll({
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: perPage,
      offset,
    });

    res.json({ orders, total, page: pageClamped, perPage, totalPages });
  },
);
