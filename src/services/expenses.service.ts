import { Op, type WhereOptions } from "sequelize";
import { sequelize } from "../config/database";
import { AppError } from "../middlewares/AppError";
import {
  Expense,
  type ExpenseAttributes,
  type ExpenseCategory,
  type ExpenseFrequency,
} from "../models/Expense";
import { ExpenseAmount } from "../models/ExpenseAmount";
import { Order, type OrderAttributes } from "../models/Order";
import type { ExpenseInput, ExpenseUpdateInput } from "../schemas/expense";
import {
  addDays,
  formatMonthLabel,
  isoDay,
  isoMonth,
  monthRange,
  utcDayFromIso,
  utcMonthStart,
} from "../utils/date";

/**
 * Gastos reales (Fase N.3) — el servicio que sustituye la constante `GASTOS_FIJOS = 2000` que
 * `dashboard.service.ts` restaba para calcular GANANCIA NETA.
 *
 * Aquí conviven **dos números distintos**, y confundirlos es el error caro de esta fase:
 *
 *  1. **El gasto real de un mes** (`buildHistory`): se generan las fechas de cargo y cada una se
 *     atribuye a su mes con el monto vigente EN ESA FECHA. Así una anualidad de dominio aparece
 *     completa en su mes de renovación y no untada a lo largo del año — que es lo correcto para
 *     responder "¿cuánto gasté en julio?".
 *  2. **La carga mensual normalizada** (`monthlyRunRate`): cada gasto recurrente convertido a su
 *     equivalente por mes. Responde "¿cuánto tengo que retirar cada mes para cubrir esto?" y es lo
 *     que el dashboard prorratea por `windowDays/30`, conservando la semántica que ya tenía.
 *
 * Todo se calcula en memoria: las dos tablas son de decenas de filas, no de miles.
 */

/** Ventana de "próximos cargos" que devuelve `/summary`. Un mes basta para responder */
/*  "qué se cobra pronto" sin adelantarse a fechas que todavía no importan. */
const UPCOMING_DAYS = 30;

/**
 * Cuánto pesa cada frecuencia en un mes.
 *
 * `weekly` es 52/12 y no 4: un año tiene 52 semanas, no 48, y usar 4 subestimaría el gasto anual
 * en casi un mes completo — justo el tipo de error silencioso que esta fase viene a quitar.
 * `once` vale 0 porque no es una carga recurrente: cuenta completo en su mes y nunca más.
 */
const MONTHLY_FACTOR: Record<ExpenseFrequency, number> = {
  once: 0,
  weekly: 52 / 12,
  monthly: 1,
  bimonthly: 1 / 2,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
};

/** Cuántos meses avanza cada cargo. `weekly` no está: avanza por días. */
const MONTHS_STEP: Partial<Record<ExpenseFrequency, number>> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

export interface ExpenseOccurrence {
  /** Día del cargo, `"YYYY-MM-DD"`. */
  date: string;
  amount: number;
}

export interface AmountVersionView {
  id: number;
  amount: number;
  effectiveFrom: string;
  note: string | null;
}

export interface ExpenseView extends ExpenseAttributes {
  /** Monto vigente hoy. Se **calcula** desde las versiones: no hay columna `amount`. */
  currentAmount: number;
  /** Equivalente mensual de este gasto (0 para los de única vez y los ya terminados). */
  monthlyRunRate: number;
  /** Próximo cargo a partir de hoy, o `null` si ya no habrá más. */
  nextChargeDate: string | null;
  amounts: AmountVersionView[];
}

export interface ExpenseSummary {
  /** Lo que hay que retirar cada mes de lo ganado para cubrir las suscripciones vivas. */
  monthlyRunRate: number;
  annualRunRate: number;
  activeCount: number;
  byCategory: Array<{ category: ExpenseCategory; count: number; monthlyRunRate: number }>;
  byFrequency: Array<{ frequency: ExpenseFrequency; count: number; monthlyRunRate: number }>;
  upcomingDays: number;
  upcomingTotal: number;
  upcomingCharges: Array<{
    expenseId: number;
    concept: string;
    vendor: string | null;
    category: ExpenseCategory;
    frequency: ExpenseFrequency;
    date: string;
    amount: number;
  }>;
  /** Envío pagado a la paquetería en el mes en curso, a la fecha. **No entra en `monthlyRunRate`,
   *  `annualRunRate`, `activeCount` ni `byCategory`** — ver `DerivedShippingCost`. */
  shippingCost: DerivedShippingCost;
}

