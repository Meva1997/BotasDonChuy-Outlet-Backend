import type { Request, RequestHandler, Response } from "express";
import Stripe from "stripe";
import { Op, type WhereOptions } from "sequelize";
import { asyncHandler } from "../middlewares/asyncHandler";
import {
  createOrderSchema,
  cancelOrderSchema,
  orderStatusUpdateSchema,
  retryShipmentSchema,
} from "../schemas/checkout";
import { parseId } from "../utils/parseId";
import { AppError } from "../middlewares/AppError";
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
 * Lee el header `Idempotency-Key` (Fase O.2). Opcional: cuando no viene, `placeOrder`
 * cae a su huella automática del carrito. Un valor vacío se trata como ausente; uno
 * absurdamente largo se rechaza para no usarlo como llave de un mapa en memoria.
 */
function readIdempotencyKey(req: Request): string | undefined {
  const raw = req.headers["idempotency-key"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return undefined;
  if (value.length > 200) {
    throw new AppError(
      "La clave de idempotencia del pedido es demasiado larga (máximo 200 caracteres).",
      400,
    );
  }
  return value;
}

/**
 * POST /api/orders — checkout público.
 * Valida el body y delega en `placeOrder`: crea la orden (totales recalculados + stock
 * descontado atómicamente), crea el PaymentIntent y devuelve la orden con su
 * `clientSecret`. Es idempotente (Fase O.2): un reenvío dentro de la ventana corta
 * —doble clic, reintento del navegador— devuelve la MISMA respuesta del original en vez
 * de crear un segundo pedido con su segundo cobro y su stock descontado dos veces.
 */
export const createOrder: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = createOrderSchema.parse(req.body);
    const idempotencyKey = readIdempotencyKey(req);

    const { order, clientSecret, replayed } = await ordersService.placeOrder(
      input,
      idempotencyKey,
      // La IP se toma del request y NUNCA del body: se guarda en la bitácora de canjes de
      // cupones (Fase N.2) y, si viniera del cliente, registraría lo que él quisiera. Solo es
      // dato forense — ninguna decisión la consulta.
      { clientIp: req.ip ?? null },
    );

    // El cuerpo de un reenvío es idéntico al del original a propósito, así que sin este
    // header el cliente no tiene cómo saber que su segunda compra no se creó.
    if (replayed) res.set("Idempotency-Replayed", "true");
    res.status(201).json({ order, clientSecret });
  },
);

/**
 * GET /api/orders/lookup/:token — consulta pública del pedido (Fase O.4).
 *
 * Sin auth: el token opaco de la orden (que viaja en el link del correo de confirmación) ES la
 * credencial. Devuelve una proyección explícita —estado, rastreo, totales y dirección— nunca la
 * fila completa; ver `getOrderByPublicToken` en orders.service.ts para qué queda fuera y por qué.
 * Un token inválido, inexistente o mal formado responde el MISMO 404 genérico, para no confirmar
 * qué tokens existen.
 */
export const lookupOrder: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    // Express tipa los params como `string | string[]`; el token siempre llega como uno solo,
    // y si no, la validación de formato del servicio lo rechaza con el mismo 404 genérico.
    const raw = req.params.token;
    const token = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

    const order = await ordersService.getOrderByPublicToken(token);

    res.json({ order });
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

/** Valores aceptados por `?estado=` en `adminGetOrders`; cualquier otro valor se ignora (mismo criterio del catálogo público: un filtro inválido no rompe la consulta, se comporta como si no viniera). */
const ADMIN_ORDER_STATUS_FILTERS = {
  // Pagados que todavía no avanzan a shipped/delivered — la pestaña "pendientes de enviar".
  pendientes_envio: "paid",
  // Ya enviados (con guía o marcados a mano) pero aún no marcados como entregados.
  enviados: "shipped",
  entregados: "delivered",
} as const;

/**
 * GET /api/admin/orders — listado paginado de pedidos (admin).
 * Incluye items congelados con unitCost (a diferencia de las rutas públicas).
 * `date` (YYYY-MM-DD, opcional) acota a los pedidos creados ese día UTC.
 * `estado` (opcional: `pendientes_envio` | `enviados` | `entregados`) acota por `Order.status`,
 * para las pestañas del panel; sin este parámetro (o con `todos`) no filtra por estado.
 */
export const adminGetOrders: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const perPage = Number(req.query.perPage) || 20;
    const date = req.query.date;
    const estado = req.query.estado;

    const where = {} as Record<string, unknown>;
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);
      where.createdAt = { [Op.between]: [start, end] };
    }
    if (
      typeof estado === "string" &&
      estado in ADMIN_ORDER_STATUS_FILTERS
    ) {
      where.status =
        ADMIN_ORDER_STATUS_FILTERS[estado as keyof typeof ADMIN_ORDER_STATUS_FILTERS];
    }
    const whereOptions = where as WhereOptions<OrderAttributes>;

    // Pestaña "pendientes de enviar": los pedidos con más tiempo esperando envío van
    // primero (ASC), para priorizar el despacho de lo más viejo. El resto de vistas
    // mantiene el orden habitual, más reciente primero (DESC).
    const sortDirection = estado === "pendientes_envio" ? "ASC" : "DESC";

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
      order: [["createdAt", sortDirection]],
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

/**
 * PATCH /api/admin/orders/:id/status — avance manual de estado de envío (admin, Fase O.1).
 * Mueve el pedido a `shipped`/`delivered` y guarda la guía capturada a mano; solo hacia
 * adelante (409 si retrocede, si el pedido está cancelado o si aún no está pagado). El correo
 * "tu pedido va en camino" sale una sola vez por pedido, lo dispare el panel o el webhook de
 * Skydropx. Ver `updateOrderStatusByAdmin` en orders.service.ts.
 */
export const adminUpdateOrderStatus: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "pedido");
    const input = orderStatusUpdateSchema.parse(req.body ?? {});

    const order = await ordersService.updateOrderStatusByAdmin(id, input);

    res.json({ order });
  },
);

/**
 * POST /api/admin/orders/:id/shipment/retry — reintento manual de la guía (admin, Fase O.3).
 * Regenera la guía de un pedido pagado que se quedó sin ella (Skydropx falló al pagar) y libera
 * el centinela huérfano que dejaría un proceso caído. 409 si el pedido ya tiene guía —real o
 * cobrada sin persistir—, si no está pagado, si está cancelado o si se cobró con tarifa plana;
 * 502 si Skydropx vuelve a fallar. Ver `retryShipmentForOrder` en payment.service.ts.
 */
export const adminRetryShipment: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "pedido");
    // Body opcional: el reintento normal no manda nada. `force` solo aplica al caso "Skydropx no
    // respondió y pudo haber cobrado la guía" (ver `retryShipmentForOrder`).
    const { force } = retryShipmentSchema.parse(req.body ?? {});

    const order = await paymentService.retryShipmentForOrder(id, { force });

    res.json({ order });
  },
);

/**
 * POST /api/admin/orders/:id/rotate-token — rotación del código de rastreo público (admin,
 * Fase O.6). Invalida el `publicToken` actual y genera uno nuevo, sin importar el estado del
 * pedido; el comprador recibe el código nuevo por correo. Sin body: no hay nada que capturar
 * (no se guarda quién pidió la rotación). Ver `rotatePublicToken` en orders.service.ts.
 */
export const adminRotateOrderToken: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "pedido");

    const order = await ordersService.rotatePublicToken(id);

    res.json({ order });
  },
);
