// Pronostica la demanda del siguiente mes dado un historial de ventas mensuales.
// El nivel del algoritmo se selecciona automáticamente según cuántos meses haya:
//   1-2 meses → Nivel 1: promedio simple (baja confianza)
//   3 meses   → Nivel 2: promedio ponderado + detector de tendencia (confianza media)
//   4+ meses  → Nivel 3: suavización exponencial de Holt (alta confianza)
//
// En producción, pasar el historial real desde la base de datos.
// La función no sabe si los datos son mock o reales — solo recibe números.

export type ForecastMethod =
  | "promedio-simple"
  | "tendencia"
  | "suavizacion-exponencial";

export type TrendDirection = "creciendo" | "estable" | "bajando";
export type Confidence = "baja" | "media" | "alta";

export interface ForecastResult {
  forecastNextMonth: number;
  method: ForecastMethod;
  methodLabel: string;
  trend: TrendDirection;
  confidence: Confidence;
}

// ─── Nivel 1: promedio simple ─────────────────────────────────────────────────
function simpleAverage(sales: number[]): ForecastResult {
  const avg = sales.reduce((a, b) => a + b, 0) / sales.length;
  return {
    forecastNextMonth: Math.max(0, Math.round(avg)),
    method: "promedio-simple",
    methodLabel: "Promedio simple",
    trend: "estable",
    confidence: "baja",
  };
}

// ─── Nivel 2: promedio ponderado + tendencia ──────────────────────────────────
// Peso creciente: el mes más reciente pesa más.
// Si el último mes creció/bajó >15% respecto al anterior, se aplica un multiplicador.
function weightedTrend(sales: number[]): ForecastResult {
  const n = sales.length;
  const totalWeight = (n * (n + 1)) / 2; // 1+2+...+n
  const weightedAvg =
    sales.reduce((sum, s, i) => sum + s * (i + 1), 0) / totalWeight;

  const latest = sales[n - 1];
  const prev = sales[n - 2];
  const ratio = prev > 0 ? latest / prev : 1;

  let forecast = weightedAvg;
  let trend: TrendDirection = "estable";

  if (ratio > 1.15) {
    forecast = weightedAvg * Math.min(ratio, 1.6); // cap para no dispararse
    trend = "creciendo";
  } else if (ratio < 0.85) {
    forecast = weightedAvg * Math.max(ratio, 0.5); // floor para no colapsar
    trend = "bajando";
  }

  return {
    forecastNextMonth: Math.max(0, Math.round(forecast)),
    method: "tendencia",
    methodLabel: "Prom. ponderado + tendencia",
    trend,
    confidence: "media",
  };
}

// ─── Nivel 3: suavización exponencial de Holt (doble) ────────────────────────
// Modela tanto el nivel actual de demanda como la tendencia en curso.
// α controla qué tan rápido reacciona al nivel; β controla la sensibilidad a la tendencia.
// Estándar en sistemas ERP, SAP, Excel Pronóstico.
function exponentialSmoothing(sales: number[]): ForecastResult {
  const α = 0.4; // suavizado de nivel (más alto = más reactivo)
  const β = 0.3; // suavizado de tendencia

  let level = sales[0];
  let trend = sales[1] - sales[0];

  for (let i = 1; i < sales.length; i++) {
    const prevLevel = level;
    level = α * sales[i] + (1 - α) * (level + trend);
    trend = β * (level - prevLevel) + (1 - β) * trend;
  }

  const forecast = Math.max(0, Math.round(level + trend));
  const trendPct = level > 0 ? trend / level : 0;
  const trendDir: TrendDirection =
    trendPct > 0.05 ? "creciendo" : trendPct < -0.05 ? "bajando" : "estable";

  return {
    forecastNextMonth: forecast,
    method: "suavizacion-exponencial",
    methodLabel: "Suavización exponencial",
    trend: trendDir,
    confidence: "alta",
  };
}

// ─── Selector automático de nivel ────────────────────────────────────────────
export function computeForecast(monthlySales: number[]): ForecastResult {
  const n = monthlySales.length;

  if (n === 0) {
    return {
      forecastNextMonth: 0,
      method: "promedio-simple",
      methodLabel: "Sin datos",
      trend: "estable",
      confidence: "baja",
    };
  }

  if (n <= 2) return simpleAverage(monthlySales);
  if (n === 3) return weightedTrend(monthlySales);
  return exponentialSmoothing(monthlySales);
}
