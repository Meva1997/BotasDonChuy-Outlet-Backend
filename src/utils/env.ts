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

/**
 * Valor de `app.set("trust proxy", ...)` leído de `TRUST_PROXY`.
 *
 * Sin esto, `req.ip` detrás de un proxy (Render/Railway/Fly/nginx/Cloudflare — la forma
 * normal de desplegar esta API) es la IP del proxy, no la del cliente: **todos** los
 * `express-rate-limit` de `middlewares/rateLimit.ts` colapsan en un solo cubo compartido
 * por la tienda entera. El caso que más duele es `orderLookupRateLimiter` (Fase O.4): 31
 * compradores abriendo su link de seguimiento en el mismo minuto y del 30 en adelante
 * reciben 429 en su propio pedido.
 *
 * **No** se activa por defecto a propósito. `trust proxy` en `true` hace que Express crea
 * el `X-Forwarded-For` que venga en la request, así que en un servidor expuesto
 * directamente (o detrás de un proxy que no reescribe ese header) cualquiera se salta los
 * límites rotando IPs inventadas — cambiaríamos un cubo compartido por ningún límite. El
 * valor correcto depende del despliegue y solo lo sabe quien lo despliega:
 *   - sin definir → se conserva el default de Express (`false`, no confía en nadie);
 *   - `TRUST_PROXY=1` → confía en 1 salto de proxy (lo típico en un PaaS: **empieza aquí**);
 *   - `TRUST_PROXY=loopback` / `10.0.0.0/8` / lista separada por comas → direcciones de
 *     confianza, la opción más estricta;
 *   - `TRUST_PROXY=true` → confía en toda la cadena; `express-rate-limit` lo marca como
 *     permisivo con razón, úsalo solo si el proxy garantiza reescribir `X-Forwarded-For`.
 *
 * Devuelve `undefined` cuando no hay nada que configurar, para que el llamador ni siquiera
 * llame a `app.set` y el comportamiento quede idéntico al de antes de esta variable.
 */
export function trustProxyEnv(): number | string | boolean | undefined {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === "") return undefined;

  if (raw === "true") return true;
  if (raw === "false") return false;

  // Solo un entero no negativo cuenta como "número de saltos": `Number("1.5")`/`Number("-1")`
  // pasarían el `isFinite` y Express los usaría como conteo de saltos sin sentido.
  if (/^\d+$/.test(raw)) return Number(raw);

  // Cualquier otra cosa es una lista de direcciones/subredes o un preset ("loopback",
  // "linklocal", "uniquelocal"). No se valida aquí: Express lanza al arrancar si no la
  // entiende, que es justo el fail-fast que queremos para un valor mal escrito.
  return raw;
}
