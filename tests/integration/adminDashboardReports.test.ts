import request from "supertest";

/**
 * `GET /api/admin/dashboard` y `GET /api/admin/reports/{monthly,replenishment}` por HTTP —
 * Nivel 2 (roadmap-testing.md): el flujo completo ruta → `requireAuth` → controlador → servicio
 * → Postgres real.
 *
 * La agregación en sí ya está cubierta por los tests de nivel 1 (`unit/services/dashboard.test.ts`
 * y `reports.test.ts`), que la ejercitan con datos armados a mano. Lo que **solo** se puede probar
 * aquí es lo que vive fuera del servicio: que las tres rutas exijan token (son las que exponen
 * `unitCost` y el margen del negocio), y que la respuesta que sale por el socket tenga la forma que
 * el panel consume — un servicio correcto detrás de un controlador que serializa mal sigue siendo
 * un panel roto.
 *
 * Los datos se siembran **una vez** en `beforeAll` y no se truncan entre casos: los tres endpoints
 * son de solo lectura y, sobre todo, `loadReportData` cachea su fetch 60 s a nivel de módulo
 * (`REPORT_CACHE_TTL_MS`), así que truncar entre casos dejaría a la caché sirviendo filas que ya
 * no existen — el mismo tipo de estado de módulo que sobrevive a `truncateAll` y por el que otras
 * suites exportan un `reset*()`.
 */
import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import {
  createAdminUser,
  createOrder,
  createOrderItem,
  createProduct,
  signToken,
} from "../setup/factories";
import { Product } from "../../src/models/Product";
import { formatMoney } from "../../src/utils/formatMoney";

let token: string;
let bota: Product;
let sombrero: Product;

beforeAll(async () => {
  await setupTestDatabase();

  const { user } = await createAdminUser();
  token = signToken(user);

  bota = await createProduct({
    name: "Bota Rodeo",
    type: "bota",
    originalPrice: 2000,
    salePrice: 1600,
    unitCost: 800,
    sizes: { 25: 4, 26: 2 },
  });
  // Un producto sin ventas: en el reporte mensual debe salir con `unitsSold: 0` (no desaparecer)
  // y en el de reabastecimiento con pronóstico "Sin datos".
  sombrero = await createProduct({
    name: "Sombrero Charro",
    type: "sombrero",
    originalPrice: 900,
    salePrice: 700,
    unitCost: 300,
    sizes: { 7: 3 },
  });

  // Una venta real: `paymentStatus: "paid"` es lo que cuenta como venta, no `status`.
  const vendida = await createOrder({
    status: "paid",
    paymentStatus: "paid",
    subtotal: 3200,
    savings: 800,
    shipping: 150,
  });
  await createOrderItem(vendida.id, bota, { size: 25, quantity: 2 });

  // Un pedido ya despachado: sigue siendo una venta (la Fase N.4 arregló justo que
  // `status: "shipped"` lo sacaba de los KPIs) y tiene que aparecer en los tres endpoints.
  const enviada = await createOrder({
    status: "shipped",
    paymentStatus: "paid",
    subtotal: 1600,
    savings: 400,
    shipping: 150,
  });
  await createOrderItem(enviada.id, bota, { size: 26, quantity: 1 });

  // Ruido que NO debe contar: un carrito abandonado y uno reembolsado.
  const pendiente = await createOrder({ status: "pending", paymentStatus: "unpaid" });
  await createOrderItem(pendiente.id, bota, { size: 25, quantity: 1 });
  const reembolsada = await createOrder({ status: "cancelled", paymentStatus: "refunded" });
  await createOrderItem(reembolsada.id, bota, { size: 25, quantity: 1 });
});

afterAll(async () => {
  await truncateAll();
  await closeTestDatabase();
});

