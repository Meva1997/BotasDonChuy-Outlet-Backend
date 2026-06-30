import { Router } from "express";
import { stripeWebhook } from "../controllers/order.controller";

const router: Router = Router();

/**
 * @openapi
 * /api/webhooks/stripe:
 *   post:
 *     summary: Webhook de pagos (stub, listo para Stripe en Fase 8)
 *     description: >
 *       Recibe eventos de la pasarela y, cuando corresponde, marca la orden
 *       asociada como pagada. Hoy es un stub: acepta JSON y concilia por
 *       `paymentIntentId`. En Fase 8 se verificará la firma del evento con el
 *       secreto de Stripe sobre el cuerpo crudo (`express.raw`).
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentIntentId:
 *                 type: string
 *                 example: pi_3Abc123
 *     responses:
 *       200:
 *         description: Evento recibido.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       404:
 *         description: No existe una orden con ese pago.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/stripe", stripeWebhook);

export default router;
