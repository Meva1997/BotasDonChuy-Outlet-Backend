/**
 * Parte 10 (roadmap-testing.md) — invariantes de reports.service.ts, no cifras exactas
 * contra un dataset fijo. Nivel 1: sin BD real ni HTTP. `Order.findAll`/`Product.findAll`
 * se mockean con `jest.spyOn`; las filas se construyen con `Model.build(...)` (nunca
 * `.create()`), con `items`/`productSizes` asignados a mano.
 *
 * `loadReportData` (no exportado) cachea su promesa a nivel de MÓDULO
 * (`cachedReportData`/`cacheExpiresAt`) — para que la Parte de caché (bullet 6) no
 * arrastre estado entre tests, cada `it` hace `jest.resetModules()` + `require(...)`
 * fresco de los modelos y del servicio (mismo patrón que
 * `tests/unit/services/skydropx.test.ts`, Parte 7, para su cache de token/throttle).
 */
import type { Order as OrderType } from "../../../src/models/Order";
import type { OrderItem as OrderItemType } from "../../../src/models/OrderItem";
import type { Product as ProductType } from "../../../src/models/Product";
import type { ProductSize as ProductSizeType } from "../../../src/models/ProductSize";
import type * as ReportsServiceType from "../../../src/services/reports.service";

let OrderCls: typeof OrderType;
let OrderItemCls: typeof OrderItemType;
let ProductCls: typeof ProductType;
let ProductSizeCls: typeof ProductSizeType;
let reports: typeof ReportsServiceType;

