/**
 * Lectura defensiva de variables de entorno numéricas.
 *
 * `Number(process.env.X ?? 15)` **no** basta: `??` solo cae al valor por defecto cuando la
 * variable es `undefined`/`null`, así que una línea vacía en el `.env` (`SHIPMENT_RETRY_DELAY_MINUTES=`)
 * da `Number("") === 0` y un valor mal tecleado da `NaN`. Los dos se cuelan en silencio y se
 * usan como si fueran configuración válida: un `0` en el margen del centinela de guías haría que
 * una creación reclamada hace milisegundos cuente como huérfana (y un reintento concurrente
 * pagaría una segunda guía), y un `NaN` en un intervalo convierte el `setInterval` en un bucle
 * de ~1 ms contra la BD y contra Skydropx.
 */
export function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // No se lanza: una variable operativa mal escrita no debe impedir que el server arranque
    // (a diferencia de las credenciales, que sí son hard-require). Se avisa y se usa el default.
    // `console.warn` y no el logger de pino a propósito: este módulo lo importan los `config/*`,
    // que se evalúan antes que cualquier otra cosa.
    console.warn(
      `[config] ${name}="${raw}" no es un número positivo válido; se usará ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}