export interface ExpenseMonthRow {
  expenseId: number;
  concept: string;
  vendor: string | null;
  category: ExpenseCategory;
  frequency: ExpenseFrequency;
  occurrences: number;
  amount: number;
}

export interface ExpenseMonthChange {
  expenseId: number;
  concept: string;
  vendor: string | null;
  category: ExpenseCategory;
  effectiveFrom: string;
  previousAmount: number;
  amount: number;
  note: string | null;
}

export interface ExpenseMonth {
  isoMonth: string;
  label: string;
  /** El mes en curso todavía no termina: su total puede crecer. Mismo criterio que el reporte
   *  mensual de ventas (`reports.service.ts`). */
  partial: boolean;
  total: number;
  byCategory: Array<{ category: ExpenseCategory; amount: number }>;
  byExpense: ExpenseMonthRow[];
  /** Los cambios de precio que entraron en vigor este mes. **Este arreglo es la respuesta a
   *  "¿algo cambió?"**: sin él, un aumento de Render solo se nota como un total más alto sin
   *  causa visible. Se devuelve crudo (`previousAmount` → `amount`); el delta y el % los calcula
   *  el front, como el resto de métricas derivadas (ver CLAUDE.md). */
  changes: ExpenseMonthChange[];
  /** Envío pagado a la paquetería ese mes. **Fuera de `total`/`byCategory`/`byExpense`** — ver
   *  `DerivedShippingCost`. */
  shippingCost: DerivedShippingCost;
}

/**
 * Envío pagado a la paquetería, **derivado de `Order.shipping`**: no hay filas `Expense`/
 * `ExpenseAmount` detrás, no se puede editar ni borrar, y no aparece en el listado del CRUD.
 *
 * **Por qué se calcula y no se persiste.** Una fila por pedido serían ~900 al mes a 30 ventas
 * diarias: inundaría el `activeCount` y el `byCategory` de `/summary`, el `byExpense` de
 * `/history` y la lista editable del panel — todo para representar algo que ya está en `orders`.
 * Las dos tablas de gastos son de decenas de filas justamente porque las captura un humano.
 *
 * **Por qué va FUERA de `total`/`byCategory`/`monthlyRunRate`.** El dashboard ya lo resta en
 * GANANCIA BRUTA (es costo de venta, no gasto: se paga una guía por pedido, igual que el
 * `unitCost` de cada pieza). Como `GANANCIA OPERATIVA = BRUTA − GASTOS`, sumarlo también a los
 * totales de gastos lo restaría **dos veces**. Se expone aparte para que el dueño lo *vea* —es su
 * segundo costo más grande después del producto— sin que los dos números se contradigan.
 *
 * ⚠️ **Regla que hay que respetar al capturar gastos:** cajas y empaque **sí** van como `Expense`
 * de categoría `paqueteria`; **las guías no**, ya están aquí. Ver el comentario en
 * `src/models/Expense.ts`.
 */
export interface DerivedShippingCost {
  category: "paqueteria";
  /** Siempre `true`: derivado de `orders`, sin fila editable detrás. */
  derived: true;
  /** Siempre `true`: ya restado en GANANCIA BRUTA. El consumidor no debe volver a restarlo. */
  includedInGrossProfit: true;
  /** Ventana cubierta, días de calendario UTC, ambos inclusive. */
  from: string;
  to: string;
  /** La ventana no ha terminado: el monto puede crecer. Mismo criterio que `ExpenseMonth.partial`. */
  partial: boolean;
  amount: number;
  /** Cuántos pedidos pagados lo generaron. Sin esto un `amount` raro no se puede sanity-checkear. */
  orders: number;
}

/** Envío agregado por mes UTC (`"YYYY-MM"`), para inyectarlo en las funciones puras. */
export type ShippingByMonth = Map<string, { amount: number; orders: number }>;

// ── Helpers puros ───────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Arma la línea derivada de un mes. Devuelve **cero, nunca ausente** (misma regla que el KPI de
 * cupones y que los meses en `$0` del historial: un campo faltante se leería como "no hay dato"
 * en vez de "no hubo envíos").
 */
