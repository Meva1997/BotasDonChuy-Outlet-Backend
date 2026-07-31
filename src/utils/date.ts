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

// Lista de primeros-de-mes (UTC) desde `from` hasta `to` inclusive, sin huecos.
// Si `from` queda después de `to` (drift de reloj entre DB/app, o un `createdAt`
// corrupto/futuro), se recorta a `to` en vez de devolver un rango vacío: preferimos
// mostrar solo el mes en curso a devolver `[]` en silencio, que en getMonthlyReport/
// getReplenishmentReport se ve como "sin datos" aunque sí haya órdenes pagadas.
// Compartida por reports.service.ts (reporte mensual) y expenses.service.ts (historial
// de gastos): los dos necesitan exactamente el mismo rango sin huecos y el mismo clamp.
export function monthRange(from: Date, to: Date): Date[] {
  const months: Date[] = [];
  const cursor = utcMonthStart(from > to ? to : from);
  const end = utcMonthStart(to);
  while (cursor <= end) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

// "2026-07-15" (lo que Sequelize devuelve de una columna DATEONLY) → medianoche UTC de ese
// día. `new Date(iso)` ya interpreta una fecha SIN hora como UTC, pero se hace explícito:
// agregarle una hora al string cambiaría esa regla a hora local y correría el día en hosts
// al oeste de UTC, que es el mismo bug que motivó el pin de este archivo.
export function utcDayFromIso(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
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
