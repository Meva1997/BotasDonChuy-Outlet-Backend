import { Router } from "express";
import { validateCoupon } from "../../controllers/coupon.controller";
import { couponRateLimiter } from "../../middlewares/rateLimit";

const router: Router = Router();

/**
 * @openapi
 * /api/coupons/validate:
 *   post:
 *     summary: Valida un cupón para el carrito actual, sin canjearlo
 *     description: >
 *       Ruta **pública** que el checkout usa para mostrarle al comprador el descuento antes de
 *       pagar. **No canjea nada**: no mueve el contador de usos ni registra un canje, así que
 *       abrir el checkout varias veces no gasta la promoción.
 *
 *
 *       Corre exactamente las mismas reglas y la misma función de descuento que
 *       `POST /api/orders`, para que el monto que se muestra sea el que se cobra. El descuento se
 *       calcula sobre la **mercancía neta** (`subtotal − savings`) y **nunca sobre el envío**.
 *
 *
 *       **El resultado no es una reserva.** El tope global de usos y el límite por cliente se
 *       re-deciden de forma atómica al crear el pedido, así que un cupón puede agotarse entre
 *       esta consulta y el pago: el cliente tiene que estar preparado para pintar el `409` de
 *       `POST /api/orders`. Por lo mismo `remainingRedemptions` es informativo.
 *
 *
 *       El `email` es opcional porque en el checkout el cupón se captura **antes** de los datos
 *       de envío; sin él no se puede verificar el "un uso por cliente" y la respuesta lo declara
 *       con `perCustomerChecked: false`.
 *
 *
 *       Los mensajes de error distinguen la causa (no existe, venció, se agotó, no alcanza el
 *       mínimo), a diferencia de otras rutas públicas de este backend: un cupón existe para que
 *       un humano lo teclee y un mensaje opaco haría la función inusable. La consecuencia es que
 *       **los códigos no son secretos**, así que un cupón dirigido a una sola persona debe ser
 *       largo y aleatorio; el límite por IP es la única barrera contra recorrer códigos.
 *     tags: [Coupons]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CouponValidateInput'
 *     responses:
 *       200:
 *         description: El cupón aplica; se devuelve el descuento calculado en el servidor.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 coupon:
 *                   $ref: '#/components/schemas/CouponValidateResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         description: No existe un cupón con ese código.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: >
 *           El cupón existe pero no aplica: está desactivado, todavía no empieza, venció, se
 *           agotó, no alcanza el mínimo de compra, ya lo usó ese correo, o el descuento sale en
 *           cero. También cuando un producto del carrito ya no está disponible.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados intentos con cupones desde la misma IP en poco tiempo.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/validate", couponRateLimiter, validateCoupon);

export default router;
