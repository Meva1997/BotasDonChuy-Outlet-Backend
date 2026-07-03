import { Router } from "express";
import { getBrandSettings, updateBrandSettings } from "../controllers/brand.controller";
import { requireAuth } from "../middlewares/requireAuth";

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

export default router;