function shippingLine(
  isoMonthKey: string,
  todayIso: string,
  currentMonth: string,
  shippingByMonth: ShippingByMonth,
): DerivedShippingCost {
  const entry = shippingByMonth.get(isoMonthKey);
  const partial = isoMonthKey === currentMonth;
  const monthStart = utcDayFromIso(`${isoMonthKey}-01`);
  const monthEnd = isoDay(
    new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)),
  );
  return {
    category: "paqueteria",
    derived: true,
    includedInGrossProfit: true,
    from: `${isoMonthKey}-01`,
    // En el mes en curso la ventana llega hasta hoy y no hasta fin de mes: `from`/`to`/`partial`
    // son lo que evita que un acumulado a media quincena se lea contra un `monthlyRunRate` de mes
    // completo y parezca que el envío sale baratísimo.
    to: partial ? todayIso : monthEnd,
    partial,
    amount: round2(entry?.amount ?? 0),
    orders: entry?.orders ?? 0,
  };
}

/**
 * Suma meses conservando el día del mes original y **clampeando al último día del mes destino**.
 *
 * Sin el clamp, una suscripción que arranca el 31 de enero avanzada con `setUTCMonth(+1)` se
 * desborda al 3 de marzo, y de ahí en adelante TODAS las fechas quedan corridas. Por eso las
 * ocurrencias se generan por índice desde `startsAt` (`n × paso`) y nunca iterando sobre la fecha
 * ya calculada: iterar perdería el día 31 en cuanto pasara por febrero y no lo recuperaría nunca.
 */
function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const day = anchor.getUTCDate();
  // Día 0 del mes siguiente = último día del mes destino.
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)));
}

function sortedAmounts(expense: Expense): ExpenseAmount[] {
  return [...(expense.amounts ?? [])].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
}

/**
 * Monto vigente en una fecha: la versión con el `effectiveFrom` más grande que ya empezó.
 *
 * Las fechas son `"YYYY-MM-DD"`, así que la comparación de strings ya es cronológica.
 *
 * Si la fecha es **anterior a la primera versión** se devuelve esa primera versión, no `0`: eso
 * solo pasa cuando el dueño fechó el primer monto después del arranque del gasto, y decir que ese
 * cargo fue gratis sería peor que usar el único precio que conocemos. Un gasto sin ninguna versión
 * no debería existir (`createExpense` siempre escribe una) y vale 0.
 */
export function amountAt(expense: Expense, date: string): number {
  const versions = sortedAmounts(expense);
  if (versions.length === 0) return 0;

  let current = versions[0];
  for (const version of versions) {
    if (version.effectiveFrom <= date) current = version;
    else break;
  }
  return current.amount;
}

/**
 * Hasta cuándo genera cargos el gasto.
 *
 * `endsAt` manda. Un gasto marcado inactivo **sin** `endsAt` no debería existir —`updateExpense` y
 * `deleteExpense` escriben la fecha al apagarlo, justamente para que "hasta cuándo cobró" sea un
 * dato y no una inferencia sobre `updatedAt` (que cualquier otro edit bumpea; la lección de
 * `shipmentClaimedAt` en la Fase O.3)— pero si aparece uno editado a mano, se corta hoy en vez de
 * seguir cobrando para siempre.
 */
function effectiveEnd(expense: Expense, today: string): string | null {
  if (expense.endsAt) return expense.endsAt;
  return expense.active ? null : today;
}

/**
 * Las fechas de cargo del gasto dentro de `[from, to]` (ambos inclusive), con el monto vigente en
 * cada una.
 *
 * `today` decide el corte de un gasto inactivo sin `endsAt`; los cargos **futuros** sí se generan
 * (es lo que alimenta "próximos cargos" en `/summary`).
 */
export function occurrencesBetween(
  expense: Expense,
  from: string,
  to: string,
  today: string,
): ExpenseOccurrence[] {
  const end = effectiveEnd(expense, today);
  const limit = end && end < to ? end : to;
  if (limit < expense.startsAt || limit < from) return [];

  const occurrences: ExpenseOccurrence[] = [];
  const push = (date: string) => {
    if (date >= from && date <= limit) {
      occurrences.push({ date, amount: amountAt(expense, date) });
    }
  };

  if (expense.frequency === "once") {
    push(expense.startsAt);
    return occurrences;
  }

  const anchor = utcDayFromIso(expense.startsAt);
  const monthsStep = MONTHS_STEP[expense.frequency];

  for (let n = 0; ; n += 1) {
    const date = monthsStep
      ? addMonthsClamped(anchor, n * monthsStep)
      : addDays(anchor, n * 7); // weekly
    const key = isoDay(date);
    if (key > limit) break;
    push(key);
  }

  return occurrences;
}

