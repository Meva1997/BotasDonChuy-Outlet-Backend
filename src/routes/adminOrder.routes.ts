import { Router } from "express";
import { adminGetOrders } from "../controllers/order.controller";
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

export default router;
