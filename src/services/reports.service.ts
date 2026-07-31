import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { Product } from "../models/Product";
import { productSizesInclude } from "../utils/productSizesInclude";
import { isoMonth, formatMonthLabel, monthRange, utcMonthStart } from "../utils/date";
import {
  computeForecast,
  type Confidence,
  type ForecastMethod,
  type TrendDirection,
} from "./forecast";

export interface MonthlyProductSales {
  productId: number;
  name: string;
  type: string;
  unitsSold: number;
  revenue: number;
  unitCost: number;
}

export interface MonthlyCategoryBreakdown {
  category: string;
  label: string;
  revenue: number;
  units: number;
}

export interface MonthlyReport {
  key: string;
  label: string;
  partial?: boolean;
  totalRevenue: number;
  totalUnits: number;
  byProduct: MonthlyProductSales[];
  byCategory: MonthlyCategoryBreakdown[];
}

export interface ReplenishmentRow {
  productId: number;
  name: string;
  type: string;
  currentStock: number;
  forecastNextMonth: number;
  forecastMethod: ForecastMethod;
  forecastMethodLabel: string;
  trend: TrendDirection;
  confidence: Confidence;
  diasCobertura: number;
  ingresoMensual: number;
  margenMensual: number;
  suggestedOrder: number;
  costoEstimadoPedido: number;
  priority: "urgente" | "pronto" | "ok";
}

// Etiqueta plural de cada categoría — réplica de frontend/lib/categories.ts.
const CATEGORY_PLURAL: Record<string, string> = {
  bota: "Botas",
  sombrero: "Sombreros",
  ropa: "Ropa",
};

const PRIORITY_RANK: Record<ReplenishmentRow["priority"], number> = {
  urgente: 0,
  pronto: 1,
  ok: 2,
};

// Vida del cache de loadReportData. No hay tablas de agregación en este backend (ver
// CLAUDE.md) y ambos reportes recorren el historial completo de órdenes pagadas en cada
// llamada; un cache in-memory de vida corta evita que una misma carga de página (que
// típicamente pide /monthly y /replenishment casi al mismo tiempo) dispare el escaneo
// completo dos veces, y limita el costo a lo sumo una vez por minuto bajo uso normal,
// sin introducir una tabla de agregación ni un cache externo.
const REPORT_CACHE_TTL_MS = 60_000;

let cachedReportData: Promise<{ orders: Order[]; products: Product[] }> | null = null;
let cacheExpiresAt = 0;

// Carga única de órdenes pagadas (con items) y productos (con tallas), compartida
// por ambos reportes. Aquí se traen TODOS los productos, incluidos los descontinuados
// (soft-delete): un producto con historial de ventas se soft-borra justo por estar
// referenciado por un OrderItem (ver CLAUDE.md), y si lo excluyéramos sus ventas
// pasadas desaparecerían de los reportes mensuales. Cada consumidor decide qué hacer
// con los descontinuados (el mensual los conserva en su histórico; reposición los omite).
// Los atributos de Order/OrderItem se limitan a los que realmente se leen más abajo
// (createdAt, productId, quantity) — el resto (direcciones, snapshots de precio, etc.)
// se hidrataría sin usarse en ninguno de los dos reportes.
function loadReportData(): Promise<{ orders: Order[]; products: Product[] }> {
  const now = Date.now();
  if (cachedReportData && cacheExpiresAt > now) return cachedReportData;

  cacheExpiresAt = now + REPORT_CACHE_TTL_MS;
  cachedReportData = Promise.all([
    Order.findAll({
      // `paymentStatus` y NO `status` (arreglo de la Fase N.4): `Order.status` avanza a
      // `shipped`/`delivered` en cuanto la guía reporta actividad (o el dueño lo marca a mano con
      // el `PATCH /status` de la Fase O.1), así que filtrar por `status: "paid"` hacía que **un
      // pedido desapareciera de los reportes al despacharse**. `paymentStatus: "paid"` significa
      // "el dinero entró y no se ha devuelto": sobrevive a `shipped`/`delivered` y solo cambia a
      // `refunded` (reembolso real) o `failed` (pendiente liberado).
      where: { paymentStatus: "paid" },
      attributes: ["id", "createdAt"],
      include: [{ model: OrderItem, as: "items", attributes: ["productId", "quantity"] }],
      order: [["createdAt", "ASC"]],
    }),
    Product.findAll({
      include: [productSizesInclude],
    }),
  ]).then(([orders, products]) => ({ orders, products }));

  // No cachear un fallo: la próxima llamada debe reintentar la carga en vez de repetir
  // el mismo error hasta que expire el TTL.
  cachedReportData.catch(() => {
    cachedReportData = null;
    cacheExpiresAt = 0;
  });

  return cachedReportData;
}