/**
 * Equivalente mensual del gasto en una fecha dada: lo que hay que apartar cada mes para cubrirlo.
 *
 * Vale 0 para los de única vez (no son carga recurrente), para los que aún no arrancan y para los
 * que ya terminaron — de otro modo, cancelar una suscripción no bajaría el monto a retirar.
 */
export function monthlyRunRate(expense: Expense, at: string): number {
  if (expense.frequency === "once") return 0;
  if (expense.startsAt > at) return 0;
  // `active` se consulta aquí y no vía `effectiveEnd` a propósito: al apagar un gasto se le fija
  // `endsAt` en HOY, y como `endsAt` es inclusivo (un cargo fechado ese día sí cuenta) el gasto
  // seguiría sumando a la carga mensual el día entero de su cancelación. Para las ocurrencias ese
  // inclusivo es correcto; para "cuánto tengo que retirar de aquí en adelante" no lo es.
  if (!expense.active) return 0;
  if (expense.endsAt && expense.endsAt < at) return 0;
  return amountAt(expense, at) * MONTHLY_FACTOR[expense.frequency];
}

/** Carga mensual total de una lista de gastos, en una fecha dada. */
export function totalMonthlyRunRate(expenses: Expense[], at: string): number {
  return expenses.reduce((acc, expense) => acc + monthlyRunRate(expense, at), 0);
}

/**
 * Gastos de **única vez** indexados por día, para que el dashboard los sume en el mismo recorrido
 * día-por-día que ya hace sobre sus ventanas (y así la ventana previa tenga su propio total en vez
 * de reusar el de la actual).
 */
export function oneTimeExpensesByDay(expenses: Expense[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const expense of expenses) {
    if (expense.frequency !== "once") continue;
    const amount = amountAt(expense, expense.startsAt);
    byDay.set(expense.startsAt, (byDay.get(expense.startsAt) ?? 0) + amount);
  }
  return byDay;
}

/** Primer cargo a partir de `from` (incluido), o `null` si el gasto ya no volverá a cobrar. */
export function nextChargeDate(expense: Expense, from: string): string | null {
  const horizon = isoDay(addDays(utcDayFromIso(from), 366 * 2));
  const [next] = occurrencesBetween(expense, from, horizon, from);
  return next?.date ?? null;
}

// ── Agregación: historial y resumen ─────────────────────────────────────────────

