// Helpers de fecha fijados a UTC, compartidos por los reportes en memoria
// (dashboard.service.ts, reports.service.ts). Todo agrupamiento por día/mes usa UTC
// para que el resultado no dependa de la zona horaria del host: omitir
// `timeZone: "UTC"` en toLocaleDateString/toLocaleTimeString rueda la etiqueta un día
// hacia atrás en hosts al oeste de UTC (bug real, visto en un dev machine
// America/Mexico_City — ver CLAUDE.md).

export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Clave de día en UTC, p. ej. "2026-07-03".
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatShortDate(date: Date): string {
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "UTC" });
}

// Primer día (UTC) del mes al que pertenece `date`.
export function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

// Clave de mes en UTC, p. ej. "2026-01".
export function isoMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

// Etiqueta de mes es-MX fijada a UTC ("Enero 2026"). toLocaleDateString devuelve
// "enero de 2026"; se capitaliza y se quita " de " para coincidir con el label del
// front (frontend/db/mockData.ts).
export function formatMonthLabel(date: Date): string {
  const raw = date.toLocaleDateString("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const cleaned = raw.replace(" de ", " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
