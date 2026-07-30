/**
 * Días de calendario en la zona horaria de la tienda (Celaya, GTO).
 *
 * Deliberadamente SEPARADO de `src/utils/date.ts`, cuyo encabezado garantiza que **todo** lo que
 * vive ahí está fijado a UTC para que las agregaciones no dependan de la zona del host. Este
 * archivo es lo contrario a propósito: cuando la pregunta es "¿cuánto vendí *ayer*?", el día que
 * importa es el del dueño, no el de Greenwich. Un "ayer" calculado en UTC cubriría de las 18:00 de
 * antier a las 18:00 de ayer y se comería la tarde-noche, que es horario pico de compra.
 *
 * Mismo criterio (y misma justificación) que la fecha del correo de confirmación y que la ventana
 * de vigencia de los cupones.
 */

/**
 * Zona horaria de la tienda. Offset FIJO a propósito: México abolió el horario de verano en 2022,
 * así que el centro del país está en UTC−6 todo el año y no hace falta una librería de zonas. Si
 * algún día se vende desde la franja fronteriza (que sí conserva DST), esto hay que revisarlo.
 *
 * Compartido con `src/schemas/coupon.ts`, que antes lo declaraba por su cuenta: son la misma
 * decisión y separarlos solo permitía que se contradijeran.
 */
export const MEXICO_CITY_OFFSET = "-06:00";

/** Nombre IANA de la zona, para los formateadores que lo aceptan. */
export const STORE_TIME_ZONE = "America/Mexico_City";

/** Una fecha sin hora, `YYYY-MM-DD`. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Día de calendario de la tienda al que pertenece un instante, como `"2026-07-29"`.
 *
 * Se usa el locale `en-CA` y no `es-MX` porque `en-CA` formatea en ISO (`2026-07-29`) mientras que
 * `es-MX` da `29/7/2026`: aquí el string es una **clave** (se compara, se ordena y se usa como
 * `idempotencyKey` del correo), no texto para un humano.
 */
export function storeDay(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: STORE_TIME_ZONE });
}

/**
 * Hora local de la tienda (0–23) de un instante.
 *
 * `hourCycle: "h23"` y no `hour12: false`: con este último, la medianoche se formatea como `"24"`
 * en varias versiones de ICU (ciclo h24), y un `24 >= DAILY_DIGEST_HOUR` haría que el resumen se
 * mandara a medianoche en vez de a las 8.
 */
export function storeHour(date: Date = new Date()): number {
  return Number(
    date.toLocaleString("en-US", {
      timeZone: STORE_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }),
  );
}

/**
 * Los dos instantes UTC que delimitan un día de la tienda, para usarlos en un `WHERE createdAt
 * BETWEEN`. `to` es **inclusivo** (`23:59:59.999`) y no el inicio del día siguiente: la precisión
 * de un `TIMESTAMP` de Postgres son microsegundos, así que un pedido creado en los últimos
 * microsegundos del día podría escaparse — el riesgo es despreciable frente a que un rango
 * `[inicio, inicioSiguiente)` mal escrito duplique el pedido de medianoche en dos resúmenes.
 */
export function storeDayRange(day: string): { from: Date; to: Date } {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`storeDayRange espera un día "YYYY-MM-DD", recibió "${day}"`);
  }
  return {
    from: new Date(`${day}T00:00:00.000${MEXICO_CITY_OFFSET}`),
    to: new Date(`${day}T23:59:59.999${MEXICO_CITY_OFFSET}`),
  };
}

/**
 * Día anterior al dado, en el calendario de la tienda. Se opera sobre el mediodía UTC del día para
 * que sumar/restar 24h no pueda cruzar de mes por un error de horas: el resultado se vuelve a
 * formatear con `storeDay`, así que el intermedio solo necesita caer dentro del día correcto.
 */
export function previousStoreDay(day: string): string {
  const { from } = storeDayRange(day);
  return storeDay(new Date(from.getTime() - 12 * 3_600_000));
}

/** Etiqueta legible del día para el asunto/encabezado de un correo: "miércoles 29 de julio". */
export function formatStoreDayLabel(day: string): string {
  const { from } = storeDayRange(day);
  return from.toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: STORE_TIME_ZONE,
  });
}

/** Hora local legible de un instante: "14:35". */
export function formatStoreTime(date: Date): string {
  return date.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: STORE_TIME_ZONE,
  });
}
