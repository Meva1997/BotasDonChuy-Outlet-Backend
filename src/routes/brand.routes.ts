import { Router } from "express";
import {
  getBrandSettings,
  updateBrandSettings,
  uploadBrandLogo,
  deleteBrandLogo,
} from "../controllers/brand.controller";
import { requireAuth } from "../middlewares/requireAuth";
import { uploadLogo } from "../middlewares/upload";

const router: Router = Router();

/**
 * @openapi
 * /api/admin/brand:
 *   get:
 *     summary: Devuelve la identidad de marca (lectura pública)
 *     tags: [Admin - Brand]
 *     responses:
 *       200:
 *         description: Configuración de marca actual (se crea con defaults si no existe).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BrandSettings'
 */
router.get("/", getBrandSettings);

/**
 * @openapi
 * /api/admin/brand:
 *   put:
 *     summary: Actualiza parcialmente la identidad de marca
 *     tags: [Admin - Brand]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BrandSettingsUpdateInput'
 *     responses:
 *       200:
 *         description: Configuración de marca actualizada.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BrandSettings'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.put("/", requireAuth, updateBrandSettings);

/**
 * @openapi
 * /api/admin/brand/logo:
 *   post:
 *     summary: Sube el logo de la tienda a Cloudinary
 *     description: >
 *       Recibe el archivo por multipart/form-data (campo `logo`). Reemplaza el
 *       logo actual y destruye el anterior en Cloudinary. PNG/JPEG/WEBP, máx 5 MB.
 *     tags: [Admin - Brand]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [logo]
 *             properties:
 *               logo:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Configuración de marca con el logoUrl actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BrandSettings'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/logo", requireAuth, uploadLogo, uploadBrandLogo);

/**
 * @openapi
 * /api/admin/brand/logo:
 *   delete:
 *     summary: Quita el logo de la tienda (y lo borra de Cloudinary)
 *     tags: [Admin - Brand]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Configuración de marca con logoUrl en null.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BrandSettings'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.delete("/logo", requireAuth, deleteBrandLogo);

export default router;
