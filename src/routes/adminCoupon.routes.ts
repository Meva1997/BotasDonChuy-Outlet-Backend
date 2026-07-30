import { Router } from "express";
import {
  adminListCoupons,
  adminCreateCoupon,
  adminUpdateCoupon,
  adminDeleteCoupon,
} from "../controllers/coupon.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/coupons:
 *   get:
 *     summary: Lista los cupones de descuento
 *     description: >
 *       Incluye `redeemedCount` (el contador que mueven el canje y la liberación) y
 *       `activeRedemptions` (conteo vivo de canjes vigentes). Normalmente coinciden; si difieren
 *       hubo una intervención manual en la base de datos y conviene revisarlo.
 *     tags: [Admin - Coupons]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array de cupones, del más reciente al más antiguo.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Coupon'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", adminListCoupons);

/**
 * @openapi
 * /api/admin/coupons:
 *   post:
 *     summary: Crea un cupón de descuento
 *     description: >
 *       Pueden existir varios cupones activos a la vez, pero un pedido solo puede usar uno.
 *       `startsAt`/`expiresAt` aceptan un instante ISO completo; una fecha sin hora
 *       (`2026-08-01`) se interpreta en la zona de la tienda (`America/Mexico_City`): inicio de
 *       día para `startsAt` y final de día para `expiresAt`.
 *     tags: [Admin - Coupons]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CouponInput'
 *     responses:
 *       201:
 *         description: Cupón creado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Coupon'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: Ya existe un cupón con ese código.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", adminCreateCoupon);

/**
 * @openapi
 * /api/admin/coupons/{id}:
 *   put:
 *     summary: Edita un cupón (mandar solo los campos que cambian)
 *     description: >
 *       **`active: false` es la forma de cancelar una promoción**: el cupón deja de canjearse sin
 *       perder el histórico de lo que ya se vendió con él.
 *
 *
 *       Editar un cupón que ya tiene canjes es válido y **no altera pedidos pasados**: el código
 *       y el descuento quedan congelados en cada orden, igual que los precios.
 *
 *
 *       Bajar `maxRedemptions` por debajo de `redeemedCount` también es válido, y es la forma de
 *       detener una promoción en caliente: a partir de ahí ningún canje nuevo pasa.
 *
 *
 *       **`code` y `redeemedCount` no se pueden editar.** El código porque ya pudo repartirse y
 *       porque el valor congelado en los pedidos dejaría de empatar (si está mal, desactívalo y
 *       crea otro); el contador porque es estado derivado que solo mueven el canje y la
 *       liberación, y un valor a mano lo desincronizaría de forma permanente.
 *     tags: [Admin - Coupons]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CouponUpdateInput'
 *     responses:
 *       200:
 *         description: Cupón actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Coupon'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put("/:id", adminUpdateCoupon);

/**
 * @openapi
 * /api/admin/coupons/{id}:
 *   delete:
 *     summary: Elimina un cupón (lo desactiva si ya se usó en algún pedido)
 *     description: >
 *       Mismo criterio que `DELETE /api/admin/products/{id}`: si algún pedido usó el cupón se
 *       **desactiva** (`deactivated: true`) para no romper el histórico de esa venta; si nunca se
 *       usó, se borra de verdad junto con sus registros de canje.
 *     tags: [Admin - Coupons]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Cupón borrado o desactivado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 deactivated:
 *                   type: boolean
 *                   description: true si solo se desactivó por tener pedidos asociados.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", adminDeleteCoupon);

export default router;