beforeEach(() => {
  jest.resetModules();
  OrderCls = require("../../../src/models/Order").Order;
  OrderItemCls = require("../../../src/models/OrderItem").OrderItem;
  ProductCls = require("../../../src/models/Product").Product;
  ProductSizeCls = require("../../../src/models/ProductSize").ProductSize;
  reports = require("../../../src/services/reports.service");
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function buildOrderItem(overrides: { productId: number; quantity?: number }): OrderItemType {
  return OrderItemCls.build({
    orderId: 0,
    productId: overrides.productId,
    nameSnapshot: "Producto de prueba",
    size: 25,
    quantity: overrides.quantity ?? 1,
    unitOriginalPrice: 100,
    unitSalePrice: 100,
    unitCost: 40,
  } as any);
}

function buildOrder(overrides: { id: number; createdAt: Date; items: OrderItemType[] }): OrderType {
  const order = OrderCls.build({
    id: overrides.id,
    status: "paid",
    subtotal: 100,
    savings: 0,
    shipping: 0,
    total: 100,
    customerName: "Cliente de prueba",
    customerEmail: "cliente@test.com",
    customerPhone: "4610000000",
    street: "Calle Falsa 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "GTO",
    postalCode: "38000",
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  } as any);
  order.items = overrides.items;
  return order;
}

function buildProduct(overrides: {
  id: number;
  name?: string;
  stock?: number;
  salePrice?: number;
  unitCost?: number;
  deletedAt?: Date | null;
}): ProductType {
  const product = ProductCls.build({
    id: overrides.id,
    name: overrides.name ?? `Producto ${overrides.id}`,
    type: "bota",
    originalPrice: 100,
    salePrice: overrides.salePrice ?? 100,
    unitCost: overrides.unitCost ?? 40,
    weightKg: 1,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    visible: true,
    deletedAt: overrides.deletedAt ?? null,
  } as any);
  product.productSizes = [
    ProductSizeCls.build({ productId: product.id, size: 25, stock: overrides.stock ?? 0 } as any),
  ];
  return product;
}

/** Mockea Order.findAll / Product.findAll (las dos únicas queries de loadReportData). */
function mockLoad(orders: OrderType[], products: ProductType[]) {
  const orderSpy = jest.spyOn(OrderCls, "findAll").mockResolvedValue(orders as any);
  const productSpy = jest.spyOn(ProductCls, "findAll").mockResolvedValue(products as any);
  return { orderSpy, productSpy };
}

describe("reports.service — monthRange / getMonthlyReport (Parte 10)", () => {
  // Regresión de la Fase N.4, gemela de la de dashboard.test.ts: `Order.status` avanza a
  // `shipped`/`delivered` al despacharse, así que filtrar las ventas por `status` borraba del
  // reporte mensual todo pedido ya enviado. El predicado correcto es `paymentStatus: "paid"`.
  it("carga las ventas por paymentStatus, no por status (un pedido enviado sigue contando)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const { orderSpy } = mockLoad([], []);

    await reports.getMonthlyReport();

    expect(orderSpy).toHaveBeenCalledTimes(1);
    const where = (orderSpy.mock.calls[0][0] as any).where;
    expect(where.paymentStatus).toBe("paid");
    expect(where.status).toBeUndefined();
  });

  it("sin huecos entre el mes de la primera orden pagada y el mes UTC actual", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const order = buildOrder({
      id: 1,
      createdAt: new Date("2026-04-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 1 })],
    });
    mockLoad([order], [buildProduct({ id: 1 })]);

    const monthly = await reports.getMonthlyReport();

    expect(monthly.map((m) => m.key)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07"]);
    expect(monthly.filter((m) => m.partial)).toHaveLength(1);
    expect(monthly[monthly.length - 1].partial).toBe(true);
  });

  it("clamp al mes actual cuando la orden más antigua queda después de 'to' (createdAt corrupto/futuro)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const futureOrder = buildOrder({
      id: 1,
      createdAt: new Date("2026-09-01T00:00:00Z"), // después de "ahora"
      items: [buildOrderItem({ productId: 1 })],
    });
    mockLoad([futureOrder], [buildProduct({ id: 1 })]);

    const monthly = await reports.getMonthlyReport();

    expect(monthly).toHaveLength(1);
    expect(monthly[0].key).toBe("2026-07");
    expect(monthly[0].partial).toBe(true);
  });

  it("byProduct: todo producto vivo entra en cada mes (0 si no vendió); un descontinuado solo en los meses donde vendió", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const liveA = buildProduct({ id: 1, name: "Vivo A" });
    const liveB = buildProduct({ id: 2, name: "Vivo B" });
    const discontinued = buildProduct({ id: 3, name: "Descontinuado", deletedAt: new Date("2026-06-20") });

    const orderJune = buildOrder({
      id: 1,
      createdAt: new Date("2026-06-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 3, quantity: 2 })], // vendió el descontinuado
    });
    const orderJuly = buildOrder({
      id: 2,
      createdAt: new Date("2026-07-05T00:00:00Z"),
      items: [buildOrderItem({ productId: 1, quantity: 1 })],
    });
    mockLoad([orderJune, orderJuly], [liveA, liveB, discontinued]);

    const monthly = await reports.getMonthlyReport();
    const june = monthly.find((m) => m.key === "2026-06")!;
    const july = monthly.find((m) => m.key === "2026-07")!;

    expect(june.byProduct.map((p) => p.productId).sort()).toEqual([1, 2, 3]);
    expect(june.byProduct.find((p) => p.productId === 3)!.unitsSold).toBe(2);
    expect(june.byProduct.find((p) => p.productId === 1)!.unitsSold).toBe(0);

    // Julio: el descontinuado no vendió → no aparece; los vivos sí (con 0 si no vendieron).
    expect(july.byProduct.map((p) => p.productId).sort()).toEqual([1, 2]);
    expect(july.byProduct.find((p) => p.productId === 1)!.unitsSold).toBe(1);
    expect(july.byProduct.find((p) => p.productId === 2)!.unitsSold).toBe(0);
  });
});

