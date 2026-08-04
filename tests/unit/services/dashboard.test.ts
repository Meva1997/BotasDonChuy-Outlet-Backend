/**
 * Parte 10 (roadmap-testing.md) — invariantes de dashboard.service.ts, no cifras
 * exactas contra un dataset fijo. Nivel 1: sin BD real ni HTTP. `Order.findAll`/
 * `Product.findAll` se mockean con `jest.spyOn` (nunca se abre una conexión real) y
 * las filas se construyen con `Model.build(...)` (nunca `.create()`/`.save()`), con las
 * asociaciones (`items`, `productSizes`) asignadas a mano — es lo que `getDashboardData`
 * lee para resolver `stock`/`orderCost`, no requiere un `include` real de Sequelize.
 */
import { Order } from "../../../src/models/Order";
import { OrderItem } from "../../../src/models/OrderItem";
import { Product } from "../../../src/models/Product";
import { ProductSize } from "../../../src/models/ProductSize";
import { Expense } from "../../../src/models/Expense";
import { ExpenseAmount } from "../../../src/models/ExpenseAmount";
import { getDashboardData } from "../../../src/services/dashboard.service";
import { formatMoney } from "../../../src/utils/formatMoney";

function buildOrderItem(overrides: {
  productId?: number;
  quantity?: number;
  unitCost?: number;
} = {}): OrderItem {
  return OrderItem.build({
    orderId: 0,
    productId: overrides.productId ?? 1,
    nameSnapshot: "Producto de prueba",
    size: 25,
    quantity: overrides.quantity ?? 1,
    unitOriginalPrice: 100,
    unitSalePrice: 100,
    unitCost: overrides.unitCost ?? 40,
  } as any);
}

function buildOrder(overrides: {
  id?: number;
  createdAt?: Date;
  total?: number;
  savings?: number;
  couponCode?: string | null;
  couponDiscount?: number;
  items?: OrderItem[];
} = {}): Order {
  const total = overrides.total ?? 1000;
  const order = Order.build({
    id: overrides.id ?? 1,
    status: "paid",
    subtotal: total,
    savings: overrides.savings ?? 0,
    shipping: 0,
    couponCode: overrides.couponCode ?? null,
    couponDiscount: overrides.couponDiscount ?? 0,
    total,
    customerName: "Cliente de prueba",
    customerEmail: "cliente@test.com",
    customerPhone: "4610000000",
    street: "Calle Falsa 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "GTO",
    postalCode: "38000",
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.createdAt ?? new Date(),
  } as any);
  order.items = overrides.items ?? [];
  return order;
}

function buildProduct(overrides: {
  id?: number;
  stock?: number;
  salePrice?: number;
  unitCost?: number;
} = {}): Product {
  const product = Product.build({
    id: overrides.id ?? 1,
    name: "Producto de prueba",
    type: "bota",
    originalPrice: 100,
    salePrice: overrides.salePrice ?? 80,
    unitCost: overrides.unitCost ?? 40,
    weightKg: 1,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    visible: true,
  } as any);
  product.productSizes = [
    ProductSize.build({ productId: product.id, size: 25, stock: overrides.stock ?? 0 } as any),
  ];
  return product;
}

/** Un gasto con una sola versión de monto, armado como lo hace `expenses.test.ts`:
 *  `Model.build` + `.amounts` asignado a mano (es lo que el servicio lee). */
function buildExpense(overrides: {
  id?: number;
  frequency?: string;
  startsAt?: string;
  amount?: number;
}): Expense {
  const startsAt = overrides.startsAt ?? "2026-01-01";
  const expense = Expense.build({
    id: overrides.id ?? 1,
    concept: "Gasto de prueba",
    vendor: null,
    category: "infraestructura",
    frequency: overrides.frequency ?? "monthly",
    startsAt,
    endsAt: null,
    active: true,
    notes: null,
  } as any);
  expense.amounts = [
    ExpenseAmount.build({
      id: 1,
      expenseId: expense.id,
      amount: overrides.amount ?? 2000,
      effectiveFrom: startsAt,
      note: null,
    } as any),
  ];
  return expense;
}

/** Encola las 4 respuestas que `getDashboardData` espera de `Promise.all`, en el
 * mismo orden en que las llama: ordersHistory, recentOrders, products, expenses. */
function mockQueries(
  ordersHistory: Order[],
  recentOrders: Order[],
  products: Product[],
  expenses: Expense[] = [],
) {
  const orderSpy = jest.spyOn(Order, "findAll") as unknown as jest.Mock;
  orderSpy.mockResolvedValueOnce(ordersHistory).mockResolvedValueOnce(recentOrders);
  jest.spyOn(Product, "findAll").mockResolvedValue(products as any);
  jest.spyOn(Expense, "findAll").mockResolvedValue(expenses as any);
  return orderSpy;
}

