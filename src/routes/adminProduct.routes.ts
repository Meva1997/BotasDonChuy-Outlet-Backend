import { Router } from "express";
import {
  adminGetProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddProductImages,
  adminDeleteProductImage,
  adminImportProducts,
  adminPreviewProductImport,
} from "../controllers/product.controller";
import { requireAuth } from "../middlewares/requireAuth";
import { uploadProductImages, uploadProductImportFile } from "../middlewares/upload";

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
 * /api/admin/products/import/preview:
 *   post:
 *     summary: Paso 1 de la importación masiva — previsualiza el Excel sin escribir nada
 *     description: >
 *       Recibe un archivo por multipart/form-data (campo `file`, máximo 2 MB, solo .xlsx, máximo
 *       500 filas de datos) y devuelve, fila por fila, el resultado que TENDRÍA aplicarlo, **sin
 *       modificar la base de datos**.
 *
 *
 *       Cada fila indica su `action` (`create` · `update` · `unchanged` · `error`), el producto
 *       con el que empareja (`before`, `null` si se va a crear), cómo quedaría (`after`), la
 *       lista de campos que cambian (`changes`) y el detalle del stock por talla
 *       (`sizeChanges`, con `before`/`added`/`after` — el restock SUMA, nunca reemplaza).
 *
 *
 *       El emparejamiento usa "Código" (insensible a mayúsculas) y, si la fila no lo trae,
 *       "Nombre" exacto insensible a mayúsculas. Un valor que empareja con más de un producto
 *       es ambiguo y esa fila se reporta como error. Las filas se resuelven además contra los
 *       cambios que las filas anteriores del mismo archivo ya proyectaron, así que un archivo
 *       que crea un producto en una fila y lo restockea en otra se ve tal como se aplicará.
 *
 *
 *       `warnings` (a nivel archivo) lista las columnas que no se reconocieron y que por tanto
 *       NO se van a importar; `warnings` por fila avisa de celdas interpretadas con criterio
 *       (coma decimal, formato de fecha) o de que la fila no cambia nada.
 *
 *
 *       Para confirmar, el cliente manda de vuelta los `input` de las filas que quiera aplicar
 *       —con sus ediciones— a `POST /api/admin/products/import`.
 *     tags: [Admin - Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Plan de importación fila por fila. No se escribió nada.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProductImportPreviewResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/import/preview", uploadProductImportFile, adminPreviewProductImport);

/**
 * @openapi
 * /api/admin/products/import:
 *   post:
 *     summary: Paso 2 de la importación masiva — aplica las filas revisadas
 *     description: >
 *       Recibe en JSON las filas que el dueño revisó (y, si hizo falta, editó) en el preview y
 *       las aplica. Es JSON y no el .xlsx original a propósito: lo que se escribe es lo que se
 *       revisó en pantalla, no lo que traía el archivo.
 *
 *
 *       Cada fila se procesa de forma independiente y en su propia transacción, en orden: si
 *       empareja con un producto existente lo ACTUALIZA —las tallas de la fila se SUMAN al stock
 *       guardado por talla, nunca lo reemplazan, y una clave ausente nunca borra un valor ya
 *       guardado—; si no empareja, lo crea. Un producto descontinuado que hace match se reactiva.
 *       Una fila inválida se reporta como error sin bloquear las demás (éxito parcial).
 *
 *
 *       Enviar el mismo lote dos veces en menos de un minuto responde `409`: el restock suma, así
 *       que un doble clic duplicaría el stock.
 *     tags: [Admin - Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProductImportCommitInput'
 *     responses:
 *       200:
 *         description: Resultado de la importación, fila por fila.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProductImportResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: Este mismo lote se aplicó hace unos segundos (protección de doble envío).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/import", adminImportProducts);

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