function buildMonthlyReports(orders: Order[], products: Product[]): MonthlyReport[] {
  const now = new Date();
  const currentMonthKey = isoMonth(now);

  // monthKey -> (productId -> unidades vendidas)
  const unitsByMonth = new Map<string, Map<number, number>>();
  for (const order of orders) {
    const key = isoMonth(order.createdAt);
    let perProduct = unitsByMonth.get(key);
    if (!perProduct) {
      perProduct = new Map<number, number>();
      unitsByMonth.set(key, perProduct);
    }
    for (const item of order.items ?? []) {
      perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + item.quantity);
    }
  }

  // Los productos vivos entran en TODOS los meses (0 si no vendieron ese mes). Los
  // descontinuados (soft-delete) ya no están vivos, pero conservan su histórico:
  // aparecen solo en los meses donde efectivamente vendieron, para no borrar ventas
  // pasadas al dar de baja un producto con historial (ni ensuciar meses sin actividad).
  const activeIds = products.filter((p) => p.deletedAt == null).map((p) => p.id);
  const productById = new Map<number, Product>(products.map((p) => [p.id, p]));

  // Rango: del mes de la orden más antigua al mes en curso, inclusive.
  const firstOrder = orders[0];
  const from = firstOrder ? firstOrder.createdAt : now;
  const months = monthRange(from, now);

  return months.map((monthDate) => {
    const key = isoMonth(monthDate);
    const perProduct = unitsByMonth.get(key);

    // IDs del mes: todos los vivos + cualquier descontinuado con ventas ese mes.
    const monthIds = new Set<number>(activeIds);
    if (perProduct) for (const pid of perProduct.keys()) monthIds.add(pid);

    const byProduct: MonthlyProductSales[] = Array.from(monthIds)
      .map((pid): MonthlyProductSales | null => {
        const p = productById.get(pid);
        if (!p) return null; // producto borrado en duro (no ocurre si tuvo ventas)
        const unitsSold = perProduct?.get(pid) ?? 0;
        return {
          productId: p.id,
          name: p.name,
          type: p.type,
          unitsSold,
          revenue: unitsSold * p.salePrice,
          unitCost: p.unitCost,
        };
      })
      .filter((r): r is MonthlyProductSales => r !== null)
      .sort((a, b) => b.unitsSold - a.unitsSold);

    const categoryMap = new Map<string, { revenue: number; units: number }>();
    for (const p of byProduct) {
      const acc = categoryMap.get(p.type) ?? { revenue: 0, units: 0 };
      acc.revenue += p.revenue;
      acc.units += p.unitsSold;
      categoryMap.set(p.type, acc);
    }
    const byCategory: MonthlyCategoryBreakdown[] = Array.from(categoryMap.entries())
      .map(([category, agg]) => ({
        category,
        label: CATEGORY_PLURAL[category] ?? category,
        revenue: agg.revenue,
        units: agg.units,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = byProduct.reduce((s, p) => s + p.revenue, 0);
    const totalUnits = byProduct.reduce((s, p) => s + p.unitsSold, 0);

    const report: MonthlyReport = {
      key,
      label: formatMonthLabel(monthDate),
      totalRevenue,
      totalUnits,
      byProduct,
      byCategory,
    };
    if (key === currentMonthKey) report.partial = true;
    return report;
  });
}

export async function getMonthlyReport(): Promise<MonthlyReport[]> {
  const { orders, products } = await loadReportData();
  return buildMonthlyReports(orders, products);
}

export async function getReplenishmentReport(): Promise<ReplenishmentRow[]> {
  const { orders, products } = await loadReportData();
  const monthlyReports = buildMonthlyReports(orders, products);

  // El pronóstico usa solo meses completos (excluye el mes en curso) para no mezclar un
  // mes a medio cerrar con meses ya cerrados. Excepción: si todavía no hay NINGÚN mes
  // completo (tienda recién lanzada, dentro de su primer mes de vida), esa regla dejaría
  // la serie siempre vacía y ocultaría un agotamiento real del día 1 hasta que termine el
  // mes — en ese caso puntual se usa el mes en curso (parcial) como única fuente, un solo
  // punto de baja confianza en vez de "sin datos" completo.
  const fullMonths = monthlyReports.filter((r) => !r.partial);
  const currentMonth = monthlyReports.find((r) => r.partial);
  const forecastMonths = fullMonths.length > 0 ? fullMonths : currentMonth ? [currentMonth] : [];

  // Solo se repone lo que sigue vivo; los descontinuados (soft-delete) quedan fuera
  // aunque conserven historial en el reporte mensual.
  const activeProducts = products.filter((p) => p.deletedAt == null);

  // productId -> unitsSold por mes de forecastMonths, transpuesto una sola vez. Evita un
  // .find() por cada combinación producto×mes (O(meses×productos²)) dentro del .map()
  // de más abajo, que con catálogos grandes escala mal.
  const unitsByMonthMaps = forecastMonths.map(
    (m) => new Map(m.byProduct.map((p) => [p.productId, p.unitsSold])),
  );

  const rows: ReplenishmentRow[] = activeProducts.map((product) => {
    const rawSeries = unitsByMonthMaps.map((m) => m.get(product.id) ?? 0);
    // Se recortan los ceros iniciales previos a la primera venta del producto. El
    // rango de meses arranca en la orden pagada más antigua de TODA la tienda, así
    // que un producto agregado hace poco arrastraría una cola de $0 de meses en que
    // aún no existía. Esos ceros falsos diluyen el promedio (ingreso/margen/pedido
    // sugerido) y, al ser 4+ puntos, empujan el pronóstico a la suavización
    // exponencial con nivel inicial 0 (subestimando la demanda). La serie empieza en
    // el primer mes con ventas; los ceros POSTERIORES sí son demanda real (el
    // producto ya existía y no vendió) y se conservan. Sin ventas → serie vacía →
    // computeForecast devuelve 0 / "Sin datos".
    const firstSale = rawSeries.findIndex((units) => units > 0);
    const monthlySales = firstSale === -1 ? [] : rawSeries.slice(firstSale);
    const forecast = computeForecast(monthlySales);

    const avgUnits =
      monthlySales.length > 0
        ? monthlySales.reduce((a, b) => a + b, 0) / monthlySales.length
        : 0;

    const ingresoMensual = Math.round(avgUnits * product.salePrice);
    const margenMensual = Math.round(avgUnits * (product.salePrice - product.unitCost));

    // forecast.forecastNextMonth viene redondeado a entero (forecast.ts): una demanda
    // real pero baja (p. ej. ~0.4 u/mes) puede redondear a 0 y, con el sentinela de abajo,
    // ocultar la reposición cuando el producto ya se agotó. Si hubo historial de ventas
    // real (avgUnits > 0) pero el pronóstico redondeó a 0, se usa avgUnits como piso para
    // no perder la señal de cobertura/cantidad sugerida.
    const effectiveForecast = forecast.forecastNextMonth > 0 ? forecast.forecastNextMonth : avgUnits;

    const diasCobertura =
      effectiveForecast > 0
        ? Math.round((product.stock / effectiveForecast) * 30)
        : 999; // sentinela: sin ventas pronosticadas ni historial

    const suggestedOrder = Math.max(
      0,
      Math.round(effectiveForecast * 2) - product.stock,
    );

    const priority: ReplenishmentRow["priority"] =
      diasCobertura < 15 ? "urgente" : diasCobertura < 45 ? "pronto" : "ok";

    return {
      productId: product.id,
      name: product.name,
      type: product.type,
      currentStock: product.stock,
      forecastNextMonth: forecast.forecastNextMonth,
      forecastMethod: forecast.method,
      forecastMethodLabel: forecast.methodLabel,
      trend: forecast.trend,
      confidence: forecast.confidence,
      diasCobertura,
      ingresoMensual,
      margenMensual,
      suggestedOrder,
      costoEstimadoPedido: suggestedOrder * product.unitCost,
      priority,
    };
  });

  // Orden: urgencia de cobertura primero; dentro de cada nivel, margen mensual desc.
  return rows.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.margenMensual - a.margenMensual,
  );
}
