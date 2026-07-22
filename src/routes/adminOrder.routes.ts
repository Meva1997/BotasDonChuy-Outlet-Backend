import { Router } from "express";
import { adminGetOrders, adminCancelOrder } from "../controllers/order.controller";
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

export default router;
