import { Router } from "express";
import { getAdminDashboard } from "../../controllers/dashboard.controller";
import { requireAuth } from "../../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/dashboard:
 *   get:
 *     summary: Métricas agregadas del panel (KPIs, ingresos, ventas recientes, inventario)
 *     tags: [Admin - Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Datos del dashboard.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DashboardData'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", getAdminDashboard);

export default router;
