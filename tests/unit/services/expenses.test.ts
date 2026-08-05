/**
 * Fase N.3 — invariantes de expenses.service.ts. Nivel 1: sin BD ni HTTP.
 *
 * Las filas se construyen con `Model.build(...)` (nunca `.create()`) y las versiones de monto se
 * asignan a mano a `.amounts`, igual que `dashboard.test.ts` hace con `.items` — es lo que el
 * servicio lee, y no requiere un `include` real de Sequelize.
 */
import { Expense } from "../../../src/models/Expense";
import { ExpenseAmount } from "../../../src/models/ExpenseAmount";
import {
  amountAt,
  buildHistory,
  buildSummary,
  monthlyRunRate,
  nextChargeDate,
  occurrencesBetween,
  oneTimeExpensesByDay,
  totalMonthlyRunRate,
} from "../../../src/services/expenses.service";

let nextId = 1;

function buildExpense(overrides: {
  id?: number;
  concept?: string;
  category?: any;
  frequency?: any;
  startsAt?: string;
  endsAt?: string | null;
  active?: boolean;
  /** Versiones de monto: `[monto, desdeCuándo]`. Si no se pasa `effectiveFrom`, rige desde `startsAt`. */
  amounts?: Array<{ amount: number; effectiveFrom?: string; note?: string }>;
} = {}): Expense {
  const startsAt = overrides.startsAt ?? "2026-01-15";
  const expense = Expense.build({
    id: overrides.id ?? nextId++,
    concept: overrides.concept ?? "Render — Web Service",
    vendor: null,
    category: overrides.category ?? "infraestructura",
    frequency: overrides.frequency ?? "monthly",
    startsAt,
    endsAt: overrides.endsAt ?? null,
    active: overrides.active ?? true,
    notes: null,
  } as any);

  expense.amounts = (overrides.amounts ?? [{ amount: 290 }]).map((version, index) =>
    ExpenseAmount.build({
      id: index + 1,
      expenseId: expense.id,
      amount: version.amount,
      effectiveFrom: version.effectiveFrom ?? startsAt,
      note: version.note ?? null,
    } as any),
  );

  return expense;
}

const TODAY = "2026-07-30";

