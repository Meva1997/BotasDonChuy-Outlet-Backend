import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler";
import { parseId } from "../utils/parseId";
import {
  expenseHistoryQuerySchema,
  expenseInputSchema,
  expenseListQuerySchema,
  expenseUpdateSchema,
} from "../schemas/expense";
import * as expensesService from "../services/expenses.service";

/**
 * GET /api/admin/expenses — listado de gastos (Fase N.3).
 *
 * Cada fila trae el `currentAmount` (calculado desde las versiones: no hay columna `amount`), su
 * `monthlyRunRate`, el `nextChargeDate` y el arreglo completo de versiones de monto — que es el
 * historial de precios de ese gasto en particular.
 *
 * El filtro `from`/`to` es por **fecha de cargo**, no por alta: un gasto dado de alta en enero y
 * vigente desde entonces tiene que salir al consultar agosto.
 */
export const adminListExpenses: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = expenseListQuerySchema.parse(req.query);

    const expenses = await expensesService.listExpenses(filters);

    res.json(expenses);
  },
);

/**
 * GET /api/admin/expenses/summary — cuánto hay que retirar de lo ganado.
 *
 * `monthlyRunRate` es la suma de todos los gastos recurrentes llevados a su equivalente mensual
 * (una anualidad cuenta 1/12, una semanal 52/12); `upcomingCharges` es la otra mitad de la
 * pregunta: qué se cobra, de cuánto y en qué fecha durante los próximos días.
 */
export const adminExpenseSummary: RequestHandler = asyncHandler(
  async (_req, res: Response) => {
    const summary = await expensesService.getExpenseSummary();

    res.json(summary);
  },
);

/**
 * GET /api/admin/expenses/history — historial mes con mes, sin huecos.
 *
 * El arreglo `changes` de cada mes es lo que responde "¿algo cambió?": trae los cambios de precio
 * que entraron en vigor ese mes con su monto anterior y el nuevo. Sin él, un aumento solo se nota
 * como un total más alto sin causa visible.
 */
export const adminExpenseHistory: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { from, to } = expenseHistoryQuerySchema.parse(req.query);

    const months = await expensesService.getExpenseHistory(from, to);

    res.json(months);
  },
);

/** POST /api/admin/expenses — da de alta un gasto junto con su primera versión de monto. */
export const adminCreateExpense: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = expenseInputSchema.parse(req.body);

    const expense = await expensesService.createExpense(input);

    res.status(201).json(expense);
  },
);

/**
 * PUT /api/admin/expenses/:id — edita un gasto (mandar solo lo que cambia).
 *
 * Mandar `amount` **agrega una versión** en vez de sobrescribir, salvo que ya exista una con la
 * misma fecha de vigencia (ahí se corrige en su lugar) o que el monto no haya cambiado.
 */
export const adminUpdateExpense: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "gasto");
    const input = expenseUpdateSchema.parse(req.body);

    const expense = await expensesService.updateExpense(id, input);

    res.json(expense);
  },
);

/**
 * DELETE /api/admin/expenses/:id — desactiva el gasto si ya generó algún cargo, lo borra si no.
 * Mismo criterio que `DELETE /api/admin/coupons/:id`: no se rompe el historial de meses cerrados.
 */
export const adminDeleteExpense: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "gasto");

    const result = await expensesService.deleteExpense(id);

    res.json(result);
  },
);
