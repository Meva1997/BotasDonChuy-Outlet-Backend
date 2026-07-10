import { Router } from "express";
import { createOrder } from "../controllers/order.controller";

const router: Router = Router();

/**
 * @openapi
 * /api/orders:
 *   post:
 *     summary: Crea un pedido a partir del carrito (checkout público)
 *     description: >
 *       Recalcula los totales en el servidor, verifica y descuenta el stock por
 *       talla de forma atómica, congela los precios en cada renglón y persiste
 *       la orden en estado `pending`. El cuerpo NO envía montos: el backend es la
 *       autoridad de precios. Si dos clientes compran la última unidad a la vez,
 *       solo uno recibe `201`; el otro recibe `409` y la talla queda en stock 0.
 *     tags: [Orders]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOrderInput'
 *     responses:
 *       201:
 *         description: Pedido creado (`pending`). Devuelve el `clientSecret` del PaymentIntent de Stripe para confirmar el pago.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OrderResponse'
 *       400:
 *         description: Body inválido (carrito vacío, datos de cliente inválidos).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Sin stock suficiente o producto no disponible (incluye el ítem en el mensaje).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", createOrder);

export default router;
