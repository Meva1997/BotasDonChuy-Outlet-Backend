import type { Request, RequestHandler, Response } from "express";
import Stripe from "stripe";
import { Op, type WhereOptions } from "sequelize";
import { asyncHandler } from "../middlewares/asyncHandler";
import { createOrderSchema, cancelOrderSchema } from "../schemas/checkout";
import { parseId } from "../utils/parseId";
import * as ordersService from "../services/orders.service";
import * as paymentService from "../services/payment.service";
import { stripe, STRIPE_WEBHOOK_SECRET } from "../config/stripe";
import { verifySkydropxWebhookSignature } from "../services/skydropx.service";
import { Order, type OrderAttributes } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { logger } from "../config/logger";

/** Payload de un evento de paquete del webhook de Skydropx (estilo JSON:API). */
interface SkydropxWebhookBody {
  data?: {
    type?: string;
    attributes?: {
      status?: string | null;
      tracking_number?: string | null;
      tracking_url_provider?: string | null;
      label_url?: string | null;
    };
    relationships?: {
      shipment?: { data?: { id?: string } };
    };
  };
}

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
      logger.warn(
        { err, event: "stripe.signature_verification" },
        "[stripe] firma de webhook inválida",
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
 * POST /api/webhooks/skydropx — webhook de estado de envíos de Skydropx (Fase 8.6).
 *
 * Se monta con `express.raw({ type: "application/json" })` (el mismo mount que el webhook de
 * Stripe, antes del `express.json()` global), así que `req.body` es el `Buffer` crudo que exige
 * la verificación HMAC-SHA512 de la firma del header `Authorization: HMAC <firma>`. Una firma
 * ausente o inválida responde 400 (Skydropx no lo cuenta como entregado); cualquier evento
 * verificado responde 200 aunque no lo manejemos, para no provocar reintentos en bucle.
 *
 * Evento manejado: `packages` — puebla `trackingNumber`/`trackingUrl`/`labelUrl` (la guía se crea
 * async y `POST /shipments` no los devuelve, así que este webhook es el primero que los recibe),
 * avanza `Order.status` (`shipped`/`delivered`) y dispara el correo "pedido enviado" la primera
 * vez que llega un número de guía (ver `applyShipmentUpdateFromWebhook`).
 */
export const skydropxWebhook: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    if (
      !Buffer.isBuffer(rawBody) ||
      !verifySkydropxWebhookSignature(rawBody, req.headers["authorization"])
    ) {
      res.status(400).json({ message: "Firma de webhook inválida" });
      return;
    }

    let event: SkydropxWebhookBody;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as SkydropxWebhookBody;
    } catch {
      res.status(400).json({ message: "Cuerpo de webhook inválido" });
      return;
    }

    const data = event.data;
    if (data?.type === "packages") {
      const shipmentId = data.relationships?.shipment?.data?.id;
      // El id que persistimos en `Order.skydropxShipmentId` es el del envío (`shipments`), que en
      // el payload de un evento `packages` viaja en `relationships.shipment` — no en `data.id`
      // (ese es el id del paquete). Sin `shipmentId` no hay forma de localizar la orden.
      if (shipmentId) {
        const result = await paymentService.applyShipmentUpdateFromWebhook({
          shipmentId,
          status: data.attributes?.status ?? null,
          trackingNumber: data.attributes?.tracking_number ?? null,
          trackingUrl: data.attributes?.tracking_url_provider ?? null,
          labelUrl: data.attributes?.label_url ?? null,
        });
        // La guía referida podría estar creándose justo ahora (centinela "creating" en la orden,
        // su id real aún no persistido): se pide a Skydropx que reintente el evento más tarde, para
        // cuando el id ya esté guardado, en vez de perderlo. Un envío ajeno responde 200 normal.
        if (result === "retry-later") {
          res.status(503).json({ message: "Envío en creación, reintentar más tarde" });
          return;
        }
      }
    }

    res.json({ received: true });
  },
);

/**
 * GET /api/admin/orders — listado paginado de pedidos (admin).
 * Incluye items congelados con unitCost (a diferencia de las rutas públicas).
 * `date` (YYYY-MM-DD, opcional) acota a los pedidos creados ese día UTC.
 */
export const adminGetOrders: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const perPage = Number(req.query.perPage) || 20;
    const date = req.query.date;

    const where = {} as Record<string, unknown>;
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);
      where.createdAt = { [Op.between]: [start, end] };
    }
    const whereOptions = where as WhereOptions<OrderAttributes>;

    // Conteo aparte (sin include) para evitar el conteo inflado de findAndCountAll
    // con asociaciones hasMany; count() sobre Order cuenta pedidos, no filas unidas.
    const total = await Order.count({ where: whereOptions });
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const pageClamped = Math.min(Math.max(page, 1), totalPages); // clamp a [1, totalPages]
    const offset = (pageClamped - 1) * perPage;

    // limit + include hasMany: Sequelize aplica subQuery, así que el limit acota
    // pedidos (no filas unidas) y los items se cargan completos.
    const orders = await Order.findAll({
      where: whereOptions,
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: perPage,
      offset,
    });

    res.json({ orders, total, page: pageClamped, perPage, totalPages });
  },
);

/**
 * POST /api/admin/orders/:id/cancel — cancelación/reembolso manual (admin).
 * Restockea una orden `pending` o reembolsa+restockea una `paid`; 409 si ya está
 * `shipped`/`delivered`/`cancelled`. Ver `cancelOrderByAdmin` en orders.service.ts.
 */
export const adminCancelOrder: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "pedido");
    const { reason } = cancelOrderSchema.parse(req.body ?? {});

    const order = await ordersService.cancelOrderByAdmin(id, reason);

    res.json({ order });
  },
);
