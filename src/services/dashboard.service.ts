import { Op, type WhereOptions } from "sequelize";
import { Order, type OrderAttributes } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { Product } from "../models/Product";
import { productSizesInclude } from "../utils/productSizesInclude";
import { addDays, formatShortDate, isoDay, utcDayStart } from "../utils/date";
import { formatMoney } from "../utils/formatMoney";
import {
  loadExpenses,
  oneTimeExpensesByDay,
  totalMonthlyRunRate,
} from "./expenses.service";

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
  /** Ahorro outlet (`originalPrice` vs `salePrice`). NO incluye el cupón. */
  savings: number;
  /**
   * Descuento por cupón (Fase N.2). Sin estos dos campos la fila es irreconciliable: `savings`
   * es solo el ahorro outlet y `total` ya viene neto de cupón, así que
   * `subtotal − savings + envío ≠ total` sin ninguna causa visible en el panel.
   */
  couponCode: string | null;
  couponDiscount: number;
  /**
   * Envío cobrado en este pedido — que es también lo que se le paga a la paquetería (ver el KPI
   * `COSTO DE ENVÍO`). Va en la fila porque sin él la ganancia real del pedido no se puede sacar
   * del panel: `total` ya trae el envío sumado, así que lo que gana la tienda es
   * `total − shipping − costoTotal`, no `total − costoTotal`.
   */
  shipping: number;
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

const RECENT_SALES_LIMIT = 20;
const REVENUE_WINDOW_DAYS = 90;
const PERIODS: Period[] = ["7", "30", "90"];

function computeTrend(
  current: number,
  previous: number,
  // `lowerIsBetter` NO cambia el `label` (el porcentaje sigue siendo el mismo dato), solo de qué
  // color lo pinta el front, que lee `positive`. Hace falta en los KPIs que son COSTOS: sin él,
  // "el costo de envío subió 40%" saldría en verde, que es activamente engañoso. `DESCUENTOS POR
  // CUPÓN` tiene hoy esa misma inconsistencia y se deja como está a propósito (un cupón caro no es
  // inequívocamente malo: es el precio de vender más); `GASTOS` deliberadamente no lleva trend.
  { lowerIsBetter = false }: { lowerIsBetter?: boolean } = {},
): { label: string; positive: boolean } | undefined {
  if (previous === 0) return undefined;
  // Se divide entre |previous| para que una base negativa (p. ej. ganancia neta
  // en rojo) no invierta el signo: pasar de -2000 a -500 es una mejora (+75%),
  // no una caída.
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return {
    label: `${pct >= 0 ? "+" : ""}${pct}% vs periodo anterior`,
    positive: lowerIsBetter ? pct <= 0 : pct >= 0,
  };
}

function orderCost(order: Order): number {
  return (order.items ?? []).reduce(
    (acc, item) => acc + item.unitCost * item.quantity,
    0,
  );
}

// Agregado por día calendario (UTC), acumulado en una sola pasada sobre el
// historial. Las tres ventanas de KPIs (7/30/90) y sus periodos previos se
// suman desde este mapa en vez de re-escanear ordersHistory por ventana.
interface DayAggregate {
  revenue: number;
  cogs: number;
  pieces: number;
  orders: number;
  /** Descuento otorgado por cupones ese día (Fase N.2). Ver el KPI del mismo nombre. */
  couponDiscount: number;
  /**
   * Envío cobrado ese día = lo que se le paga a la paquetería. Con cotización viva de Skydropx es
   * el `rate.total` exacto (pass-through, sin margen); con la tarifa plana de respaldo es la tabla
   * de `cart.ts`, calibrada a costo.
   *
   * Es **costo de venta, no gasto**: se paga una guía por pedido, igual que se paga el `unitCost`
   * de cada pieza. Por eso se resta en `gananciaBruta` y NO se suma al KPI `GASTOS` — sumarlo ahí
   * lo restaría dos veces de la GANANCIA OPERATIVA.
   */
  shipping: number;
}

