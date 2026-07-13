import { Op, type WhereOptions } from "sequelize";
import { Order, type OrderAttributes } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { Product } from "../models/Product";
import { productSizesInclude } from "../utils/productSizesInclude";
import { addDays, formatShortDate, isoDay, utcDayStart } from "../utils/date";

export interface KpiData {
  label: string;
  value: string;
  trend?: { label: string; positive: boolean };
  subtitle?: string;
}

export interface RevenuePoint {
  date: string;
  revenue: number;
}

export type Period = "7" | "30" | "90";

export interface SaleRow {
  id: string;
  date: string;
  day: string; // clave ISO en UTC ("2026-07-13") para filtrar por día en el front
  pieces: number;
  items: string;
  savings: number;
  total: number;
  costoTotal: number;
}

export interface InventoryRow {
  id: number;
  name: string;
  type: string;
  stock: number;
  salePrice: number;
  unitCost: number;
  valorInventario: number;
}

export interface DashboardData {
  kpisByPeriod: Record<Period, KpiData[]>;
  profitKpisByPeriod: Record<Period, KpiData[]>;
  revenueByPeriod: Record<Period, RevenuePoint[]>;
  recentSales: SaleRow[];
  inventory: InventoryRow[];
}

// Gastos fijos mensuales de operación (dominio + comisión de pasarela estimada).
// No existe un modelo de gastos en el roadmap — placeholder hasta que exista esa feature.
const GASTOS_FIJOS = 2000;
const RECENT_SALES_LIMIT = 20;
const REVENUE_WINDOW_DAYS = 90;
const PERIODS: Period[] = ["7", "30", "90"];

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computeTrend(current: number, previous: number): { label: string; positive: boolean } | undefined {
  if (previous === 0) return undefined;
  // Se divide entre |previous| para que una base negativa (p. ej. ganancia neta
  // en rojo) no invierta el signo: pasar de -2000 a -500 es una mejora (+75%),
  // no una caída.
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return {
    label: `${pct >= 0 ? "+" : ""}${pct}% vs periodo anterior`,
    positive: pct >= 0,
  };
}

function orderCost(order: Order): number {
  return (order.items ?? []).reduce((acc, item) => acc + item.unitCost * item.quantity, 0);
}

// Agregado por día calendario (UTC), acumulado en una sola pasada sobre el
// historial. Las tres ventanas de KPIs (7/30/90) y sus periodos previos se
// suman desde este mapa en vez de re-escanear ordersHistory por ventana.
interface DayAggregate {
  revenue: number;
  cogs: number;
  pieces: number;
  orders: number;
}

function buildDailyAggregates(orders: Order[]): Map<string, DayAggregate> {
  const byDay = new Map<string, DayAggregate>();
  for (const order of orders) {
    const key = isoDay(order.createdAt);
    let agg = byDay.get(key);
    if (!agg) {
      agg = { revenue: 0, cogs: 0, pieces: 0, orders: 0 };
      byDay.set(key, agg);
    }
    agg.revenue += order.total;
    agg.cogs += orderCost(order);
    agg.pieces += (order.items ?? []).reduce((a, i) => a + i.quantity, 0);
    agg.orders += 1;
  }
  return byDay;
}

function buildRevenuePeriod(dailyAgg: Map<string, DayAggregate>, days: number, todayStart: Date): RevenuePoint[] {
  const points: RevenuePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addDays(todayStart, -i);
    points.push({
      date: formatShortDate(day),
      revenue: dailyAgg.get(isoDay(day))?.revenue ?? 0,
    });
  }
  return points;
}