export function buildHistory(
  expenses: Expense[],
  fromMonth: Date,
  toMonth: Date,
  today: Date,
  // Se **inyecta** en vez de consultarse aquí adentro: esta función es pura sobre `Expense[]` y sus
  // tests unitarios la llaman sin tocar la BD. La consulta vive en `getExpenseHistory`, que ya hace
  // acceso a datos. El default deja intacto a todo llamador existente (lee cero).
  shippingByMonth: ShippingByMonth = new Map(),
): ExpenseMonth[] {
  const todayIso = isoDay(today);
  const currentMonth = isoMonth(today);
  const months = monthRange(fromMonth, toMonth);
  if (months.length === 0) return [];

  const rangeStart = isoDay(months[0]);
  const lastMonth = months[months.length - 1];
  const rangeEnd = isoDay(
    new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0)),
  );

  // Un solo recorrido: cada gasto aporta sus ocurrencias y sus cambios de precio al mes que les
  // toca, en vez de re-generar el calendario por cada mes del rango.
  const rowsByMonth = new Map<string, Map<number, ExpenseMonthRow>>();
  const changesByMonth = new Map<string, ExpenseMonthChange[]>();

  for (const expense of expenses) {
    for (const occurrence of occurrencesBetween(expense, rangeStart, rangeEnd, todayIso)) {
      const key = occurrence.date.slice(0, 7);
      let rows = rowsByMonth.get(key);
      if (!rows) {
        rows = new Map();
        rowsByMonth.set(key, rows);
      }
      let row = rows.get(expense.id);
      if (!row) {
        row = {
          expenseId: expense.id,
          concept: expense.concept,
          vendor: expense.vendor,
          category: expense.category,
          frequency: expense.frequency,
          occurrences: 0,
          amount: 0,
        };
        rows.set(expense.id, row);
      }
      row.occurrences += 1;
      row.amount += occurrence.amount;
    }

    // La primera versión no es un cambio de precio: es el alta del gasto. Solo cuentan las
    // posteriores, que son las que responden "esto costaba otra cosa antes".
    const versions = sortedAmounts(expense);
    for (let i = 1; i < versions.length; i += 1) {
      const version = versions[i];
      if (version.effectiveFrom < rangeStart || version.effectiveFrom > rangeEnd) continue;
      const key = version.effectiveFrom.slice(0, 7);
      const list = changesByMonth.get(key) ?? [];
      list.push({
        expenseId: expense.id,
        concept: expense.concept,
        vendor: expense.vendor,
        category: expense.category,
        effectiveFrom: version.effectiveFrom,
        previousAmount: versions[i - 1].amount,
        amount: version.amount,
        note: version.note,
      });
      changesByMonth.set(key, list);
    }
  }

  return months.map((monthDate) => {
    const key = isoMonth(monthDate);
    const rows = Array.from(rowsByMonth.get(key)?.values() ?? []).sort(
      (a, b) => b.amount - a.amount,
    );

    const byCategory = new Map<ExpenseCategory, number>();
    let total = 0;
    for (const row of rows) {
      total += row.amount;
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount);
    }

    return {
      isoMonth: key,
      label: formatMonthLabel(monthDate),
      partial: key === currentMonth,
      total: round2(total),
      byCategory: Array.from(byCategory.entries())
        .map(([category, amount]) => ({ category, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      byExpense: rows.map((row) => ({ ...row, amount: round2(row.amount) })),
      changes: (changesByMonth.get(key) ?? []).sort((a, b) =>
        a.effectiveFrom < b.effectiveFrom ? -1 : 1,
      ),
      // Deliberadamente NO entra en `total` ni en `byCategory` de arriba: el dashboard ya lo restó
      // en GANANCIA BRUTA.
      shippingCost: shippingLine(key, todayIso, currentMonth, shippingByMonth),
    };
  });
}

export function buildSummary(
  expenses: Expense[],
  today: Date,
  // Inyectado, por lo mismo que en `buildHistory`: mantener esta función pura y testeable sin BD.
  shippingByMonth: ShippingByMonth = new Map(),
): ExpenseSummary {
  const todayIso = isoDay(today);
  const horizon = isoDay(addDays(today, UPCOMING_DAYS));

  const byCategory = new Map<ExpenseCategory, { count: number; monthlyRunRate: number }>();
  const byFrequency = new Map<ExpenseFrequency, { count: number; monthlyRunRate: number }>();
  const upcomingCharges: ExpenseSummary["upcomingCharges"] = [];
  let monthly = 0;
  let activeCount = 0;

  for (const expense of expenses) {
    const rate = monthlyRunRate(expense, todayIso);
    monthly += rate;

    // "Activo" aquí es "sigue generando cargos", no solo la bandera: un gasto con `endsAt` en el
    // pasado está apagado aunque `active` siga en true.
    const stillCharging = expense.active && (!expense.endsAt || expense.endsAt >= todayIso);
    if (stillCharging) activeCount += 1;

    const category = byCategory.get(expense.category) ?? { count: 0, monthlyRunRate: 0 };
    category.count += 1;
    category.monthlyRunRate += rate;
    byCategory.set(expense.category, category);

    const frequency = byFrequency.get(expense.frequency) ?? { count: 0, monthlyRunRate: 0 };
    frequency.count += 1;
    frequency.monthlyRunRate += rate;
    byFrequency.set(expense.frequency, frequency);

    for (const occurrence of occurrencesBetween(expense, todayIso, horizon, todayIso)) {
      upcomingCharges.push({
        expenseId: expense.id,
        concept: expense.concept,
        vendor: expense.vendor,
        category: expense.category,
        frequency: expense.frequency,
        date: occurrence.date,
        amount: round2(occurrence.amount),
      });
    }
  }

  upcomingCharges.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    monthlyRunRate: round2(monthly),
    annualRunRate: round2(monthly * 12),
    activeCount,
    byCategory: Array.from(byCategory.entries())
      .map(([category, agg]) => ({ category, ...agg, monthlyRunRate: round2(agg.monthlyRunRate) }))
      .sort((a, b) => b.monthlyRunRate - a.monthlyRunRate),
    byFrequency: Array.from(byFrequency.entries())
      .map(([frequency, agg]) => ({ frequency, ...agg, monthlyRunRate: round2(agg.monthlyRunRate) }))
      .sort((a, b) => b.monthlyRunRate - a.monthlyRunRate),
    upcomingDays: UPCOMING_DAYS,
    upcomingTotal: round2(upcomingCharges.reduce((acc, c) => acc + c.amount, 0)),
    upcomingCharges,
    // Mes calendario en curso, a la fecha (siempre `partial: true`). Fuera de `monthlyRunRate` y
    // de `byCategory` a propósito: el dashboard ya lo restó en GANANCIA BRUTA.
    shippingCost: shippingLine(isoMonth(today), todayIso, isoMonth(today), shippingByMonth),
  };
}