function buildDailyAggregates(orders: Order[]): Map<string, DayAggregate> {
  const byDay = new Map<string, DayAggregate>();
  for (const order of orders) {
    const key = isoDay(order.createdAt);
    let agg = byDay.get(key);
    if (!agg) {
      agg = {
        revenue: 0,
        cogs: 0,
        pieces: 0,
        orders: 0,
        couponDiscount: 0,
        shipping: 0,
      };
      byDay.set(key, agg);
    }
    // `order.total` ya viene NETO de cupón, y así se queda: lo que suma "INGRESOS" es el
    // efectivo realmente cobrado, que es lo correcto. El costo de la promoción se acumula
    // aparte para poder explicarlo (ver `buildKpisForWindow`).
    agg.revenue += order.total;
    agg.cogs += orderCost(order);
    // No hace falta tocar la consulta: ningún `Order.findAll` de `getDashboardData` pasa
    // `attributes`, así que la columna ya viene y el getter DECIMAL del modelo la entrega como
    // número (sin ese getter la suma concatenaría strings).
    agg.shipping += order.shipping;
    agg.pieces += (order.items ?? []).reduce((a, i) => a + i.quantity, 0);
    agg.orders += 1;
    agg.couponDiscount += order.couponDiscount;
  }
  return byDay;
}

