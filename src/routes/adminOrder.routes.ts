import { Router } from "express";
import {
  adminGetOrders,
  adminCancelOrder,
  adminUpdateOrderStatus,
} from "../controllers/order.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/orders:
 *   get:
 *     summary: Lista paginada de pedidos (admin) con sus items, incluyendo unitCost
 *     tags: [Admin - Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Página (se ajusta al rango [1, totalPages]).
 *       - in: query
 *         name: perPage
 *         schema: { type: integer, minimum: 1, default: 20 }
 *         description: Pedidos por página.
 *     responses:
 *       200:
 *         description: Página de pedidos, más recientes primero.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Order'
 *                 total: { type: integer, example: 137 }
 *                 page: { type: integer, example: 1 }
 *                 perPage: { type: integer, example: 20 }
 *                 totalPages: { type: integer, example: 7 }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", adminGetOrders);

/**
 * @openapi
 * /api/admin/orders/{id}/cancel:
 *   post:
 *     summary: Cancela (y reembolsa, si está pagada) un pedido de forma manual
 *     description: >
 *       Para atender una cancelación pedida fuera del flujo normal (WhatsApp, llamada).
 *       Un pedido `pending` libera el stock reservado y se cierra. Un pedido `paid`
 *       primero se reembolsa en Stripe (reembolso total) y luego se restockea; queda
 *       en `status: cancelled` / `paymentStatus: refunded` con `refundId`/`refundedAt`.
 *       Un pedido `shipped`/`delivered`/`cancelled` no es cancelable (409).
 *     tags: [Admin - Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *         description: id del pedido a cancelar.
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CancelOrderInput'
 *     responses:
 *       200:
 *         description: Pedido cancelado (y reembolsado si estaba pagado).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: El pedido ya está enviado, entregado o cancelado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       502:
 *         description: El reembolso en Stripe falló; el pedido no se canceló.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/cancel", adminCancelOrder);

/**
 * @openapi
 * /api/admin/orders/{id}/status:
 *   patch:
 *     summary: Marca un pedido como enviado o entregado, con la guía capturada a mano
 *     description: >
 *       Cierra el hueco de los pedidos que nunca pasan por Skydropx (los que cayeron al
 *       fallback de tarifa plana en el checkout): sin guía automática no llega webhook, así
 *       que su `status` se quedaría en `paid` para siempre. El avance es **solo hacia
 *       adelante** (`pending < paid < shipped < delivered`, el mismo rango que aplica el
 *       webhook de Skydropx): repetir el estado actual sirve para agregar la guía después,
 *       pero retroceder responde `409`. Un pedido `cancelled` (409) o todavía `pending`
 *       (409, sin pago confirmado) no se puede enviar; para cancelar está
 *       `POST /api/admin/orders/{id}/cancel`, el único camino que reembolsa y restockea.
 *       El correo "tu pedido va en camino" se dispara la **primera** vez que el pedido
 *       recibe un número de guía —con el mismo guard atómico que usa el webhook—, así que
 *       sale exactamente una vez sin importar cuál de los dos caminos la capturó. Marcar
 *       `delivered` sin guía es válido (entrega en mano o local) y no manda correo.
 *     tags: [Admin - Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *         description: id del pedido a actualizar.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OrderStatusUpdateInput'
 *     responses:
 *       200:
 *         description: Pedido actualizado, con sus items.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: >
 *           El estado no puede retroceder, el pedido está cancelado, o todavía no está pagado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch("/:id/status", adminUpdateOrderStatus);

export default router;
