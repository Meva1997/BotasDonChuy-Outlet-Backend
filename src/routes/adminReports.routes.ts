import { Router } from "express";
import {
  getMonthlyReport,
  getReplenishmentReport,
} from "../controllers/reports.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/reports/monthly:
 *   get:
 *     summary: Ventas por mes por producto (el mes en curso sale con partial=true)
 *     tags: [Admin - Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reportes mensuales (cronológico, más antiguo primero).
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MonthlyReport'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/monthly", getMonthlyReport);

/**
 * @openapi
 * /api/admin/reports/replenishment:
 *   get:
 *     summary: Filas de reposición sugerida (pronóstico + cobertura + margen)
 *     tags: [Admin - Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >-
 *           Filas de reposición ordenadas por urgencia de cobertura y, dentro de
 *           cada nivel, por margen mensual descendente.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ReplenishmentRow'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/replenishment", getReplenishmentReport);

export default router;