// ── Acceso a datos y CRUD ───────────────────────────────────────────────────────

const amountsInclude = {
  model: ExpenseAmount,
  as: "amounts",
} as const;

/** Carga los gastos con todas sus versiones de monto. Las dos tablas son diminutas: no hay
 *  filtro por fecha en SQL porque el cálculo de ocurrencias necesita el historial completo. */
export async function loadExpenses(
  where?: WhereOptions<ExpenseAttributes>,
): Promise<Expense[]> {
  return Expense.findAll({
    ...(where ? { where } : {}),
    include: [amountsInclude],
    order: [["id", "DESC"]],
  });
}

/**
 * Envío pagado a la paquetería, agregado por mes UTC — la fuente de la línea derivada
 * (`DerivedShippingCost`). `to` es **exclusivo**.
 *
 * `paymentStatus: "paid"` y **no** `status`, el mismo predicado que el dashboard: un pedido
 * `shipped`/`delivered` sigue siendo una venta con su guía pagada, y un `refunded`/`failed` sale
 * solo. Consecuencia asumida: en un reembolso la guía normalmente ya se pagó, así que esta línea
 * **subestima** por esos pedidos — misma dirección que el sesgo que ya tienen ingresos y COGS.
 *
 * ⚠️ **Sin `raw: true`.** `Order.shipping` es `DECIMAL(10,2)` y el `parseFloat` que lo vuelve
 * número vive en el getter del modelo, que `raw` no ejecuta: devolvería el string `"150.00"` y la
 * suma **concatenaría** en vez de sumar.
 */
export async function loadShippingByMonth(
  from: Date,
  toExclusive: Date,
): Promise<ShippingByMonth> {
  const orders = await Order.findAll({
    where: {
      paymentStatus: "paid",
      createdAt: { [Op.gte]: from, [Op.lt]: toExclusive },
    } as WhereOptions<OrderAttributes>,
    attributes: ["createdAt", "shipping"],
  });

  const byMonth: ShippingByMonth = new Map();
  for (const order of orders) {
    // Mismo bucketing UTC que el dashboard, para que los dos paneles nunca partan el mes distinto.
    const key = isoMonth(order.createdAt);
    const entry = byMonth.get(key) ?? { amount: 0, orders: 0 };
    entry.amount += order.shipping;
    entry.orders += 1;
    byMonth.set(key, entry);
  }
  return byMonth;
}

function toView(expense: Expense, today: string): ExpenseView {
  return {
    ...(expense.toJSON() as ExpenseAttributes),
    currentAmount: round2(amountAt(expense, today)),
    monthlyRunRate: round2(monthlyRunRate(expense, today)),
    nextChargeDate: nextChargeDate(expense, today),
    amounts: sortedAmounts(expense).map((version) => ({
      id: version.id,
      amount: version.amount,
      effectiveFrom: version.effectiveFrom,
      note: version.note,
    })),
  };
}

export interface ExpenseListFilters {
  /** Rango de **fechas de cargo**: deja solo los gastos que cobran algo dentro de él. Se filtra
   *  por cargos y no por `createdAt` porque "qué me cobraron en agosto" es la pregunta real; un
   *  gasto dado de alta en enero y vigente desde entonces tiene que salir en agosto. */
  from?: string;
  to?: string;
  category?: ExpenseCategory;
  active?: boolean;
}

