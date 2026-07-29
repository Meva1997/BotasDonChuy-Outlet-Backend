import { Router } from "express";
import { createOrder, lookupOrder } from "../controllers/order.controller";
import { orderRateLimiter, orderLookupRateLimiter } from "../middlewares/rateLimit";

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
 *       Sujeto a rate limiting.
 *
 *
 *       **Idempotente (Fase O.2):** un reenvío del mismo checkout dentro de una ventana
 *       corta (doble clic, reintento del navegador) NO crea un segundo pedido: devuelve
 *       la misma respuesta del original —mismo `order`, mismo `clientSecret`, mismo `201`—
 *       en vez de otro cobro con el stock descontado dos veces. Manda el header
 *       `Idempotency-Key` con un valor nuevo por cada intento de compra; si no viene, el
 *       servidor deduplica por una huella del carrito + los datos del cliente.
 *     tags: [Orders]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema:
 *           type: string
 *           maxLength: 200
 *         description: >
 *           Identificador único de ESTE intento de compra (por ejemplo un UUID generado al
 *           abrir el checkout). Reenviarlo con el mismo carrito devuelve el pedido original;
 *           reusarlo con un carrito distinto responde `409`. Genera uno nuevo cuando el
 *           cliente modifique el carrito o vuelva a cotizar el envío.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOrderInput'
 *     responses:
 *       201:
 *         description: >
 *           Pedido creado (`pending`). Devuelve el `clientSecret` del PaymentIntent de Stripe
 *           para confirmar el pago. Un reenvío deduplicado responde este mismo `201` con el
 *           pedido y el `clientSecret` originales (no se crea nada nuevo), distinguible solo
 *           por el header `Idempotency-Replayed`.
 *         headers:
 *           Idempotency-Replayed:
 *             description: >
 *               Presente con valor `true` **solo** cuando esta respuesta es la repetición de un
 *               checkout anterior (el pedido ya existía y no se creó nada). Ausente en el
 *               pedido original. Se expone vía CORS, así que el navegador puede leerlo.
 *             schema:
 *               type: string
 *               enum: [true]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OrderResponse'
 *       400:
 *         description: Body inválido (carrito vacío, datos de cliente inválidos) o `Idempotency-Key` demasiado larga.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: >
 *           Sin stock suficiente o producto no disponible (incluye el ítem en el mensaje),
 *           tarifa de envío ya no disponible, o `Idempotency-Key` reusada con otro carrito.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados pedidos desde la misma IP en poco tiempo.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", orderRateLimiter, createOrder);

/**
 * @openapi
 * /api/orders/lookup/{token}:
 *   get:
 *     summary: Consulta pública del estado y rastreo de un pedido
 *     description: >
 *       Deja al comprador ver en qué va su pedido sin cuenta ni contraseña. **No lleva auth:**
 *       el `publicToken` opaco de la orden —que viaja como link en el correo de confirmación y
 *       se devuelve también en la respuesta del checkout— es la credencial.
 *
 *
 *       La respuesta es una **proyección explícita**, no la fila completa del pedido: quedan
 *       fuera `unitCost`, `paymentIntentId`, `refundId`, `shippingRequiresDropoff` (bandera
 *       operativa del dueño), `labelUrl` (la etiqueta imprimible es del dueño), los ids de
 *       Skydropx, el propio token y el correo/teléfono del cliente.
 *
 *
 *       Un token mal formado, inexistente o de un pedido borrado devuelve **el mismo `404` con
 *       el mismo mensaje**, para no confirmar qué tokens existen. Sujeto a rate limiting.
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: El `publicToken` de la orden (UUID).
 *         example: 3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13
 *     responses:
 *       200:
 *         description: Pedido encontrado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order: { $ref: '#/components/schemas/PublicOrderLookup' }
 *       404:
 *         description: >
 *           No hay ningún pedido con ese token (o el token no tiene forma de UUID). Mensaje
 *           idéntico en los dos casos, por diseño.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiadas consultas desde la misma IP en poco tiempo.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/lookup/:token", orderLookupRateLimiter, lookupOrder);

export default router;
