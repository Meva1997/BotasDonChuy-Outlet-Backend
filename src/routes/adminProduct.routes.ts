import { Router } from "express";
import {
  adminGetProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddProductImages,
  adminDeleteProductImage,
} from "../controllers/product.controller";
import { requireAuth } from "../middlewares/requireAuth";
import { uploadProductImages } from "../middlewares/upload";

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

/**
 * @openapi
 * /api/admin/products/{id}/images:
 *   post:
 *     summary: Sube de 1 a 3 imágenes del producto a Cloudinary
 *     description: >
 *       Recibe archivos por multipart/form-data (campo `images`, hasta 3 por
 *       petición). Respeta un tope de 3 imágenes en total por producto. Formatos
 *       PNG/JPEG/WEBP, máximo 5 MB cada una. `imageSrc` (calculado) refleja la primera imagen.
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       201:
 *         description: Producto con la galería de imágenes actualizada.
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
router.post("/:id/images", uploadProductImages, adminAddProductImages);

/**
 * @openapi
 * /api/admin/products/{id}/images:
 *   delete:
 *     summary: Borra una imagen del producto (y de Cloudinary)
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
 *             type: object
 *             required: [publicId]
 *             properties:
 *               publicId:
 *                 type: string
 *                 description: public_id de Cloudinary de la imagen a borrar.
 *     responses:
 *       200:
 *         description: Producto con la imagen eliminada.
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
router.delete("/:id/images", adminDeleteProductImage);

export default router;