export async function listExpenses(
  filters: ExpenseListFilters = {},
): Promise<ExpenseView[]> {
  const today = isoDay(new Date());
  const where: WhereOptions<ExpenseAttributes> = {
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.active !== undefined ? { active: filters.active } : {}),
  };

  const expenses = await loadExpenses(Object.keys(where).length ? where : undefined);

  const filtered =
    filters.from || filters.to
      ? expenses.filter(
          (expense) =>
            occurrencesBetween(
              expense,
              filters.from ?? "0000-01-01",
              filters.to ?? "9999-12-31",
              today,
            ).length > 0,
        )
      : expenses;

  return filtered.map((expense) => toView(expense, today));
}

async function findExpenseOr404(id: number): Promise<Expense> {
  const expense = await Expense.findByPk(id, { include: [amountsInclude] });
  if (!expense) {
    throw new AppError(
      "Ese gasto ya no existe. Recarga la página para ver la lista actualizada.",
      404,
    );
  }
  return expense;
}

export async function createExpense(input: ExpenseInput): Promise<ExpenseView> {
  const { amount, amountEffectiveFrom, amountNote, ...fields } = input;

  const expense = await sequelize.transaction(async (t) => {
    const created = await Expense.create(fields, { transaction: t });
    await ExpenseAmount.create(
      {
        expenseId: created.id,
        amount,
        // El primer monto rige desde que arranca el gasto, no desde hoy: si el dueño registra
        // en agosto una suscripción que empezó en marzo, los cargos de marzo a julio tienen que
        // valer ese monto y no quedar sin versión que los cubra.
        effectiveFrom: amountEffectiveFrom ?? created.startsAt,
        note: amountNote ?? null,
      },
      { transaction: t },
    );
    return created;
  });

  return toView(await findExpenseOr404(expense.id), isoDay(new Date()));
}

/**
 * Edita el gasto.
 *
 * Lo que hace especial a este `PUT` es el monto: **no se sobrescribe, se versiona**. Tres casos:
 *
 *  - el monto no cambia → no se escribe versión (editar el concepto no debe ensuciar el historial
 *    de precios con un "cambio" que no cambió nada);
 *  - ya existe una versión con esa misma fecha de vigencia → se **corrige en su lugar** (es el
 *    dueño arreglando lo que acaba de capturar, no un cambio de precio nuevo). El índice único
 *    `(expenseId, effectiveFrom)` es lo que hace que este caso sea detectable;
 *  - si no → se **agrega** una versión, y eso es exactamente lo que el historial reporta como
 *    "algo cambió".
 */
export async function updateExpense(
  id: number,
  input: ExpenseUpdateInput,
): Promise<ExpenseView> {
  const expense = await findExpenseOr404(id);
  const today = isoDay(new Date());
  const { amount, amountEffectiveFrom, amountNote, ...fields } = input;

  // Los refines del schema solo ven el body, así que un `PUT` que manda solo `endsAt` no puede
  // compararlo contra el `startsAt` guardado. Se re-valida contra el estado combinado, que es el
  // real (mismo patrón que `updateCoupon`).
  const merged = {
    frequency: fields.frequency ?? expense.frequency,
    startsAt: fields.startsAt ?? expense.startsAt,
    endsAt: fields.endsAt !== undefined ? fields.endsAt : expense.endsAt,
    active: fields.active ?? expense.active,
  };
  if (merged.endsAt && merged.endsAt < merged.startsAt) {
    throw new AppError(
      "La fecha de término no puede ser anterior a la del primer cargo.",
      400,
    );
  }
  if (merged.frequency === "once" && merged.endsAt) {
    throw new AppError(
      "Un gasto de única vez no lleva fecha de término: se cobra una sola vez en su fecha.",
      400,
    );
  }

  const patch: Partial<ExpenseAttributes> = { ...fields };

  // `active` y `endsAt` se mantienen coherentes: apagar un gasto sin decir desde cuándo dejaría
  // "hasta cuándo cobró" a merced de `updatedAt`, que cualquier otro edit bumpea (la lección de
  // `shipmentClaimedAt`, Fase O.3). Y reactivar sin limpiar un `endsAt` viejo daría un gasto
  // "activo" que no cobra nada — activo en la pantalla, muerto en los números.
  if (fields.active === false && !merged.endsAt && merged.frequency !== "once") {
    patch.endsAt = today;
  }
  if (fields.active === true && fields.endsAt === undefined && expense.endsAt) {
    patch.endsAt = null;
  }

  await sequelize.transaction(async (t) => {
    if (Object.keys(patch).length > 0) {
      await expense.update(patch, { transaction: t });
    }

    if (amount === undefined) return;

    const effectiveFrom = amountEffectiveFrom ?? today;
    const versions = sortedAmounts(expense);
    const sameDate = versions.find((v) => v.effectiveFrom === effectiveFrom);

    if (sameDate) {
      if (sameDate.amount === amount && amountNote === undefined) return;
      await sameDate.update(
        { amount, ...(amountNote !== undefined ? { note: amountNote } : {}) },
        { transaction: t },
      );
      return;
    }

    if (amountAt(expense, effectiveFrom) === amount) return;

    await ExpenseAmount.create(
      { expenseId: expense.id, amount, effectiveFrom, note: amountNote ?? null },
      { transaction: t },
    );
  });

  return toView(await findExpenseOr404(id), today);
}

