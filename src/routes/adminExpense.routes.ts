import { Router } from "express";
import {
  adminListExpenses,
  adminExpenseSummary,
  adminExpenseHistory,
  adminCreateExpense,
  adminUpdateExpense,
  adminDeleteExpense,
} from "../controllers/expense.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/expenses:
 *   get:
 *     summary: Lista los gastos con su monto vigente y su carga mensual
 *     description: >
 *       Cada fila trae `currentAmount` (el monto vigente hoy, **calculado** a partir de las
 *       versiones: no existe una columna `amount`), `monthlyRunRate` (el equivalente mensual de
 *       ese gasto), `nextChargeDate` y `amounts` — el historial de precios de ese gasto.
 *
 *
 *       El filtro `from`/`to` es por **fecha de cargo**, no por fecha de alta: un gasto dado de
 *       alta en enero y vigente desde entonces sí aparece al consultar agosto.
 *     tags: [Admin - Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           example: "2026-08-01"
 *         description: Deja solo los gastos que cobran algo desde esta fecha (AAAA-MM-DD).
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           example: "2026-08-31"
 *         description: Deja solo los gastos que cobran algo hasta esta fecha (AAAA-MM-DD).
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [infraestructura, software, renta, servicios, paqueteria, publicidad, nomina, impuestos, otro]
 *       - in: query
 *         name: active
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *     responses:
 *       200:
 *         description: Array de gastos, del más reciente al más antiguo.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Expense'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", adminListExpenses);

/**
 * @openapi
 * /api/admin/expenses/summary:
 *   get:
 *     summary: Cuánto hay que retirar de lo ganado para cubrir los gastos
 *     description: >
 *       `monthlyRunRate` es la suma de todos los gastos recurrentes llevados a su equivalente
 *       mensual: una anualidad cuenta 1/12, una semanal 52/12 (no 4 — el año tiene 52 semanas) y
 *       los gastos de única vez no cuentan, porque no son una carga recurrente.
 *
 *
 *       `upcomingCharges` es la otra mitad de la pregunta: qué se cobra, de cuánto y en qué fecha
 *       durante los próximos `upcomingDays` días.
 *     tags: [Admin - Expenses]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Resumen de la carga de gastos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExpenseSummary'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/summary", adminExpenseSummary);

/**
 * @openapi
 * /api/admin/expenses/history:
 *   get:
 *     summary: Historial de gastos mes con mes, con los cambios de precio
 *     description: >
 *       Cada mes trae su `total`, el desglose `byCategory`/`byExpense`, y **`changes`** — los
 *       cambios de precio que entraron en vigor ese mes, con `previousAmount` y `amount`. Ese
 *       arreglo es lo que responde "¿algo cambió?": sin él, un aumento de la suscripción solo se
 *       nota como un total más alto sin causa visible.
 *
 *
 *       Los meses van sin huecos (los meses sin gasto salen en `$0`, nunca se saltan) y el mes en
 *       curso viene con `partial: true`. Los cargos se atribuyen a **su** mes con el monto que
 *       estaba vigente en esa fecha: una anualidad aparece completa en su mes de renovación, y un
 *       aumento de precio nunca reescribe los meses anteriores.
 *     tags: [Admin - Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           example: "2026-01"
 *         description: Mes inicial (AAAA-MM). Por defecto, el mes del gasto más antiguo.
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           example: "2026-08"
 *         description: Mes final (AAAA-MM). Por defecto, el mes en curso.
 *     responses:
 *       200:
 *         description: Meses en orden cronológico, más antiguo primero.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ExpenseMonth'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/history", adminExpenseHistory);

/**
 * @openapi
 * /api/admin/expenses:
 *   post:
 *     summary: Da de alta un gasto
 *     description: >
 *       Crea el gasto **y su primera versión de monto** en una sola transacción. Esa primera
 *       versión rige desde `startsAt` (no desde hoy) salvo que se mande `amountEffectiveFrom`: si
 *       se registra en agosto una suscripción que empezó en marzo, los cargos de marzo a julio
 *       tienen que valer ese monto.
 *     tags: [Admin - Expenses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ExpenseInput'
 *     responses:
 *       201:
 *         description: Gasto creado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Expense'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/", adminCreateExpense);

/**
 * @openapi
 * /api/admin/expenses/{id}:
 *   put:
 *     summary: Edita un gasto (mandar solo los campos que cambian)
 *     description: >
 *       **Mandar `amount` no sobrescribe el monto: agrega una versión** con vigencia
 *       `amountEffectiveFrom` (o hoy). Eso es lo que hace que subir el precio de Render no
 *       reescriba lo que costaba en julio, y lo que alimenta el arreglo `changes` del historial.
 *
 *
 *       Dos excepciones: si ya existe una versión con esa misma fecha de vigencia se **corrige en
 *       su lugar** (el dueño arreglando lo que acaba de capturar, no un cambio de precio), y si el
 *       monto no cambió no se escribe nada — editar el concepto no debe ensuciar el historial de
 *       precios.
 *
 *
 *       `active` y `endsAt` se mantienen coherentes: apagar un gasto le fija `endsAt` en hoy (para
 *       que "hasta cuándo cobró" sea un dato y no una inferencia), y reactivarlo limpia un
 *       `endsAt` viejo salvo que el body mande uno.
 *     tags: [Admin - Expenses]
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
 *             $ref: '#/components/schemas/ExpenseUpdateInput'
 *     responses:
 *       200:
 *         description: Gasto actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Expense'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.put("/:id", adminUpdateExpense);

/**
 * @openapi
 * /api/admin/expenses/{id}:
 *   delete:
 *     summary: Elimina un gasto (lo desactiva si ya generó algún cargo)
 *     description: >
 *       Mismo criterio que `DELETE /api/admin/coupons/{id}`: si el gasto ya generó al menos un
 *       cargo se **desactiva** (`deactivated: true`, con `endsAt` en hoy) porque ese dinero se
 *       gastó y borrarlo dejaría el historial mintiendo sobre meses ya cerrados. Solo se borra de
 *       verdad lo que nunca cobró nada — un alta equivocada o un gasto programado a futuro.
 *     tags: [Admin - Expenses]
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
 *         description: Gasto borrado o desactivado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 deactivated:
 *                   type: boolean
 *                   description: true si solo se desactivó por tener cargos en el historial.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", adminDeleteExpense);

export default router;
