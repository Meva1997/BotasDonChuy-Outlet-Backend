import { Router } from "express";
import {
  adminGetProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
} from "../controllers/product.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/products:
 *   get:
 *     summary: Lista todos los productos (admin) — incluye no visibles y unitCost
 *     tags: [Admin - Products]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array de productos con unitCost y stock por talla.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", adminGetProducts);

/**
 * @openapi
 * /api/admin/products:
 *   post:
 *     summary: Crea un nuevo producto
 *     tags: [Admin - Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductInput'
 *     responses:
 *       201:
 *         description: Producto creado con discountPercent calculado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/", adminCreateProduct);

/**
 * @openapi
 * /api/admin/products/{id}:
 *   put:
 *     summary: Actualiza parcialmente un producto
 *     tags: [Admin - Products]
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
 *             $ref: '#/components/schemas/ProductInput'
 *     responses:
 *       200:
 *         description: Producto actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put("/:id", adminUpdateProduct);

/**
 * @openapi
 * /api/admin/products/{id}:
 *   delete:
 *     summary: Elimina un producto (soft-delete si tiene pedidos, hard-delete si no)
 *     tags: [Admin - Products]
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
 *         description: Producto eliminado o marcado como no visible.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 softDeleted:
 *                   type: boolean
 *                   description: true si se hizo soft-delete por tener pedidos asociados.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", adminDeleteProduct);

export default router;