/**
 * Borrado admin con el criterio de `deleteCoupon`/`adminDeleteProduct`: si el gasto **ya generó
 * algún cargo** se **desactiva** (y se le fija `endsAt` hoy), porque ese dinero se gastó y borrarlo
 * dejaría el historial mintiendo sobre meses cerrados. Solo se borra de verdad lo que nunca cobró
 * nada — un alta equivocada o un gasto programado a futuro.
 */
export async function deleteExpense(
  id: number,
): Promise<{ ok: true; deactivated: boolean }> {
  const expense = await findExpenseOr404(id);
  const today = isoDay(new Date());

  const charged = occurrencesBetween(expense, "0000-01-01", today, today).length > 0;
  if (charged) {
    await expense.update({
      active: false,
      endsAt: expense.endsAt ?? today,
    });
    return { ok: true, deactivated: true };
  }

  // Las versiones de monto se van por `onDelete: "CASCADE"`.
  await expense.destroy();
  return { ok: true, deactivated: false };
}

export async function getExpenseSummary(): Promise<ExpenseSummary> {
  // Un solo `now` para todo: si los límites del mes y el `today` de `buildSummary` se tomaran por
  // separado, una llamada a las 23:59:59.9 podría cruzar la medianoche entre uno y otro y pedir el
  // envío de un mes distinto al que se está resumiendo.
  const now = new Date();
  const monthStart = utcMonthStart(now);
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [expenses, shippingByMonth] = await Promise.all([
    loadExpenses(),
    loadShippingByMonth(monthStart, nextMonthStart),
  ]);
  return buildSummary(expenses, now, shippingByMonth);
}

/**
 * Historial mes con mes. Sin `from`/`to` arranca en el mes del gasto más viejo y termina en el mes
 * en curso, sin huecos (los meses sin gasto salen en `$0`, igual que `revenueByPeriod` nunca salta
 * días) — un mes faltante se leería como "no hubo gastos" en vez de "no hay dato".
 */
export async function getExpenseHistory(
  fromMonth?: string,
  toMonth?: string,
): Promise<ExpenseMonth[]> {
  const expenses = await loadExpenses();
  const now = new Date();

  const earliest = expenses.reduce<string | null>(
    (min, expense) => (min === null || expense.startsAt < min ? expense.startsAt : min),
    null,
  );

  const from = fromMonth
    ? utcDayFromIso(`${fromMonth}-01`)
    : utcMonthStart(earliest ? utcDayFromIso(earliest) : now);
  const to = toMonth ? utcDayFromIso(`${toMonth}-01`) : utcMonthStart(now);

  // Secuencial y no en `Promise.all` con `loadExpenses`: el rango depende de `earliest`, que sale
  // de los gastos ya cargados. El límite superior es el primer día del mes SIGUIENTE al último
  // pedido, y es exclusivo a propósito: un `createdAt` futuro (reloj desfasado, fila sembrada a
  // mano) caería si no en un mes que el llamador nunca pidió.
  const toExclusive = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 1));
  const shippingByMonth = await loadShippingByMonth(from, toExclusive);

  return buildHistory(expenses, from, to, now, shippingByMonth);
}
