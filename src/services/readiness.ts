import { sequelize } from "../config/database";
import { logger } from "../config/logger";
import { positiveNumberEnv } from "../utils/env";

/**
 * Readiness del servicio (Fase O.5).
 *
 * `GET /health` responde sin tocar la BD a propósito: es el **liveness** ("el proceso vive").
 * Este módulo respalda el **readiness** ("puede atender"), que sí consulta Postgres. Separarlos
 * importa: si el liveness dependiera de la BD, una caída momentánea haría que el orquestador
 * **reinicie** la app en vez de solo sacarla de rotación, que es exactamente lo contrario de lo
 * que conviene.
 */

/** Margen del chequeo de BD. Ver `runCheck` para por qué el timeout no es opcional. */
const READY_TIMEOUT_MS = positiveNumberEnv("HEALTH_READY_TIMEOUT_MS", 3_000);

/** Ventana de caché del resultado. Ver `checkReadiness`. */
const READY_CACHE_MS = 1_000;

export type ReadinessResult = {
  ready: boolean;
  /** Por qué no está listo. Ausente cuando `ready` es `true`. */
  reason?: "database" | "draining";
};

let draining = false;
let cached: ReadinessResult | null = null;
let cacheExpiresAt = 0;
let inFlight: Promise<ReadinessResult> | null = null;
let lastReported: boolean | null = null;

/**
 * Marca el proceso como "drenando". Lo llama `gracefulShutdown` (`app.ts`) al recibir
 * `SIGTERM`/`SIGINT`, antes de cualquier otra cosa.
 *
 * A partir de ahí el readiness responde `false` **sin consultar la BD**, para que el balanceador
 * saque la instancia de rotación mientras `server.close()` termina las requests en vuelo. Sin
 * esto, el orquestador le seguiría mandando tráfico nuevo durante esos segundos justo a la
 * instancia que está cerrando. Es irreversible a propósito: de un apagado no se vuelve.
 */
export function markDraining(): void {
  draining = true;
}

/**
 * ¿Puede este proceso atender tráfico?
 *
 * **Nunca lanza:** un fallo de BD es una respuesta válida (`{ ready: false }`), no un error del
 * request. Así el handler no pasa por `errorHandler`, que reportaría un 500 a Sentry en cada
 * sondeo y devolvería copia de UI en español para algo que lee una máquina.
 *
 * **Caché de 1 s + single-flight.** `/health/ready` es público y sin auth, y el pool de Sequelize
 * es de 5 conexiones (`config/database.ts`): una query por request deja que un script sature el
 * pool y haga esperar a los checkouts hasta `pool.acquire` (30 s). Compartiendo la promesa en
 * vuelo y cacheando el resultado, un atacante a 1000 req/s produce 1 query/s, y un orquestador
 * que sondea cada 5–10 s nunca lee un dato viejo. Mismo patrón que `loadReportData` en
 * `reports.service.ts`. Se descartó un rate limiter propio: el sondeo sale de una sola IP interna,
 * así que un límite mal calibrado le devolvería `429` **al probe** → falso "no listo" → la
 * instancia se reinicia sola.
 *
 * @param timeoutMs override del margen; solo lo usan los tests, en producción va el del env.
 */
export function checkReadiness(timeoutMs: number = READY_TIMEOUT_MS): Promise<ReadinessResult> {
  if (draining) return Promise.resolve({ ready: false, reason: "draining" });

  if (cached && cacheExpiresAt > Date.now()) return Promise.resolve(cached);

  // La ventana se cuenta desde que el chequeo **termina**, no desde que arranca: con la BD caída
  // el chequeo tarda lo que dure el timeout, y midiendo desde el arranque la entrada nacería
  // vencida y cada request lanzaría su propia consulta — justo el caso en que la caché importa.
  // Mientras tanto, `inFlight` es lo que serializa a los que llegan durante el chequeo.
  if (inFlight) return inFlight;

  inFlight = runCheck(timeoutMs).then((result) => {
    cached = result;
    cacheExpiresAt = Date.now() + READY_CACHE_MS;
    inFlight = null;
    return result;
  });

  return inFlight;
}

async function runCheck(timeoutMs: number): Promise<ReadinessResult> {
  let timer: NodeJS.Timeout | undefined;

  try {
    // El timeout es obligatorio, no cosmético: `config/database.ts` no fija
    // `dialectOptions.connectTimeout` ni `statement_timeout`, y `pool.acquire` son 30 s, así que
    // con Postgres caído este `authenticate()` puede colgarse mucho más de lo que el orquestador
    // espera por su sondeo.
    const probe = sequelize.authenticate();
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`El chequeo de la base de datos excedió ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref();
    });

    await Promise.race([probe, expiry]);
    reportTransition(true);
    return { ready: true };
  } catch (err) {
    reportTransition(false, err);
    return { ready: false, reason: "database" };
  } finally {
    // Imprescindible en el camino feliz: sin esto la promesa `expiry` se rechaza más tarde ya sin
    // nadie escuchando (el `race` ya se resolvió) y sale como unhandled rejection.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Loguea solo el **cambio** de estado, no cada sondeo.
 *
 * Un probe corre para siempre cada pocos segundos: con la BD caída, una línea por intento llena
 * (y cobra) el proveedor de logs. Por la misma razón aquí no hay `Sentry.captureException` — un
 * evento cada 5 s se come la cuota; quien reporta el fallo al final es el orquestador.
 */
function reportTransition(ready: boolean, err?: unknown): void {
  if (lastReported === ready) return;
  lastReported = ready;

  if (ready) {
    logger.info("Readiness: la base de datos volvió a responder; la instancia acepta tráfico");
  } else {
    logger.warn({ err }, "Readiness: la base de datos no responde; la instancia no acepta tráfico");
  }
}

/**
 * Limpia el estado del módulo. **Solo para tests**: la caché, el flag de drenado y el último
 * estado logueado viven en el módulo y sobreviven al `truncateAll` entre casos (misma razón por
 * la que existen `resetCheckoutIdempotency()` y `resetShipmentRetryAttempts()`).
 */
export function resetReadinessCache(): void {
  draining = false;
  cached = null;
  cacheExpiresAt = 0;
  inFlight = null;
  lastReported = null;
}