function buildRevenuePeriod(
  dailyAgg: Map<string, DayAggregate>,
  days: number,
  todayStart: Date,
): RevenuePoint[] {
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

/**
 * Gastos que entran en una ventana (Fase N.3, sustituye la constante `GASTOS_FIJOS = 2000`).
 *
 * Son dos cosas distintas sumadas:
 *  - los **recurrentes**, como carga mensual normalizada prorrateada por `windowDays/30` — la
 *    misma semántica que ya tenía el placeholder, ahora con datos reales;
 *  - los de **única vez**, contados completos y solo si su fecha cae dentro de la ventana.
 */
interface WindowExpenses {
  /** Carga mensual recurrente vigente. */
  monthlyRunRate: number;
  recurring: number;
  oneTime: number;
  total: number;
}

function buildKpisForWindow(
  dailyAgg: Map<string, DayAggregate>,
  windowDays: number,
  todayStart: Date,
  monthlyRunRate: number,
  oneTimeByDay: Map<string, number>,
): { kpis: KpiData[]; profitKpis: KpiData[] } {
  const currentWindowStart = addDays(todayStart, -(windowDays - 1));
  const previousWindowStart = addDays(todayStart, -(2 * windowDays - 1));

  let ingresos = 0;
  let cogs = 0;
  let piezasVendidas = 0;
  let currentOrderCount = 0;
  let ingresosPrev = 0;
  let cogsPrev = 0;
  let descuentoCupones = 0;
  let descuentoCuponesPrev = 0;
  let costoEnvio = 0;
  let costoEnvioPrev = 0;
  let gastosUnicos = 0;
  let gastosUnicosPrev = 0;
  let mejorDia: { date: Date; revenue: number } | null = null;

  for (let i = 0; i < windowDays; i += 1) {
    const day = addDays(currentWindowStart, i);
    const agg = dailyAgg.get(isoDay(day));
    gastosUnicos += oneTimeByDay.get(isoDay(day)) ?? 0;
    gastosUnicosPrev +=
      oneTimeByDay.get(isoDay(addDays(previousWindowStart, i))) ?? 0;
    const revenue = agg?.revenue ?? 0;
    ingresos += revenue;
    cogs += agg?.cogs ?? 0;
    piezasVendidas += agg?.pieces ?? 0;
    currentOrderCount += agg?.orders ?? 0;
    descuentoCupones += agg?.couponDiscount ?? 0;
    costoEnvio += agg?.shipping ?? 0;
    if (!mejorDia || revenue > mejorDia.revenue) {
      mejorDia = { date: day, revenue };
    }

    const prevAgg = dailyAgg.get(isoDay(addDays(previousWindowStart, i)));
    ingresosPrev += prevAgg?.revenue ?? 0;
    cogsPrev += prevAgg?.cogs ?? 0;
    descuentoCuponesPrev += prevAgg?.couponDiscount ?? 0;
    costoEnvioPrev += prevAgg?.shipping ?? 0;
  }

  const ticketPromedio = currentOrderCount ? ingresos / currentOrderCount : 0;

  // El envío se resta aquí junto al costo del producto porque es COSTO DE VENTA (ver
  // `DayAggregate.shipping`). Hasta antes de esta fase `order.total` sumaba el envío cobrado a
  // INGRESOS y nada lo restaba, así que una venta de $2,000 con $160 de guía se leía como si los
  // $2,000 cargaran margen. El envío NO entra en `gastos` — restarlo en los dos lados lo quitaría
  // dos veces de `gananciaNeta`.
  const gananciaBruta = ingresos - cogs - costoEnvio;
  const gananciaBrutaPrev = ingresosPrev - cogsPrev - costoEnvioPrev;
  const margenBruto = ingresos
    ? Math.round((gananciaBruta / ingresos) * 100)
    : 0;

  // Los recurrentes se prorratean (la carga mensual es la misma en las dos ventanas: lo que se
  // paga hoy es lo que hay que retirar hoy), pero los de única vez **son distintos en cada una** —
  // hasta esta fase la ventana previa restaba exactamente el mismo gasto que la actual porque la
  // constante no tenía forma de variar, y eso volvía el trend de GANANCIA OPERATIVA una comparación
  // a medias. Con gastos reales cada ventana suma los suyos.
  const gastosRecurrentes = monthlyRunRate * (windowDays / 30);
  const gastos: WindowExpenses = {
    monthlyRunRate,
    recurring: gastosRecurrentes,
    oneTime: gastosUnicos,
    total: gastosRecurrentes + gastosUnicos,
  };
  const gastosPrev = gastosRecurrentes + gastosUnicosPrev;
  const gananciaNeta = gananciaBruta - gastos.total;
  const gananciaNetaPrev = gananciaBrutaPrev - gastosPrev;

  const kpis: KpiData[] = [
    {
      label: "INGRESOS",
      value: formatMoney(ingresos),
      trend: computeTrend(ingresos, ingresosPrev),
    },
    // Costo de producto de lo vendido (COGS), ya restado en GANANCIA BRUTA (ver `gananciaBruta` abajo).
    // Va aquí, en Ventas, y no solo en Rentabilidad, para que el dueño vea de un vistazo por qué
    // INGRESOS no es lo que se queda la tienda — la brecha entre este KPI y GANANCIA BRUTA es envío +
    // gastos, no un misterio.
    {
      label: "COSTO DE MERCANCÍA VENDIDA",
      value: formatMoney(cogs),
      subtitle:
        "costo unitario de las piezas vendidas · ya restado en la ganancia bruta",
    },
    { label: "PIEZAS VENDIDAS", value: piezasVendidas.toLocaleString("es-MX") },
    { label: "TICKET PROMEDIO", value: formatMoney(ticketPromedio) },
    {
      label: "MEJOR DÍA",
      value: formatMoney(mejorDia?.revenue ?? 0),
      subtitle: mejorDia ? formatShortDate(mejorDia.date) : undefined,
    },
  ];

  const profitKpis: KpiData[] = [
    // El envío es costo de venta, no gasto: se paga una guía por pedido, igual que el `unitCost` de
    // cada pieza. Aparece como KPI propio porque es el segundo costo más grande del negocio después
    // del producto y, al ir sumado dentro de `order.total`, no se ve por ningún lado en INGRESOS.
    // OJO: va restado en GANANCIA BRUTA y NO en GASTOS (ese KPI son gastos capturados) — sumarlo
    // ahí también lo restaría dos veces de la GANANCIA OPERATIVA.
    {
      label: "COSTO DE ENVÍO",
      value: formatMoney(costoEnvio),
      subtitle:
        "guías pagadas a la paquetería · ya restado en la ganancia bruta",
      trend: computeTrend(costoEnvio, costoEnvioPrev, { lowerIsBetter: true }),
    },
    // El subtítulo dice qué se descontó (el numerador), no sobre qué se divide: desde que el envío
    // es costo de venta, "sobre precio de venta outlet" ya no describía lo que cambió.
    {
      label: "MARGEN BRUTO",
      value: `${margenBruto}%`,
      subtitle: "después de producto y envío",
    },
    // Sin este KPI, una campaña de cupones se lee como una CAÍDA de ingresos contra el periodo
    // anterior (el `total` de cada pedido baja) aunque se hayan vendido más piezas, y el dueño no
    // tendría nada en pantalla que lo explique. No se suma a "Ahorraste"/`savings`, que significa
    // otra cosa —el descuento outlet— y mezclarlos falsearía el margen.
    {
      label: "DESCUENTOS POR CUPÓN",
      value: formatMoney(descuentoCupones),
      subtitle: "no incluido en el ahorro outlet",
      trend: computeTrend(descuentoCupones, descuentoCuponesPrev),
    },
    // Ya no dice "FIJOS": ahora incluye gastos de única vez, así que "fijos" sería falso. El
    // subtítulo separa las dos mitades porque un pico en este KPI tiene dos causas muy distintas
    // —subió una suscripción vs. hubo una compra puntual— y el dueño tiene que poder distinguirlas
    // sin abrir el historial.
    {
      label: "GASTOS",
      value: formatMoney(gastos.total),
      subtitle: gastos.oneTime
        ? `${formatMoney(gastos.recurring)} recurrentes + ${formatMoney(gastos.oneTime)} de única vez · ventana de ${windowDays} días`
        : `${formatMoney(gastos.monthlyRunRate)} al mes · ventana de ${windowDays} días`,
    },
    {
      label: "GANANCIA BRUTA",
      value: formatMoney(gananciaBruta),
      trend: computeTrend(gananciaBruta, gananciaBrutaPrev),
    },
    {
      label: "GANANCIA OPERATIVA",
      value: formatMoney(gananciaNeta),
      subtitle: "después de producto, envío y gastos",
      trend: computeTrend(gananciaNeta, gananciaNetaPrev),
    },
  ];

  return { kpis, profitKpis };
}

function buildSaleRow(order: Order): SaleRow {
  const items = order.items ?? [];
  const pieces = items.reduce((acc, item) => acc + item.quantity, 0);
  const itemsLabel = items
    .map(
      (item) =>
        `${item.nameSnapshot}${item.quantity > 1 ? ` ×${item.quantity}` : ""}`,
    )
    .join(", ");
  const date = `${formatShortDate(order.createdAt)} · ${order.createdAt.toLocaleTimeString(
    "es-MX",
    {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    },
  )}`;

  return {
    id: String(order.id),
    date,
    day: isoDay(order.createdAt),
    pieces,
    items: itemsLabel,
    savings: order.savings,
    couponCode: order.couponCode,
    couponDiscount: order.couponDiscount,
    shipping: order.shipping,
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

  const [ordersHistory, recentOrders, products, expenses] = await Promise.all([
    Order.findAll({
      // `paymentStatus` y NO `status` (arreglo de la Fase N.4): `Order.status` avanza a
      // `shipped`/`delivered` en cuanto la guía reporta actividad (o el dueño lo marca a mano con
      // el `PATCH /status` de la Fase O.1), así que con `status: "paid"` **un pedido salía de los
      // ingresos, de los KPIs y de `recentSales` justo al despacharlo** — el panel iba a
      // subcontar desde el primer envío del lanzamiento. `paymentStatus: "paid"` significa "el
      // dinero entró y no se ha devuelto": sobrevive a `shipped`/`delivered` y solo cambia a
      // `refunded` (reembolso real) o `failed` (pendiente liberado), que es exactamente lo que NO
      // debe contar como venta.
      where: {
        paymentStatus: "paid",
        createdAt: { [Op.gte]: sinceHistory },
      } as WhereOptions<OrderAttributes>,
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "ASC"]],
    }),
    Order.findAll({
      where: { paymentStatus: "paid" },
      include: [{ model: OrderItem, as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: RECENT_SALES_LIMIT,
    }),
    Product.findAll({
      where: { deletedAt: { [Op.is]: null } },
      include: [productSizesInclude],
    }),
    // Gastos con todas sus versiones de monto (Fase N.3). Sin filtro por fecha: son decenas de
    // filas y el cálculo necesita el historial completo de precios para saber cuánto costaba
    // cada cosa en cada momento.
    loadExpenses(),
  ]);

  const dailyAgg = buildDailyAggregates(ordersHistory);
  const monthlyRunRate = totalMonthlyRunRate(expenses, isoDay(now));
  const oneTimeByDay = oneTimeExpensesByDay(expenses);

  const revenueByPeriod: Record<Period, RevenuePoint[]> = {
    "7": buildRevenuePeriod(dailyAgg, 7, todayStart),
    "30": buildRevenuePeriod(dailyAgg, 30, todayStart),
    "90": buildRevenuePeriod(dailyAgg, REVENUE_WINDOW_DAYS, todayStart),
  };

  const kpisByPeriod = {} as Record<Period, KpiData[]>;
  const profitKpisByPeriod = {} as Record<Period, KpiData[]>;
  for (const period of PERIODS) {
    const { kpis, profitKpis } = buildKpisForWindow(
      dailyAgg,
      Number(period),
      todayStart,
      monthlyRunRate,
      oneTimeByDay,
    );
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

  return {
    kpisByPeriod,
    profitKpisByPeriod,
    revenueByPeriod,
    recentSales,
    inventory,
  };
}
