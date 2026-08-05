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
 *     description: >
 *       Todo se calcula en memoria desde `Order`/`OrderItem`/`Product`/`expenses`, sin tablas de
 *       agregación. Una venta es un pedido con `paymentStatus: "paid"` y **no** `status: "paid"`:
 *       el status avanza a `shipped`/`delivered`, así que filtrar por él sacaba del reporte los
 *       pedidos justo al despacharlos.
 *
 *
 *       Rentabilidad: `GANANCIA BRUTA = INGRESOS − costo de producto − COSTO DE ENVÍO`, y
 *       `GANANCIA OPERATIVA = GANANCIA BRUTA − GASTOS`. El envío es **costo de venta** (se paga una
 *       guía por pedido, igual que el costo unitario de cada pieza) y por eso se resta en la
 *       ganancia bruta y **no** entra en GASTOS, que son los gastos capturados en
 *       `/api/admin/expenses` — sumarlo de los dos lados lo restaría dos veces. El mismo monto se
 *       expone aparte en `/api/admin/expenses/summary` y `/history` como línea derivada de solo
 *       lectura, para que el dueño lo vea sin que los números se contradigan.
 *
 *
 *       Las tres ventanas (7/30/90) vienen juntas en una sola respuesta y el front alterna en
 *       cliente; cada `trend` compara contra su propia ventana previa de igual longitud.
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