function buildKpisForWindow(
  dailyAgg: Map<string, DayAggregate>,
  windowDays: number,
  todayStart: Date,
): { kpis: KpiData[]; profitKpis: KpiData[] } {
  const currentWindowStart = addDays(todayStart, -(windowDays - 1));
  const previousWindowStart = addDays(todayStart, -(2 * windowDays - 1));

  let ingresos = 0;
  let cogs = 0;
  let piezasVendidas = 0;
  let currentOrderCount = 0;
  let ingresosPrev = 0;
  let cogsPrev = 0;
  let mejorDia: { date: Date; revenue: number } | null = null;

  for (let i = 0; i < windowDays; i += 1) {
    const day = addDays(currentWindowStart, i);
    const agg = dailyAgg.get(isoDay(day));
    const revenue = agg?.revenue ?? 0;
    ingresos += revenue;
    cogs += agg?.cogs ?? 0;
    piezasVendidas += agg?.pieces ?? 0;
    currentOrderCount += agg?.orders ?? 0;
    if (!mejorDia || revenue > mejorDia.revenue) {
      mejorDia = { date: day, revenue };
    }

    const prevAgg = dailyAgg.get(isoDay(addDays(previousWindowStart, i)));
    ingresosPrev += prevAgg?.revenue ?? 0;
    cogsPrev += prevAgg?.cogs ?? 0;
  }

  const ticketPromedio = currentOrderCount ? ingresos / currentOrderCount : 0;

  const gananciaBruta = ingresos - cogs;
  const gananciaBrutaPrev = ingresosPrev - cogsPrev;
  const margenBruto = ingresos ? Math.round((gananciaBruta / ingresos) * 100) : 0;
  // Gastos fijos prorrateados a la ventana seleccionada (el placeholder es mensual).
  const gastosFijosWindow = GASTOS_FIJOS * (windowDays / 30);
  const gananciaNeta = gananciaBruta - gastosFijosWindow;
  const gananciaNetaPrev = gananciaBrutaPrev - gastosFijosWindow;

  const kpis: KpiData[] = [
    { label: "INGRESOS", value: formatMoney(ingresos), trend: computeTrend(ingresos, ingresosPrev) },
    { label: "PIEZAS VENDIDAS", value: piezasVendidas.toLocaleString("es-MX") },
    { label: "TICKET PROMEDIO", value: formatMoney(ticketPromedio) },
    {
      label: "MEJOR DÍA",
      value: formatMoney(mejorDia?.revenue ?? 0),
      subtitle: mejorDia ? formatShortDate(mejorDia.date) : undefined,
    },
  ];

  const profitKpis: KpiData[] = [
    {
      label: "GANANCIA BRUTA",
      value: formatMoney(gananciaBruta),
      trend: computeTrend(gananciaBruta, gananciaBrutaPrev),
    },
    { label: "MARGEN BRUTO", value: `${margenBruto}%`, subtitle: "sobre precio de venta outlet" },
    {
      label: "GASTOS FIJOS",
      value: formatMoney(gastosFijosWindow),
      subtitle: `estimado · ventana de ${windowDays} días`,
    },
    {
      label: "GANANCIA NETA",
      value: formatMoney(gananciaNeta),
      trend: computeTrend(gananciaNeta, gananciaNetaPrev),
    },
  ];

  return { kpis, profitKpis };
}

function buildSaleRow(order: Order): SaleRow {
  const items = order.items ?? [];
  const pieces = items.reduce((acc, item) => acc + item.quantity, 0);
  const itemsLabel = items
    .map((item) => `${item.nameSnapshot}${item.quantity > 1 ? ` ×${item.quantity}` : ""}`)
    .join(", ");
  const date = `${formatShortDate(order.createdAt)} · ${order.createdAt.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })}`;

  return {
    id: String(order.id),
    date,
    day: isoDay(order.createdAt),
    pieces,
    items: itemsLabel,
    savings: order.savings,
    total: order.total,
    costoTotal: orderCost(order),
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const now = new Date();
  const todayStart = utcDayStart(now);
  // La ventana de KPIs más ancha (90 días) necesita otros 90 días previos para
  // el trend "vs periodo anterior" → se buscan 180 días de historial.
  const sinceHistory = addDays(todayStart, -(2 * REVENUE_WINDOW_DAYS - 1));

  const [ordersHistory, recentOrders, products] = await Promise.all([
    Order.findAll({
      where: {
        status: "paid",
        createdAt: { [Op.gte]: sinceHistory },
      } as WhereOptions<OrderAttributes>,
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "ASC"]],
    }),
    Order.findAll({
      where: { status: "paid" },
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: RECENT_SALES_LIMIT,
    }),
    Product.findAll({
      where: { deletedAt: { [Op.is]: null } },
      include: [productSizesInclude],
    }),
  ]);

  const dailyAgg = buildDailyAggregates(ordersHistory);

  const revenueByPeriod: Record<Period, RevenuePoint[]> = {
    "7": buildRevenuePeriod(dailyAgg, 7, todayStart),
    "30": buildRevenuePeriod(dailyAgg, 30, todayStart),
    "90": buildRevenuePeriod(dailyAgg, REVENUE_WINDOW_DAYS, todayStart),
  };

  const kpisByPeriod = {} as Record<Period, KpiData[]>;
  const profitKpisByPeriod = {} as Record<Period, KpiData[]>;
  for (const period of PERIODS) {
    const { kpis, profitKpis } = buildKpisForWindow(dailyAgg, Number(period), todayStart);
    kpisByPeriod[period] = kpis;
    profitKpisByPeriod[period] = profitKpis;
  }

  const recentSales = recentOrders.map(buildSaleRow);

  const inventory: InventoryRow[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    stock: p.stock,
    salePrice: p.salePrice,
    unitCost: p.unitCost,
    valorInventario: p.stock * p.unitCost,
  }));

  return { kpisByPeriod, profitKpisByPeriod, revenueByPeriod, recentSales, inventory };
}
