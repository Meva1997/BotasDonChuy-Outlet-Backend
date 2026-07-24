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
  items?: OrderItem[];
} = {}): Order {
  const total = overrides.total ?? 1000;
  const order = Order.build({
    id: overrides.id ?? 1,
    status: "paid",
    subtotal: total,
    savings: overrides.savings ?? 0,
    shipping: 0,
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

/** Encola las 3 respuestas que `getDashboardData` espera de `Promise.all`, en el
 * mismo orden en que las llama: ordersHistory, recentOrders, products. */
function mockQueries(ordersHistory: Order[], recentOrders: Order[], products: Product[]) {
  const orderSpy = jest.spyOn(Order, "findAll") as unknown as jest.Mock;
  orderSpy.mockResolvedValueOnce(ordersHistory).mockResolvedValueOnce(recentOrders);
  jest.spyOn(Product, "findAll").mockResolvedValue(products as any);
  return orderSpy;
}

describe("dashboard.service — getDashboardData (Parte 10)", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("solo consulta órdenes con status paid (no paymentStatus, que el seed deja en unpaid)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const orderSpy = mockQueries([], [], []);

    await getDashboardData();

    expect(orderSpy).toHaveBeenCalledTimes(2);
    expect((orderSpy.mock.calls[0][0] as any).where.status).toBe("paid");
    expect((orderSpy.mock.calls[1][0] as any).where.status).toBe("paid");
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

  it("GASTOS FIJOS se prorratea por windowDays/30 en cada ventana", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-20T12:00:00Z"));
    mockQueries([], [], []);

    const data = await getDashboardData();

    const gastos = (period: "7" | "30" | "90") =>
      data.profitKpisByPeriod[period].find((k) => k.label === "GASTOS FIJOS")!.value;

    expect(gastos("7")).toBe(formatMoney(2000 * (7 / 30)));
    expect(gastos("30")).toBe(formatMoney(2000));
    expect(gastos("90")).toBe(formatMoney(2000 * (90 / 30)));
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
});