describe("GET /api/admin/dashboard", () => {
  it("responde 401 sin token: expone costo y margen del negocio", async () => {
    const res = await request(app).get("/api/admin/dashboard");

    expect(res.status).toBe(401);
  });

  it("responde 401 con un token basura", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", "Bearer no-es-un-jwt");

    expect(res.status).toBe(401);
  });

  it("devuelve las cinco secciones que el panel consume", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["inventory", "kpisByPeriod", "profitKpisByPeriod", "recentSales", "revenueByPeriod"].sort(),
    );
  });

  it("trae las tres ventanas juntas (el front alterna del lado del cliente, sin query param)", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    for (const seccion of ["kpisByPeriod", "profitKpisByPeriod", "revenueByPeriod"] as const) {
      expect(Object.keys(res.body[seccion]).sort()).toEqual(["30", "7", "90"]);
    }
  });

  it("la serie de ingresos trae un punto por día calendario, incluidos los días en $0", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    // Un día sin ventas nunca se omite: la gráfica quedaría con huecos que se leen como
    // "no hubo datos" en vez de "no se vendió".
    expect(res.body.revenueByPeriod["7"]).toHaveLength(7);
    expect(res.body.revenueByPeriod["30"]).toHaveLength(30);
    expect(res.body.revenueByPeriod["90"]).toHaveLength(90);
  });

  it("cuenta como venta el pedido ya despachado y deja fuera el pendiente y el reembolsado", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    const totales = res.body.recentSales.map((s: { total: number }) => s.total).sort();
    // 3200 − 800 + 150 = 2550 (pagado) y 1600 − 400 + 150 = 1350 (despachado). Nada más.
    expect(totales).toEqual([1350, 2550]);
  });

  // ── El envío como costo de venta (Fase N.5) ───────────────────────────────
  it("descuenta el envío de la ganancia bruta, y una sola vez", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    // La fila trae el envío para que la ganancia real del pedido salga del panel: `total` ya lo
    // incluye, así que sin este campo `total − costoTotal` sobrestima lo que se ganó.
    expect(res.body.recentSales.map((s: { shipping: number }) => s.shipping)).toEqual([150, 150]);

    const kpi = (label: string) =>
      res.body.profitKpisByPeriod["30"].find((k: { label: string }) => k.label === label).value;

    // Ingresos 2550 + 1350 = 3900 · producto 800×2 + 800×1 = 2400 · envío 150×2 = 300.
    expect(kpi("COSTO DE ENVÍO")).toBe(formatMoney(300));
    expect(kpi("GANANCIA BRUTA")).toBe(formatMoney(1200)); // 3900 − 2400 − 300
    expect(kpi("MARGEN BRUTO")).toBe("31%"); // 1200 / 3900 = 30.77 → 31
    // Sin gastos capturados, la operativa iguala a la bruta: el envío NO se restó otra vez aquí.
    expect(kpi("GASTOS")).toBe(formatMoney(0));
    expect(kpi("GANANCIA OPERATIVA")).toBe(formatMoney(1200));
  });

  it("el inventario incluye el producto sin ventas", async () => {
    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    const nombres = res.body.inventory.map((r: { name: string }) => r.name);
    expect(nombres).toContain("Sombrero Charro");
  });
});

describe("GET /api/admin/reports/monthly", () => {
  it("responde 401 sin token", async () => {
    const res = await request(app).get("/api/admin/reports/monthly");

    expect(res.status).toBe(401);
  });

  it("devuelve los meses con su desglose por producto y por categoría", async () => {
    const res = await request(app)
      .get("/api/admin/reports/monthly")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        label: expect.any(String),
        totalRevenue: expect.any(Number),
        totalUnits: expect.any(Number),
        byProduct: expect.any(Array),
        byCategory: expect.any(Array),
      }),
    );
  });

  it("marca el mes en curso como parcial", async () => {
    const res = await request(app)
      .get("/api/admin/reports/monthly")
      .set("Authorization", `Bearer ${token}`);

    // Es el último del arreglo y el único parcial: sin la bandera, el panel compararía un mes
    // a medias contra meses completos.
    const ultimo = res.body[res.body.length - 1];
    expect(ultimo.partial).toBe(true);
    expect(res.body.filter((m: { partial?: boolean }) => m.partial)).toHaveLength(1);
  });

  it("suma las 3 piezas vendidas del mes y lista el producto sin ventas en 0", async () => {
    const res = await request(app)
      .get("/api/admin/reports/monthly")
      .set("Authorization", `Bearer ${token}`);

    const mesActual = res.body[res.body.length - 1];
    expect(mesActual.totalUnits).toBe(3); // 2 de la venta pagada + 1 de la despachada

    const sinVentas = mesActual.byProduct.find(
      (p: { productId: number }) => p.productId === sombrero.id,
    );
    expect(sinVentas).toEqual(expect.objectContaining({ unitsSold: 0 }));
  });
});

describe("GET /api/admin/reports/replenishment", () => {
  it("responde 401 sin token", async () => {
    const res = await request(app).get("/api/admin/reports/replenishment");

    expect(res.status).toBe(401);
  });

  it("devuelve una fila por producto vivo con el pronóstico y la prioridad", async () => {
    const res = await request(app)
      .get("/api/admin/reports/replenishment")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2); // bota + sombrero, ninguno descontinuado

    const fila = res.body.find((r: { productId: number }) => r.productId === bota.id);
    expect(fila).toEqual(
      expect.objectContaining({
        productId: bota.id,
        name: "Bota Rodeo",
        type: "bota",
        currentStock: expect.any(Number),
        forecastNextMonth: expect.any(Number),
        forecastMethodLabel: expect.any(String),
        diasCobertura: expect.any(Number),
        suggestedOrder: expect.any(Number),
        priority: expect.stringMatching(/^(urgente|pronto|ok)$/),
      }),
    );
  });

  it("un producto que nunca vendió sale con pronóstico 0 y sin datos", async () => {
    const res = await request(app)
      .get("/api/admin/reports/replenishment")
      .set("Authorization", `Bearer ${token}`);

    const fila = res.body.find((r: { productId: number }) => r.productId === sombrero.id);
    expect(fila.forecastNextMonth).toBe(0);
    expect(fila.forecastMethodLabel).toBe("Sin datos");
  });

  it("los enteros del front llegan como enteros (el redondeo lo hace el backend)", async () => {
    const res = await request(app)
      .get("/api/admin/reports/replenishment")
      .set("Authorization", `Bearer ${token}`);

    for (const fila of res.body) {
      for (const campo of [
        "forecastNextMonth",
        "diasCobertura",
        "suggestedOrder",
        "ingresoMensual",
        "margenMensual",
      ]) {
        expect(Number.isInteger(fila[campo])).toBe(true);
      }
    }
  });
});