describe("expenses.service — ocurrencias (Fase N.3)", () => {
  it("una mensual genera un cargo por mes, conservando el día", () => {
    const expense = buildExpense({ frequency: "monthly", startsAt: "2026-01-15" });

    const dates = occurrencesBetween(expense, "2026-01-01", "2026-04-30", TODAY).map((o) => o.date);

    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
  });

  it("una mensual que arranca el 31 CLAMPEA a fin de mes y RECUPERA el día 31 después", () => {
    // El bug clásico: iterar con setUTCMonth(+1) desde el 31 de enero desborda al 3 de marzo, y
    // si además se itera sobre la fecha ya calculada (28 de feb → 28 de mar) el día 31 se pierde
    // para siempre. Las ocurrencias se generan por índice desde `startsAt`, justo para esto.
    const expense = buildExpense({ frequency: "monthly", startsAt: "2026-01-31" });

    const dates = occurrencesBetween(expense, "2026-01-01", "2026-05-31", TODAY).map((o) => o.date);

    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-28", // febrero no tiene 31 → último día
      "2026-03-31", // y aquí vuelve el 31: no se arrastró el clamp
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("una semanal avanza de 7 en 7", () => {
    const expense = buildExpense({ frequency: "weekly", startsAt: "2026-03-02" });

    const dates = occurrencesBetween(expense, "2026-03-01", "2026-03-31", TODAY).map((o) => o.date);

    expect(dates).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
      "2026-03-30",
    ]);
  });

  it("una anual cae completa en su mes de renovación, no untada en el año", () => {
    const expense = buildExpense({ frequency: "yearly", startsAt: "2025-04-10", amounts: [{ amount: 250 }] });

    const dates = occurrencesBetween(expense, "2025-01-01", "2027-12-31", TODAY).map((o) => o.date);

    expect(dates).toEqual(["2025-04-10", "2026-04-10", "2027-04-10"]);
  });

  it("una de única vez cobra solo en su fecha", () => {
    const expense = buildExpense({ frequency: "once", startsAt: "2026-06-20", amounts: [{ amount: 1500 }] });

    expect(occurrencesBetween(expense, "2026-01-01", "2026-12-31", TODAY)).toEqual([
      { date: "2026-06-20", amount: 1500 },
    ]);
    expect(occurrencesBetween(expense, "2026-07-01", "2026-12-31", TODAY)).toEqual([]);
  });

  it("endsAt corta los cargos posteriores pero CONSERVA los anteriores", () => {
    const expense = buildExpense({
      frequency: "monthly",
      startsAt: "2026-01-15",
      endsAt: "2026-03-20",
    });

    const dates = occurrencesBetween(expense, "2026-01-01", "2026-06-30", TODAY).map((o) => o.date);

    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("un gasto inactivo sin endsAt deja de cobrar desde hoy, sin borrar su pasado", () => {
    // Fila editada a mano: `updateExpense`/`deleteExpense` siempre escriben `endsAt` al apagar.
    const expense = buildExpense({
      frequency: "monthly",
      startsAt: "2026-01-15",
      active: false,
    });

    const dates = occurrencesBetween(expense, "2026-01-01", "2026-12-31", TODAY).map((o) => o.date);

    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15", "2026-07-15"]);
  });

  it("nextChargeDate devuelve el primer cargo desde la fecha dada, y null si ya no habrá más", () => {
    const vivo = buildExpense({ frequency: "monthly", startsAt: "2026-01-15" });
    const terminado = buildExpense({
      frequency: "monthly",
      startsAt: "2026-01-15",
      endsAt: "2026-03-20",
    });

    expect(nextChargeDate(vivo, TODAY)).toBe("2026-08-15");
    expect(nextChargeDate(terminado, TODAY)).toBeNull();
  });
});

describe("expenses.service — versionado del monto (Fase N.3)", () => {
  const conCambio = () =>
    buildExpense({
      frequency: "monthly",
      startsAt: "2026-01-15",
      amounts: [
        { amount: 290, effectiveFrom: "2026-01-15" },
        { amount: 340, effectiveFrom: "2026-06-01" },
      ],
    });

  it("cada fecha toma la versión vigente en ella", () => {
    const expense = conCambio();

    expect(amountAt(expense, "2026-03-15")).toBe(290);
    expect(amountAt(expense, "2026-05-31")).toBe(290);
    expect(amountAt(expense, "2026-06-01")).toBe(340); // inclusive el día de vigencia
    expect(amountAt(expense, "2026-09-15")).toBe(340);
  });

  it("una fecha anterior a la primera versión usa esa primera, no 0", () => {
    // Solo pasa si el dueño fechó el primer monto después del arranque del gasto; decir que ese
    // cargo fue gratis sería peor que usar el único precio que conocemos.
    const expense = buildExpense({
      startsAt: "2026-01-15",
      amounts: [{ amount: 290, effectiveFrom: "2026-03-01" }],
    });

    expect(amountAt(expense, "2026-01-15")).toBe(290);
  });

  it("un aumento NO reescribe los cargos anteriores", () => {
    const expense = conCambio();

    const byDate = new Map(
      occurrencesBetween(expense, "2026-01-01", "2026-07-31", TODAY).map((o) => [o.date, o.amount]),
    );

    expect(byDate.get("2026-05-15")).toBe(290);
    expect(byDate.get("2026-06-15")).toBe(340);
  });
});

describe("expenses.service — carga mensual (Fase N.3)", () => {
  it("convierte cada frecuencia a su equivalente mensual", () => {
    const rate = (frequency: string, amount: number) =>
      monthlyRunRate(
        buildExpense({ frequency, startsAt: "2026-01-01", amounts: [{ amount }] }),
        TODAY,
      );

    expect(rate("monthly", 300)).toBe(300);
    expect(rate("yearly", 1200)).toBe(100);
    expect(rate("quarterly", 300)).toBe(100);
    expect(rate("semiannual", 600)).toBe(100);
    expect(rate("bimonthly", 200)).toBe(100);
    // 52 semanas al año, no 48: usar 4 subestimaría el gasto anual en casi un mes.
    expect(rate("weekly", 100)).toBeCloseTo((100 * 52) / 12, 6);
  });

  it("los de única vez NO son carga recurrente", () => {
    const expense = buildExpense({ frequency: "once", startsAt: "2026-06-20", amounts: [{ amount: 1500 }] });

    expect(monthlyRunRate(expense, TODAY)).toBe(0);
  });

  it("un gasto que aún no arranca o que ya terminó no cuenta", () => {
    const futuro = buildExpense({ startsAt: "2026-12-01" });
    const terminado = buildExpense({ startsAt: "2026-01-15", endsAt: "2026-03-20" });

    expect(monthlyRunRate(futuro, TODAY)).toBe(0);
    expect(monthlyRunRate(terminado, TODAY)).toBe(0);
    expect(totalMonthlyRunRate([futuro, terminado, buildExpense()], TODAY)).toBe(290);
  });

  it("oneTimeExpensesByDay indexa solo los de única vez, sumando los del mismo día", () => {
    const byDay = oneTimeExpensesByDay([
      buildExpense({ frequency: "once", startsAt: "2026-06-20", amounts: [{ amount: 1500 }] }),
      buildExpense({ frequency: "once", startsAt: "2026-06-20", amounts: [{ amount: 500 }] }),
      buildExpense({ frequency: "monthly", startsAt: "2026-06-20" }),
    ]);

    expect(byDay.get("2026-06-20")).toBe(2000);
    expect(byDay.size).toBe(1);
  });
});

describe("expenses.service — historial mensual (Fase N.3)", () => {
  const today = new Date("2026-07-30T12:00:00Z");

  it("devuelve los meses sin huecos y marca partial solo el mes en curso", () => {
    const expense = buildExpense({ frequency: "yearly", startsAt: "2026-04-10", amounts: [{ amount: 250 }] });

    const months = buildHistory(
      [expense],
      new Date(Date.UTC(2026, 3, 1)),
      new Date(Date.UTC(2026, 6, 1)),
      today,
    );

    expect(months.map((m) => m.isoMonth)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07"]);
    expect(months.map((m) => m.total)).toEqual([250, 0, 0, 0]); // meses sin gasto en $0, no saltados
    expect(months.map((m) => m.partial)).toEqual([false, false, false, true]);
  });

  it("un aumento aparece en changes con su monto anterior, y solo en el mes de su vigencia", () => {
    const expense = buildExpense({
      concept: "Render — Web Service",
      frequency: "monthly",
      startsAt: "2026-05-15",
      amounts: [
        { amount: 290, effectiveFrom: "2026-05-15" },
        { amount: 340, effectiveFrom: "2026-07-01", note: "Subió el dólar" },
      ],
    });

    const months = buildHistory(
      [expense],
      new Date(Date.UTC(2026, 4, 1)),
      new Date(Date.UTC(2026, 6, 1)),
      today,
    );

    expect(months[0].changes).toEqual([]); // el alta no es un cambio de precio
    expect(months[1].changes).toEqual([]);
    expect(months[2].changes).toEqual([
      expect.objectContaining({
        expenseId: expense.id,
        concept: "Render — Web Service",
        effectiveFrom: "2026-07-01",
        previousAmount: 290,
        amount: 340,
        note: "Subió el dólar",
      }),
    ]);
    // Y los meses anteriores NO se reescribieron con el precio nuevo.
    expect(months.map((m) => m.total)).toEqual([290, 290, 340]);
  });

  it("agrupa por categoría y cuenta las ocurrencias de una semanal", () => {
    const semanal = buildExpense({
      concept: "Paquetería",
      category: "paqueteria",
      frequency: "weekly",
      startsAt: "2026-06-02",
      amounts: [{ amount: 100 }],
    });
    const mensual = buildExpense({
      concept: "Render",
      category: "infraestructura",
      frequency: "monthly",
      startsAt: "2026-06-15",
      amounts: [{ amount: 290 }],
    });

    const [junio] = buildHistory(
      [semanal, mensual],
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 5, 1)),
      today,
    );

    // 2, 9, 16, 23 y 30 de junio → 5 cargos de $100.
    expect(junio.byExpense).toEqual([
      expect.objectContaining({ concept: "Paquetería", occurrences: 5, amount: 500 }),
      expect.objectContaining({ concept: "Render", occurrences: 1, amount: 290 }),
    ]);
    expect(junio.total).toBe(790);
    expect(junio.byCategory).toEqual([
      { category: "paqueteria", amount: 500 },
      { category: "infraestructura", amount: 290 },
    ]);
  });
});

describe("expenses.service — resumen / cuánto retirar (Fase N.3)", () => {
  const today = new Date("2026-07-30T12:00:00Z");

  it("suma la carga mensual de todo lo vivo y la anualiza", () => {
    const render = buildExpense({ frequency: "monthly", startsAt: "2026-01-15", amounts: [{ amount: 290 }] });
    const dominio = buildExpense({ frequency: "yearly", startsAt: "2026-04-10", amounts: [{ amount: 1200 }] });
    const compra = buildExpense({ frequency: "once", startsAt: "2026-06-20", amounts: [{ amount: 1500 }] });

    const summary = buildSummary([render, dominio, compra], today);

    expect(summary.monthlyRunRate).toBe(390); // 290 + 1200/12; la compra única no suma
    expect(summary.annualRunRate).toBe(4680);
    expect(summary.activeCount).toBe(3);
  });

  it("upcomingCharges lista qué se cobra y cuándo, ordenado por fecha", () => {
    const render = buildExpense({ frequency: "monthly", startsAt: "2026-01-15", amounts: [{ amount: 290 }] });
    const vercel = buildExpense({ frequency: "monthly", startsAt: "2026-01-05", amounts: [{ amount: 400 }] });

    const summary = buildSummary([render, vercel], today);

    expect(summary.upcomingCharges.map((c) => c.date)).toEqual([
      "2026-08-05",
      "2026-08-15",
    ]);
    expect(summary.upcomingTotal).toBe(690);
    expect(summary.upcomingDays).toBe(30);
  });

  it("un gasto con endsAt en el pasado no cuenta como activo ni suma carga", () => {
    const cancelado = buildExpense({
      frequency: "monthly",
      startsAt: "2026-01-15",
      endsAt: "2026-05-20",
      active: true, // la bandera quedó encendida, pero ya no cobra
    });

    const summary = buildSummary([cancelado], today);

    expect(summary.monthlyRunRate).toBe(0);
    expect(summary.activeCount).toBe(0);
    expect(summary.upcomingCharges).toEqual([]);
  });
});

// ── Línea derivada de envío (Fase N.5) ────────────────────────────────────────────
// El envío pagado a la paquetería NO se persiste como gasto (serían ~900 filas al mes) y NO entra
// en los totales de gastos: el dashboard ya lo resta en GANANCIA BRUTA. Se inyecta como parámetro
// para que estas funciones sigan siendo puras — la consulta vive en los wrappers.
describe("expenses.service — envío derivado (Fase N.5)", () => {
  const today = new Date("2026-07-30T12:00:00Z");

  it("sin el argumento nuevo el envío es cero y nada más cambia", () => {
    // Fija que el default no rompe a ningún llamador anterior: son los mismos números del caso
    // "suma la carga mensual de todo lo vivo y la anualiza".
    const render = buildExpense({ frequency: "monthly", startsAt: "2026-01-15", amounts: [{ amount: 290 }] });
    const dominio = buildExpense({ frequency: "yearly", startsAt: "2026-04-10", amounts: [{ amount: 1200 }] });

    const summary = buildSummary([render, dominio], today);

    expect(summary.monthlyRunRate).toBe(390);
    expect(summary.annualRunRate).toBe(4680);
    expect(summary.shippingCost).toEqual({
      category: "paqueteria",
      derived: true,
      includedInGrossProfit: true,
      from: "2026-07-01",
      to: "2026-07-30", // el mes en curso llega hasta HOY, no hasta fin de mes
      partial: true,
      amount: 0, // cero, NO ausente
      orders: 0,
    });
  });

  it("con envío, el resumen lo expone SIN meterlo en la carga mensual ni en byCategory", () => {
    const render = buildExpense({ frequency: "monthly", startsAt: "2026-01-15", amounts: [{ amount: 290 }] });

    const summary = buildSummary(
      [render],
      today,
      new Map([["2026-07", { amount: 4500, orders: 30 }]]),
    );

    expect(summary.shippingCost.amount).toBe(4500);
    expect(summary.shippingCost.orders).toBe(30);
    // Lo que NO se movió: si se moviera, la GANANCIA OPERATIVA restaría el envío dos veces.
    expect(summary.monthlyRunRate).toBe(290);
    expect(summary.annualRunRate).toBe(3480);
    expect(summary.byCategory.map((c) => c.category)).not.toContain("paqueteria");
  });

  it("el historial atribuye el envío a su mes sin tocar total/byCategory/byExpense", () => {
    const render = buildExpense({
      frequency: "monthly",
      startsAt: "2026-05-15",
      amounts: [{ amount: 290 }],
    });
    const from = new Date(Date.UTC(2026, 4, 1));
    const to = new Date(Date.UTC(2026, 6, 1));
    const shipping = new Map([
      ["2026-05", { amount: 1200, orders: 8 }],
      ["2026-06", { amount: 900, orders: 6 }],
    ]);

    const sinEnvio = buildHistory([render], from, to, today);
    const conEnvio = buildHistory([render], from, to, today, shipping);

    expect(conEnvio.map((m) => m.shippingCost.amount)).toEqual([1200, 900, 0]);
    expect(conEnvio.map((m) => m.shippingCost.orders)).toEqual([8, 6, 0]);
    // Los agregados de gastos capturados son idénticos con y sin envío.
    expect(conEnvio.map((m) => m.total)).toEqual(sinEnvio.map((m) => m.total));
    expect(conEnvio.map((m) => m.byCategory)).toEqual(sinEnvio.map((m) => m.byCategory));
    expect(conEnvio.map((m) => m.byExpense)).toEqual(sinEnvio.map((m) => m.byExpense));
  });

  it("un mes cerrado cubre hasta su último día; el mes en curso, hasta hoy", () => {
    const render = buildExpense({ frequency: "monthly", startsAt: "2026-06-15", amounts: [{ amount: 290 }] });

    const [junio, julio] = buildHistory(
      [render],
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 6, 1)),
      today,
    );

    expect(junio.shippingCost).toMatchObject({ from: "2026-06-01", to: "2026-06-30", partial: false });
    expect(julio.shippingCost).toMatchObject({ from: "2026-07-01", to: "2026-07-30", partial: true });
  });
});
