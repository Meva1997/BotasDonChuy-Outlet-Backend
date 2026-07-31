import { z } from "zod";
import { EXPENSE_CATEGORIES, EXPENSE_FREQUENCIES } from "../models/Expense";

/**
 * Gastos (Fase N.3).
 *
 * Las fechas son **días de calendario** (`"YYYY-MM-DD"`) y se guardan tal cual en columnas
 * `DATEONLY`. Eso esquiva de raíz todo el problema de zona horaria que `couponDateSchema` tuvo que
 * resolver con un offset fijo de México: un cargo del 1 de agosto es el 1 de agosto, no "medianoche
 * UTC del 1 de agosto" (que en México es el 31 de julio a las 18:00).
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateOnlySchema(label: string) {
  return z
    .string(`${label} es requerida`)
    .trim()
    .regex(DATE_ONLY_PATTERN, `${label} debe tener el formato AAAA-MM-DD (por ejemplo 2026-08-01)`)
    .refine((value) => {
      // El regex acepta 2026-02-31; `Date` lo desborda al 3 de marzo en silencio, así que se
      // compara el resultado contra lo escrito para rechazar días que no existen.
      const [year, month, day] = value.split("-").map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      );
    }, `${label} no es una fecha real (revisa el día del mes)`);
}

const expenseFields = {
  concept: z
    .string("El concepto del gasto es requerido")
    .trim()
    .min(1, "Escribe un concepto (por ejemplo: Render — Web Service)")
    .max(120, "El concepto es demasiado largo (máximo 120 caracteres)"),
  vendor: z
    .string("El proveedor debe ser texto")
    .trim()
    .max(60, "El proveedor es demasiado largo (máximo 60 caracteres)")
    .nullable()
    .optional(),
  category: z.enum(EXPENSE_CATEGORIES, {
    message: `La categoría debe ser una de: ${EXPENSE_CATEGORIES.join(", ")}`,
  }),
  frequency: z.enum(EXPENSE_FREQUENCIES, {
    message:
      "La frecuencia debe ser: once (única vez), weekly, monthly, bimonthly, quarterly, semiannual o yearly",
  }),
  startsAt: dateOnlySchema("La fecha del primer cargo"),
  endsAt: dateOnlySchema("La fecha de término").nullable().optional(),
  active: z.boolean("El estado del gasto debe ser verdadero o falso").optional(),
  notes: z
    .string("Las notas deben ser texto")
    .trim()
    .max(300, "Las notas son demasiado largas (máximo 300 caracteres)")
    .nullable()
    .optional(),

  // ── El monto y su vigencia ────────────────────────────────────────────────────
  // No es una columna del gasto: cada valor que se manda aquí se guarda como una VERSIÓN en
  // `expense_amounts`. Es lo que permite que subir el precio de Render hoy no reescriba lo que
  // costaba en julio (ver `expenses.service.ts`).
  amount: z
    .number("El monto es requerido")
    .positive("El monto debe ser mayor a 0"),
  amountEffectiveFrom: dateOnlySchema("La fecha de vigencia del monto").optional(),
  amountNote: z
    .string("La nota del monto debe ser texto")
    .trim()
    .max(200, "La nota del monto es demasiado larga (máximo 200 caracteres)")
    .nullable()
    .optional(),
};

/**
 * Reglas cruzadas compartidas por crear y editar (una divergencia dejaría que un `PUT` metiera una
 * combinación que el `POST` rechaza — mismo patrón que `couponRuleIssues`). Cada regla solo aplica
 * cuando los campos que compara vienen en el body; el caso "el body trae solo uno de los dos" lo
 * cubre `updateExpense` contra el estado guardado, porque aquí no hay forma de verlo.
 */
interface ExpenseRuleFields {
  frequency?: (typeof EXPENSE_FREQUENCIES)[number];
  startsAt?: string;
  endsAt?: string | null;
  amount?: number;
  amountEffectiveFrom?: string;
}

function expenseRuleIssues(
  d: ExpenseRuleFields,
): Array<{ message: string; path: [string] }> {
  const issues: Array<{ message: string; path: [string] }> = [];

  if (d.startsAt && d.endsAt && d.endsAt < d.startsAt) {
    issues.push({
      message: "La fecha de término no puede ser anterior a la del primer cargo.",
      path: ["endsAt"],
    });
  }
  // Un gasto de única vez se cobra en su fecha y ya: una fecha de término es una contradicción
  // que dejaría dos campos diciendo cosas distintas sobre lo mismo.
  if (d.frequency === "once" && d.endsAt) {
    issues.push({
      message: "Un gasto de única vez no lleva fecha de término: se cobra una sola vez en su fecha.",
      path: ["endsAt"],
    });
  }
  // Fechar una vigencia sin decir de qué monto no significa nada, y aceptarlo en silencio dejaría
  // al dueño creyendo que registró un cambio de precio que nunca se guardó.
  if (d.amountEffectiveFrom && d.amount === undefined) {
    issues.push({
      message: "Para fechar una vigencia hay que mandar también el monto nuevo.",
      path: ["amount"],
    });
  }

  return issues;
}

export const expenseInputSchema = z
  .object(expenseFields)
  .superRefine((d, ctx) => {
    for (const issue of expenseRuleIssues(d)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type ExpenseInput = z.infer<typeof expenseInputSchema>;

/**
 * Edición. Todo opcional: el panel guarda campo por campo.
 *
 * Mandar `amount` **no sobrescribe** el monto anterior, agrega una versión con vigencia
 * `amountEffectiveFrom` (o hoy). Es la diferencia entre "corregí un dato" y "esto ahora cuesta
 * otra cosa", y solo lo segundo debe aparecer en el historial (ver `updateExpense`).
 *
 * Nota de zod 4: `.partial()` **no** quita los `.default()`, así que ningún campo de
 * `expenseFields` los usa — los defaults viven en el modelo (`active`). Si algún día se agrega
 * uno aquí, hay que re-declararlo como opcional puro después del `.partial()`, igual que hacen
 * `productUpdateSchema` y `couponUpdateSchema`.
 */
export const expenseUpdateSchema = z
  .object(expenseFields)
  .partial()
  .superRefine((d, ctx) => {
    for (const issue of expenseRuleIssues(d)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
    if (Object.keys(d).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "No hay nada que actualizar: manda al menos un campo.",
      });
    }
  });

export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;

/** Filtros del listado. Todo opcional; un valor inválido es un 400, no se ignora en silencio —
 *  a diferencia del catálogo público, aquí quien consulta es el dueño y un filtro que no aplicó
 *  le haría leer mal sus propios números. */
export const expenseListQuerySchema = z.object({
  from: dateOnlySchema("La fecha inicial del filtro").optional(),
  to: dateOnlySchema("La fecha final del filtro").optional(),
  category: z
    .enum(EXPENSE_CATEGORIES, {
      message: `La categoría debe ser una de: ${EXPENSE_CATEGORIES.join(", ")}`,
    })
    .optional(),
  active: z
    .enum(["true", "false"], { message: 'El filtro "active" debe ser true o false' })
    .transform((value) => value === "true")
    .optional(),
});

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthSchema = (label: string) =>
  z
    .string(`${label} es requerido`)
    .trim()
    .regex(MONTH_PATTERN, `${label} debe tener el formato AAAA-MM (por ejemplo 2026-08)`);

export const expenseHistoryQuerySchema = z.object({
  from: monthSchema("El mes inicial").optional(),
  to: monthSchema("El mes final").optional(),
});
