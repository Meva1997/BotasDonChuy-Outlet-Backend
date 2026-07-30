import { Router } from "express";
import {
  adminGetOrders,
  adminCancelOrder,
  adminUpdateOrderStatus,
  adminRetryShipment,
} from "../../controllers/order.controller";
import { requireAuth } from "../../middlewares/requireAuth";

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

/**
 * @openapi
 * /api/admin/orders/{id}/shipment/retry:
 *   post:
 *     summary: Reintenta generar la guía de Skydropx de un pedido pagado que se quedó sin ella
 *     description: >
 *       La guía se genera automáticamente al confirmarse el pago; si esa llamada falla
 *       (Skydropx caído, saldo agotado) el pedido queda pagado y sin guía, y hasta ahora no
 *       había forma de reintentarlo. Esta ruta lo reintenta y, si el proceso murió a media
 *       creación dejando el valor centinela `creating` en `skydropxShipmentId`, lo libera por
 *       antigüedad antes de reclamarlo de nuevo — sin eso ese pedido no podría volver a generar
 *       guía nunca. Un barrido automático hace lo mismo cada pocos minutos; esta ruta es para
 *       no esperarlo.
 *       **Cada guía se cobra**, así que ante la duda no se genera una segunda: responde `409`
 *       si el pedido ya tiene guía, si tiene una que Skydropx cobró pero no se pudo guardar (el
 *       mensaje incluye su id para buscarla en el panel de Skydropx), si otra solicitud la está
 *       generando en este momento, si el pedido no está pagado, está cancelado o ya se marcó como
 *       enviado/entregado, o si se cobró con la tarifa plana de respaldo (no hay tarifa de
 *       Skydropx que convertir en guía — genérala en su panel y captura el número al marcar el
 *       pedido como enviado).
 *       A diferencia del camino automático, aquí se espera el resultado: un fallo de Skydropx
 *       responde `502`.
 *       Caso especial: si Skydropx **no respondió** al crear la guía (timeout o corte de
 *       conexión), pudo haberla creado y cobrado sin que quedara registrada; el pedido se marca
 *       como no conciliado y este endpoint responde `409` pidiendo verificar en el panel de
 *       Skydropx. Una vez confirmado que no existe ninguna guía, se reintenta con
 *       `{ "force": true }` en el body para generarla de todos modos. `force` **solo** aplica a
 *       ese caso: nunca desbloquea un pedido con una guía de id conocido.
 *     tags: [Admin - Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *         description: id del pedido cuya guía se quiere generar.
 *     requestBody:
 *       required: false
 *       description: >
 *         Opcional. El reintento normal no lleva body.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 description: >
 *                   Confirma que ya se revisó el panel de Skydropx y NO existe ninguna guía de
 *                   este pedido. Solo desbloquea el caso en que Skydropx no respondió al crearla.
 *             example: { force: true }
 *     responses:
 *       200:
 *         description: Guía generada; el pedido vuelve con su `skydropxShipmentId` y sus items.
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
 *           El pedido ya tiene guía (real o cobrada sin guardar), se está generando ahora
 *           mismo, no está pagado, está cancelado, ya se marcó como enviado/entregado, usó la
 *           tarifa plana de respaldo, o quedó sin conciliar porque Skydropx no respondió (se
 *           desbloquea con `force: true` tras verificar en su panel).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       502:
 *         description: Skydropx no pudo generar la guía; el pedido sigue sin ella.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/shipment/retry", adminRetryShipment);

export default router;