describe("dashboard.service — getDashboardData (Parte 10)", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Regresión de la Fase N.4. Este test afirmaba lo contrario (`where.status === "paid"`), que era
  // justo el bug: `Order.status` avanza a `shipped`/`delivered` en cuanto la guía reporta actividad
  // —o el dueño lo marca a mano con el `PATCH /status` de la Fase O.1—, así que filtrar por `status`
  // hacía que **un pedido saliera de los ingresos, los KPIs y `recentSales` al despacharlo**. El
  // predicado correcto es `paymentStatus: "paid"`: "el dinero entró y no se ha devuelto".
  it("consulta las ventas por paymentStatus, no por status (un pedido enviado sigue contando)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const orderSpy = mockQueries([], [], []);

    await getDashboardData();

    expect(orderSpy).toHaveBeenCalledTimes(2);
    for (const call of orderSpy.mock.calls) {
      const where = (call[0] as any).where;
      expect(where.paymentStatus).toBe("paid");
      // Lo que blinda la regresión: NINGUNA de las dos consultas puede volver a acotar `status`,
      // o los pedidos `shipped`/`delivered` desaparecerían otra vez.
      expect(where.status).toBeUndefined();
    }
  });

  it("revenueByPeriod incluye días en $0 sin saltarlos", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries([], [], []);

    const data = await getDashboardData();

    expect(data.revenueByPeriod["7"]).toHaveLength(7);
    expect(data.revenueByPeriod["7"].every((p) => p.revenue === 0)).toBe(true);
    expect(data.revenueByPeriod["30"]).toHaveLength(30);
    expect(data.revenueByPeriod["90"]).toHaveLength(90);
  });

  it("day-bucketing pinneado a UTC: una orden de madrugada UTC cae en el día correcto, no en el anterior", async () => {
    // Mismo caso límite que motivó el pin en date.ts (ver CLAUDE.md / Parte 1): sin
    // timeZone: "UTC", un host al oeste de UTC (p. ej. America/Mexico_City) correría
    // esta orden al día anterior.
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const orderToday = buildOrder({
      id: 1,
      createdAt: new Date("2026-01-01T02:00:00Z"),
      total: 500,
      items: [buildOrderItem({ unitCost: 40, quantity: 1 })],
    });
    mockQueries([orderToday], [], []);

    const data = await getDashboardData();

    const points = data.revenueByPeriod["7"];
    expect(points[points.length - 1].revenue).toBe(500); // hoy
    expect(points[points.length - 2].revenue).toBe(0); // ayer — no se le atribuyó la orden
  });

  it("cada ventana compara contra su propia ventana previa de igual longitud", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    // Orden 10 días atrás: cae en la ventana PREVIA de "7" (7-13 días atrás) pero en la
    // ventana ACTUAL de "30" (0-29 días atrás) — cada ventana debe leer su propio corte.
    const tenDaysAgo = new Date("2026-07-10T12:00:00Z");
    const order = buildOrder({
      id: 1,
      createdAt: tenDaysAgo,
      total: 1000,
      items: [buildOrderItem({ unitCost: 400, quantity: 1 })],
    });
    mockQueries([order], [], []);

    const data = await getDashboardData();

    const ingresos7 = data.kpisByPeriod["7"].find((k) => k.label === "INGRESOS")!;
    expect(ingresos7.value).toBe(formatMoney(0)); // nada en la ventana actual de 7 días
    expect(ingresos7.trend).toEqual({ label: "-100% vs periodo anterior", positive: false });

    const ingresos30 = data.kpisByPeriod["30"].find((k) => k.label === "INGRESOS")!;
    expect(ingresos30.value).toBe(formatMoney(1000)); // sí cae en la ventana actual de 30 días
    expect(ingresos30.trend).toBeUndefined(); // ventana previa de 30 días vacía → sin trend
  });

  // ── Gastos (Fase N.3) ───────────────────────────────────────────────────────
  // Hasta esta fase el KPI restaba una constante de $2,000 hardcodeada en el servicio.
  // Ahora sale de la tabla `expenses`, y estos casos fijan que la semántica de prorrateo
  // (× windowDays/30) sobrevivió al cambio.

  const gastosKpi = (data: Awaited<ReturnType<typeof getDashboardData>>, period: "7" | "30" | "90") =>
    data.profitKpisByPeriod[period].find((k) => k.label === "GASTOS")!;

  it("GASTOS se prorratea por windowDays/30 desde la carga mensual real", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries([], [], [], [buildExpense({ frequency: "monthly", amount: 2000 })]);

    const data = await getDashboardData();

    expect(gastosKpi(data, "7").value).toBe(formatMoney(2000 * (7 / 30)));
    expect(gastosKpi(data, "30").value).toBe(formatMoney(2000));
    expect(gastosKpi(data, "90").value).toBe(formatMoney(2000 * (90 / 30)));
  });

  it("una anualidad cuenta 1/12 en la carga mensual, no completa", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries([], [], [], [buildExpense({ frequency: "yearly", amount: 1200 })]);

    const data = await getDashboardData();

    expect(gastosKpi(data, "30").value).toBe(formatMoney(100));
  });

  it("un gasto de única vez cuenta completo, y SOLO si su fecha cae en la ventana", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries(
      [],
      [],
      [],
      [buildExpense({ frequency: "once", startsAt: "2026-07-01", amount: 1500 })],
    );

    const data = await getDashboardData();

    // Ventana de 7 días (14–20 de julio): el gasto del día 1 queda fuera.
    expect(gastosKpi(data, "7").value).toBe(formatMoney(0));
    // Ventana de 30 días: entra completo, sin prorratear.
    expect(gastosKpi(data, "30").value).toBe(formatMoney(1500));
    expect(gastosKpi(data, "30").subtitle).toContain("de única vez");
  });

  it("sin gastos capturados el KPI es $0 y GANANCIA OPERATIVA iguala a la BRUTA", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const order = buildOrder({
      id: 1,
      createdAt: new Date("2026-07-18T12:00:00Z"),
      total: 1000,
      items: [buildOrderItem({ unitCost: 400, quantity: 1 })],
    });
    mockQueries([order], [], [], []);

    const data = await getDashboardData();

    const kpi = (label: string) =>
      data.profitKpisByPeriod["30"].find((k) => k.label === label)!.value;

    expect(gastosKpi(data, "30").value).toBe(formatMoney(0));
    expect(kpi("GANANCIA OPERATIVA")).toBe(kpi("GANANCIA BRUTA"));
  });

  it("inventory incluye el valor de cada producto (stock resuelto vía productSizes)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const product = buildProduct({ id: 1, stock: 5, salePrice: 80, unitCost: 40 });
    mockQueries([], [], [product]);

    const data = await getDashboardData();

    expect(data.inventory).toEqual([
      expect.objectContaining({ id: 1, stock: 5, unitCost: 40, valorInventario: 200 }),
    ]);
  });

  // ── Cupones (Fase N.2) ──────────────────────────────────────────────────────
  it("recentSales expone el cupón para que la fila cuadre", async () => {
    // Sin estos dos campos la fila es irreconciliable en el panel: `savings` es solo el ahorro
    // outlet y `total` ya viene neto de cupón, así que el faltante no tiene causa visible.
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const order = buildOrder({
      id: 7,
      createdAt: new Date("2026-07-20T10:00:00Z"),
      total: 880,
      savings: 200,
      couponCode: "VERANO25",
      couponDiscount: 120,
      items: [buildOrderItem({ quantity: 1 })],
    });
    mockQueries([order], [order], []);

    const data = await getDashboardData();

    expect(data.recentSales[0]).toEqual(
      expect.objectContaining({ couponCode: "VERANO25", couponDiscount: 120 }),
    );
  });

  it("suma los descuentos por cupón en su propio KPI, sin tocar los ingresos", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const orders = [
      buildOrder({
        id: 1,
        createdAt: new Date("2026-07-20T10:00:00Z"),
        total: 880,
        couponDiscount: 120,
        items: [buildOrderItem({ quantity: 1 })],
      }),
      buildOrder({
        id: 2,
        createdAt: new Date("2026-07-19T10:00:00Z"),
        total: 950,
        couponDiscount: 50,
        items: [buildOrderItem({ quantity: 1 })],
      }),
    ];
    mockQueries(orders, [], []);

    const data = await getDashboardData();

    const cupones = data.profitKpisByPeriod["7"].find(
      (k) => k.label === "DESCUENTOS POR CUPÓN",
    )!;
    expect(cupones.value).toBe(formatMoney(170));
    // `INGRESOS` sigue sumando el efectivo cobrado (los totales ya netos), no el bruto.
    const ingresos = data.kpisByPeriod["7"].find((k) => k.label === "INGRESOS")!;
    expect(ingresos.value).toBe(formatMoney(1830));
  });

  it("sin cupones el KPI queda en cero, no ausente", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries([], [], []);

    const data = await getDashboardData();

    const cupones = data.profitKpisByPeriod["30"].find(
      (k) => k.label === "DESCUENTOS POR CUPÓN",
    );
    expect(cupones).toBeDefined();
    expect(cupones!.value).toBe(formatMoney(0));
  });
});