describe("reports.service — getReplenishmentReport (Parte 10)", () => {
  it("cero meses completos (primer mes de la tienda): usa el mes parcial en curso como único dato", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const product = buildProduct({ id: 1, stock: 4 });
    const order = buildOrder({
      id: 1,
      createdAt: new Date("2026-07-05T00:00:00Z"), // mismo mes que "ahora" → sin meses completos
      items: [buildOrderItem({ productId: 1, quantity: 3 })],
    });
    mockLoad([order], [product]);

    const rows = await reports.getReplenishmentReport();
    const row = rows.find((r) => r.productId === 1)!;

    expect(row.forecastNextMonth).toBe(3);
    expect(row.forecastMethod).toBe("promedio-simple");
    expect(row.confidence).toBe("baja");
  });

  it("effectiveForecast actúa como piso cuando forecastNextMonth redondea a 0 pero hay historial de ventas", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const product = buildProduct({ id: 1, stock: 5 });
    // 4 meses completos antes de julio: marzo(2)-abril(0)-mayo(0)-junio(0). Con
    // suavización exponencial esta serie decae a un forecast redondeado de 0 (ver
    // cálculo a mano en reports.service.ts), pero avgUnits = 0.5 > 0.
    const orderMarch = buildOrder({
      id: 1,
      createdAt: new Date("2026-03-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 1, quantity: 2 })],
    });
    mockLoad([orderMarch], [product]);

    const rows = await reports.getReplenishmentReport();
    const row = rows.find((r) => r.productId === 1)!;

    expect(row.forecastMethod).toBe("suavizacion-exponencial"); // 4 meses completos en la serie
    expect(row.forecastNextMonth).toBe(0); // redondea a 0
    // Si no hubiera piso, diasCobertura caería al sentinela 999 (sin ventas pronosticadas).
    // Con el piso (avgUnits 0.5): round(5 / 0.5 * 30) = 300.
    expect(row.diasCobertura).toBe(300);
    expect(row.diasCobertura).not.toBe(999);
  });

  it("recorta los meses en $0 ANTES de la primera venta; conserva los de DESPUÉS", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    // El rango de meses lo fija la orden más antigua de TODA la tienda (marzo, vía otro
    // producto) — eso es lo que le arrastra a productX una cola de ceros previos a su
    // propia primera venta (mayo). 4 meses completos antes de julio: marzo(0)-abril(0)-
    // mayo(3)-junio(0). Sin recorte serían 4 puntos (suavización exponencial);
    // recortando los 2 ceros iniciales quedan solo 2 puntos [3, 0] (promedio simple) —
    // el cambio de método es lo que prueba el recorte.
    const productX = buildProduct({ id: 1, stock: 10 });
    const otherProduct = buildProduct({ id: 2, stock: 10 });
    const orderMarch = buildOrder({
      id: 1,
      createdAt: new Date("2026-03-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 2, quantity: 1 })], // fija el inicio del rango en marzo
    });
    const orderMay = buildOrder({
      id: 2,
      createdAt: new Date("2026-05-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 1, quantity: 3 })], // primera venta real de productX
    });
    mockLoad([orderMarch, orderMay], [productX, otherProduct]);

    const rows = await reports.getReplenishmentReport();
    const row = rows.find((r) => r.productId === 1)!;

    expect(row.forecastMethod).toBe("promedio-simple"); // serie recortada a 2 puntos, no 4
    expect(row.confidence).toBe("baja");
    expect(row.forecastNextMonth).toBe(2); // round((3+0)/2) = round(1.5) = 2
  });

  it("un producto descontinuado no aparece en la reposición aunque tenga historial de ventas", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const discontinued = buildProduct({ id: 1, stock: 2, deletedAt: new Date("2026-06-01") });
    const order = buildOrder({
      id: 1,
      createdAt: new Date("2026-06-10T00:00:00Z"),
      items: [buildOrderItem({ productId: 1, quantity: 2 })],
    });
    mockLoad([order], [discontinued]);

    const rows = await reports.getReplenishmentReport();

    expect(rows.find((r) => r.productId === 1)).toBeUndefined();
  });
});

describe("reports.service — loadReportData: cache con TTL 60s (Parte 10)", () => {
  it("una segunda llamada dentro del TTL no vuelve a consultar la BD (comparte cache entre monthly y replenishment)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const { orderSpy, productSpy } = mockLoad([], [buildProduct({ id: 1 })]);

    await reports.getMonthlyReport();
    await reports.getReplenishmentReport();

    expect(orderSpy).toHaveBeenCalledTimes(1);
    expect(productSpy).toHaveBeenCalledTimes(1);
  });

  it("pasado el TTL de 60s, la siguiente llamada vuelve a consultar la BD", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const { orderSpy } = mockLoad([], [buildProduct({ id: 1 })]);

    await reports.getMonthlyReport();
    expect(orderSpy).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date("2026-07-15T12:01:01Z")); // 61s después
    await reports.getMonthlyReport();

    expect(orderSpy).toHaveBeenCalledTimes(2);
  });

  it("un fetch que rechaza limpia el cache de inmediato en vez de repetir el error hasta que expire el TTL", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const orderSpy = jest
      .spyOn(OrderCls, "findAll")
      .mockRejectedValueOnce(new Error("Postgres caído"))
      .mockResolvedValueOnce([]);
    jest.spyOn(ProductCls, "findAll").mockResolvedValue([buildProduct({ id: 1 })] as any);

    await expect(reports.getMonthlyReport()).rejects.toThrow("Postgres caído");
    // Llamada inmediatamente después (mismo segundo, muy dentro de los 60s del TTL): si
    // el cache no se limpiara al fallar, esta reutilizaría la promesa rechazada.
    await expect(reports.getMonthlyReport()).resolves.toBeDefined();

    expect(orderSpy).toHaveBeenCalledTimes(2);
  });
});
