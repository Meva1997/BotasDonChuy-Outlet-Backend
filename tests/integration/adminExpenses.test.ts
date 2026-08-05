import request from "supertest";

/**
 * Nivel 2 (Fase N.3): el CRUD admin de gastos por HTTP contra Postgres real.
 *
 * Lo que estas pruebas cuidan de verdad no es el CRUD sino **el versionado del monto**: que subir
 * un precio agregue una versión en vez de sobrescribir, que los meses ya cerrados no se muevan, y
 * que el índice único `(expenseId, effectiveFrom)` convierta un re-edit del mismo día en una
 * corrección y no en una versión duplicada.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createOrder, signToken } from "../setup/factories";
import { Expense } from "../../src/models/Expense";
import { ExpenseAmount } from "../../src/models/ExpenseAmount";

let token: string;

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(async () => {
  const { user } = await createAdminUser();
  token = signToken(user);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

const renderInput = {
  concept: "Render — Web Service",
  vendor: "Render",
  category: "infraestructura",
  frequency: "monthly",
  startsAt: "2026-03-15",
  amount: 290,
};

async function createRender() {
  const res = await request(app).post("/api/admin/expenses").set(auth()).send(renderInput);
  expect(res.status).toBe(201);
  return res.body;
}

describe("/api/admin/expenses — auth", () => {
  it("todas las rutas responden 401 sin token", async () => {
    const responses = await Promise.all([
      request(app).get("/api/admin/expenses"),
      request(app).get("/api/admin/expenses/summary"),
      request(app).get("/api/admin/expenses/history"),
      request(app).post("/api/admin/expenses").send(renderInput),
      request(app).put("/api/admin/expenses/1").send({ active: false }),
      request(app).delete("/api/admin/expenses/1"),
    ]);

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
});

describe("POST /api/admin/expenses", () => {
  it("crea el gasto y su primera versión de monto, vigente desde startsAt", async () => {
    const body = await createRender();

    expect(body).toMatchObject({
      concept: "Render — Web Service",
      vendor: "Render",
      category: "infraestructura",
      frequency: "monthly",
      startsAt: "2026-03-15",
      endsAt: null,
      active: true,
      currentAmount: 290,
      monthlyRunRate: 290,
    });
    // La primera versión rige desde el arranque del gasto, no desde hoy: si no, los cargos
    // anteriores a la captura quedarían sin monto que los cubra.
    expect(body.amounts).toEqual([
      expect.objectContaining({ amount: 290, effectiveFrom: "2026-03-15" }),
    ]);

    const rows = await ExpenseAmount.count();
    expect(rows).toBe(1);
  });

  it("rechaza en español una fecha de término anterior al primer cargo", async () => {
    const res = await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({ ...renderInput, endsAt: "2026-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("anterior a la del primer cargo");
  });

  it("rechaza una fecha que no existe (2026-02-31)", async () => {
    const res = await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({ ...renderInput, startsAt: "2026-02-31" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("no es una fecha real");
  });

  it("rechaza una fecha de término en un gasto de única vez", async () => {
    const res = await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({ ...renderInput, frequency: "once", endsAt: "2026-12-31" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("única vez");
  });
});

describe("PUT /api/admin/expenses/:id — versionado del monto", () => {
  it("subir el precio AGREGA una versión y no reescribe los meses anteriores", async () => {
    const created = await createRender();

    const res = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ amount: 340, amountEffectiveFrom: "2026-07-01", amountNote: "Subió el dólar" });

    expect(res.status).toBe(200);
    expect(res.body.currentAmount).toBe(340);
    expect(res.body.amounts).toEqual([
      expect.objectContaining({ amount: 290, effectiveFrom: "2026-03-15" }),
      expect.objectContaining({ amount: 340, effectiveFrom: "2026-07-01", note: "Subió el dólar" }),
    ]);

    const history = await request(app)
      .get("/api/admin/expenses/history")
      .query({ from: "2026-03", to: "2026-07" })
      .set(auth());

    const byMonth = new Map<string, number>(
      history.body.map((m: any) => [m.isoMonth, m.total]),
    );
    expect(byMonth.get("2026-05")).toBe(290); // el pasado NO se movió
    expect(byMonth.get("2026-06")).toBe(290);
    expect(byMonth.get("2026-07")).toBe(340);

    const julio = history.body.find((m: any) => m.isoMonth === "2026-07");
    expect(julio.changes).toEqual([
      expect.objectContaining({ previousAmount: 290, amount: 340, effectiveFrom: "2026-07-01" }),
    ]);
  });

  it("re-editar el monto con la misma vigencia CORRIGE en su lugar, no duplica la versión", async () => {
    const created = await createRender();

    await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ amount: 340, amountEffectiveFrom: "2026-07-01" });
    const res = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ amount: 350, amountEffectiveFrom: "2026-07-01" });

    expect(res.status).toBe(200);
    expect(res.body.amounts).toHaveLength(2);
    expect(res.body.amounts[1]).toMatchObject({ amount: 350, effectiveFrom: "2026-07-01" });
  });

  it("editar solo el concepto NO ensucia el historial de precios", async () => {
    const created = await createRender();

    const res = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ concept: "Render — Web Service (producción)" });

    expect(res.status).toBe(200);
    expect(res.body.concept).toBe("Render — Web Service (producción)");
    expect(res.body.amounts).toHaveLength(1);
  });

  it("mandar el mismo monto no escribe una versión nueva", async () => {
    const created = await createRender();

    const res = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ amount: 290 });

    expect(res.status).toBe(200);
    expect(res.body.amounts).toHaveLength(1);
  });

  it("apagar un gasto le fija endsAt en hoy, y reactivarlo lo limpia", async () => {
    const created = await createRender();
    const today = new Date().toISOString().slice(0, 10);

    const off = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ active: false });

    // Sin esta fecha, "hasta cuándo cobró" quedaría a merced de `updatedAt`, que cualquier
    // otro edit bumpea (la lección de `shipmentClaimedAt`, Fase O.3).
    expect(off.body).toMatchObject({ active: false, endsAt: today, monthlyRunRate: 0 });

    const on = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ active: true });

    expect(on.body).toMatchObject({ active: true, endsAt: null, monthlyRunRate: 290 });
  });

  it("una vigencia sin monto es 400", async () => {
    const created = await createRender();

    const res = await request(app)
      .put(`/api/admin/expenses/${created.id}`)
      .set(auth())
      .send({ amountEffectiveFrom: "2026-09-01" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("el monto nuevo");
  });

  it("un id inexistente da 404 y uno no numérico da 400 (parseId), nunca un 500", async () => {
    const missing = await request(app)
      .put("/api/admin/expenses/9999")
      .set(auth())
      .send({ concept: "X" });
    const bad = await request(app)
      .put("/api/admin/expenses/abc")
      .set(auth())
      .send({ concept: "X" });

    expect(missing.status).toBe(404);
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/admin/expenses", () => {
  it("filtra por rango de FECHAS DE CARGO, no por fecha de alta", async () => {
    // Un gasto dado de alta en marzo y vigente desde entonces tiene que salir al consultar agosto.
    const render = await createRender();
    const compra = await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({
        concept: "Compra de cajas",
        category: "paqueteria",
        frequency: "once",
        startsAt: "2026-04-10",
        amount: 1500,
      });

    const agosto = await request(app)
      .get("/api/admin/expenses")
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .set(auth());

    expect(agosto.body.map((e: any) => e.id)).toEqual([render.id]);

    const abril = await request(app)
      .get("/api/admin/expenses")
      .query({ from: "2026-04-01", to: "2026-04-30" })
      .set(auth());

    expect(abril.body.map((e: any) => e.id).sort()).toEqual(
      [render.id, compra.body.id].sort(),
    );
  });

  it("filtra por categoría y rechaza una categoría inválida con 400", async () => {
    await createRender();

    const ok = await request(app)
      .get("/api/admin/expenses")
      .query({ category: "renta" })
      .set(auth());
    const bad = await request(app)
      .get("/api/admin/expenses")
      .query({ category: "gasolina" })
      .set(auth());

    expect(ok.body).toEqual([]);
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/admin/expenses/summary", () => {
  it("suma la carga mensual y lista los próximos cargos con su fecha", async () => {
    await createRender();
    await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({
        concept: "Dominio",
        category: "infraestructura",
        frequency: "yearly",
        startsAt: "2026-04-10",
        amount: 1200,
      });

    const res = await request(app).get("/api/admin/expenses/summary").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.monthlyRunRate).toBe(390); // 290 mensual + 1200/12 de la anualidad
    expect(res.body.annualRunRate).toBe(4680);
    expect(res.body.activeCount).toBe(2);
    expect(res.body.upcomingCharges.length).toBeGreaterThan(0);
    expect(res.body.byCategory).toEqual([
      expect.objectContaining({ category: "infraestructura", count: 2 }),
    ]);
    // Sin pedidos, la línea derivada de envío sale en cero — y NO altera nada de lo de arriba.
    expect(res.body.shippingCost).toMatchObject({
      category: "paqueteria",
      derived: true,
      includedInGrossProfit: true,
      amount: 0,
      orders: 0,
      partial: true,
    });
  });
});

// ── Envío derivado (Fase N.5) ─────────────────────────────────────────────────────
// El envío pagado a la paquetería sale de `Order.shipping`, no de filas `Expense`. Estas pruebas
// cuidan las dos mitades del trato: que el monto llegue, y que NO se cuele en los totales de
// gastos (el dashboard ya lo resta en GANANCIA BRUTA, así que ahí se restaría dos veces).
describe("GET /api/admin/expenses — envío derivado", () => {
  it("suma el envío de los pedidos pagados y excluye reembolsados y no pagados", async () => {
    await createOrder({ paymentStatus: "paid", shipping: 150 });
    await createOrder({ paymentStatus: "paid", shipping: 150 });
    // La guía de un reembolso normalmente ya se pagó, pero el predicado es el mismo del dashboard
    // (`paymentStatus: "paid"`): se asume que subestima antes que contradecir a los otros paneles.
    await createOrder({ paymentStatus: "refunded", shipping: 150 });
    await createOrder({ paymentStatus: "unpaid", shipping: 150 });

    const res = await request(app).get("/api/admin/expenses/summary").set(auth());

    expect(res.status).toBe(200);
    expect(res.body.shippingCost.amount).toBe(300);
    expect(res.body.shippingCost.orders).toBe(2);
  });

  it("no se cuela en la carga mensual, en activeCount ni en byCategory", async () => {
    await createRender(); // $290 mensuales, categoría infraestructura
    await createOrder({ paymentStatus: "paid", shipping: 150 });

    const res = await request(app).get("/api/admin/expenses/summary").set(auth());

    expect(res.body.shippingCost.amount).toBe(150);
    // Lo que tiene que quedar intacto, o la GANANCIA OPERATIVA restaría el envío dos veces:
    expect(res.body.monthlyRunRate).toBe(290);
    expect(res.body.activeCount).toBe(1);
    expect(res.body.byCategory.map((c: { category: string }) => c.category)).not.toContain(
      "paqueteria",
    );
  });

  it("el historial lo atribuye a su mes sin sumarlo al total del mes", async () => {
    await createRender();
    await createOrder({ paymentStatus: "paid", shipping: 150 });
    await createOrder({ paymentStatus: "paid", shipping: 200 });

    const mesActual = new Date().toISOString().slice(0, 7);
    const res = await request(app)
      .get("/api/admin/expenses/history")
      .query({ from: mesActual, to: mesActual })
      .set(auth());

    expect(res.status).toBe(200);
    const [mes] = res.body;
    expect(mes.shippingCost.amount).toBe(350);
    expect(mes.shippingCost.orders).toBe(2);
    // `total` sigue siendo solo lo capturado, y ninguna fila de envío se coló en el desglose.
    expect(mes.total).toBe(290);
    expect(mes.byExpense).toHaveLength(1);
    expect(mes.byCategory).toEqual([{ category: "infraestructura", amount: 290 }]);
  });
});

describe("DELETE /api/admin/expenses/:id", () => {
  it("desactiva (no borra) un gasto que ya generó cargos, y su historial se conserva", async () => {
    const created = await createRender();

    const res = await request(app).delete(`/api/admin/expenses/${created.id}`).set(auth());

    expect(res.body).toEqual({ ok: true, deactivated: true });
    const row = await Expense.findByPk(created.id);
    expect(row).not.toBeNull();
    expect(row!.active).toBe(false);

    const history = await request(app)
      .get("/api/admin/expenses/history")
      .query({ from: "2026-03", to: "2026-04" })
      .set(auth());
    expect(history.body[0].total).toBe(290); // marzo sigue ahí
  });

  it("borra de verdad un gasto que nunca cobró nada (alta equivocada a futuro)", async () => {
    const futuro = await request(app)
      .post("/api/admin/expenses")
      .set(auth())
      .send({
        concept: "Suscripción que arranca el año que viene",
        category: "software",
        frequency: "monthly",
        startsAt: "2099-01-01",
        amount: 100,
      });

    const res = await request(app)
      .delete(`/api/admin/expenses/${futuro.body.id}`)
      .set(auth());

    expect(res.body).toEqual({ ok: true, deactivated: false });
    expect(await Expense.findByPk(futuro.body.id)).toBeNull();
    // Las versiones de monto se van con el gasto (onDelete: CASCADE).
    expect(await ExpenseAmount.count({ where: { expenseId: futuro.body.id } })).toBe(0);
  });
});
