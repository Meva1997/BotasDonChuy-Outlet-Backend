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
  kpis: KpiData[];
  profitKpis: KpiData[];
  revenueByPeriod: Record<Period, RevenuePoint[]>;
  recentSales: SaleRow[];
  inventory: InventoryRow[];
}

// Gastos fijos mensuales de operación (dominio + comisión de pasarela estimada).
// No existe un modelo de gastos en el roadmap — placeholder hasta que exista esa feature.
const GASTOS_FIJOS = 2000;
const RECENT_SALES_LIMIT = 20;
const REVENUE_WINDOW_DAYS = 90;
const KPI_WINDOW_DAYS = 30;

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

function buildRevenuePeriod(dailyRevenue: Map<string, number>, days: number, todayStart: Date): RevenuePoint[] {
  const points: RevenuePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addDays(todayStart, -i);
    points.push({
      date: formatShortDate(day),
      revenue: dailyRevenue.get(isoDay(day)) ?? 0,
    });
  }
  return points;
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
  const since90 = addDays(todayStart, -(REVENUE_WINDOW_DAYS - 1));

  const [orders90, recentOrders, products] = await Promise.all([
    Order.findAll({
      where: {
        status: "paid",
        createdAt: { [Op.gte]: since90 },
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

  const dailyRevenue = new Map<string, number>();
  for (const order of orders90) {
    const key = isoDay(order.createdAt);
    dailyRevenue.set(key, (dailyRevenue.get(key) ?? 0) + order.total);
  }

  const revenueByPeriod: Record<Period, RevenuePoint[]> = {
    "7": buildRevenuePeriod(dailyRevenue, 7, todayStart),
    "30": buildRevenuePeriod(dailyRevenue, 30, todayStart),
    "90": buildRevenuePeriod(dailyRevenue, REVENUE_WINDOW_DAYS, todayStart),
  };

  const currentWindowStart = addDays(todayStart, -(KPI_WINDOW_DAYS - 1));
  const previousWindowStart = addDays(todayStart, -(2 * KPI_WINDOW_DAYS - 1));
  const previousWindowEnd = currentWindowStart;

  const currentOrders = orders90.filter((o) => o.createdAt >= currentWindowStart);
  const previousOrders = orders90.filter(
    (o) => o.createdAt >= previousWindowStart && o.createdAt < previousWindowEnd,
  );

  const ingresos = currentOrders.reduce((acc, o) => acc + o.total, 0);
  const ingresosPrev = previousOrders.reduce((acc, o) => acc + o.total, 0);
  const piezasVendidas = currentOrders.reduce(
    (acc, o) => acc + (o.items ?? []).reduce((a, i) => a + i.quantity, 0),
    0,
  );
  const ticketPromedio = currentOrders.length ? ingresos / currentOrders.length : 0;

  let mejorDia: { date: Date; revenue: number } | null = null;
  for (let i = 0; i < KPI_WINDOW_DAYS; i += 1) {
    const day = addDays(currentWindowStart, i);
    const revenue = dailyRevenue.get(isoDay(day)) ?? 0;
    if (!mejorDia || revenue > mejorDia.revenue) {
      mejorDia = { date: day, revenue };
    }
  }

  const cogs = currentOrders.reduce((acc, o) => acc + orderCost(o), 0);
  const cogsPrev = previousOrders.reduce((acc, o) => acc + orderCost(o), 0);
  const gananciaBruta = ingresos - cogs;
  const gananciaBrutaPrev = ingresosPrev - cogsPrev;
  const margenBruto = ingresos ? Math.round((gananciaBruta / ingresos) * 100) : 0;
  const gananciaNeta = gananciaBruta - GASTOS_FIJOS;
  const gananciaNetaPrev = gananciaBrutaPrev - GASTOS_FIJOS;

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
    { label: "GASTOS FIJOS / MES", value: formatMoney(GASTOS_FIJOS), subtitle: "dominio · comisión pasarela" },
    {
      label: "GANANCIA NETA",
      value: formatMoney(gananciaNeta),
      trend: computeTrend(gananciaNeta, gananciaNetaPrev),
    },
  ];

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

  return { kpis, profitKpis, revenueByPeriod, recentSales, inventory };
}
