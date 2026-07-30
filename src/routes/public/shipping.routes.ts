import { Router } from "express";
import { getShippingRates } from "../../controllers/shipping.controller";
import { shippingRateLimiter } from "../../middlewares/rateLimit";

const router: Router = Router();

/**
 * @openapi
 * /api/shipping/rates:
 *   post:
 *     summary: Cotiza tarifas de envío en vivo para el carrito (checkout público)
 *     description: >
 *       Arma una sola caja apilada a partir de los productos del carrito y cotiza
 *       contra Skydropx. Si la cotización en vivo falla, hace timeout, o no
 *       devuelve tarifas utilizables a tiempo, responde 200 igual con una tarifa
 *       plana de respaldo (`quotationId: null`, un solo rate con `rateId: null` /
 *       `carrier: "Estándar"`) — la tienda nunca deja de cotizar porque la
 *       paquetería esté caída. Sujeto a rate limiting.
 *     tags: [Shipping]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ShippingRatesInput'
 *     responses:
 *       200:
 *         description: >
 *           Tarifas disponibles, o la tarifa plana de respaldo si Skydropx no
 *           pudo cotizar a tiempo.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ShippingRatesResponse'
 *       400:
 *         description: Body inválido (carrito vacío, datos de cliente inválidos).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Un producto del carrito no existe, no es visible, o fue eliminado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/rates", shippingRateLimiter, getShippingRates);

export default router;
