import crypto from "crypto";

/**
 * Idempotencia en memoria compartida (Fase O.2).
 *
 * Dos rutas que escriben de forma no reversible necesitan protegerse de que el mismo
 * envío llegue dos veces (doble clic, reintento del navegador, retry de un proxy):
 *
 *  - `POST /api/admin/products/import` — el restock SUMA stock; aplicar el mismo lote
 *    dos veces duplica las piezas. Ahí un reenvío se **rechaza** con 409.
 *  - `POST /api/orders` — cada request crea una fila `Order`, un PaymentIntent real y
 *    descuenta stock. Ahí un reenvío **devuelve la respuesta del original**: el cliente
 *    está esperando para pagar, y un 409 lo dejaría sin poder completar la compra y con
 *    stock ya apartado a su nombre.
 *
 * Las dos políticas son distintas, pero el mecanismo es el mismo (huella sha256 + mapa
 * con TTL y purga perezosa), así que vive aquí una sola vez en vez de copiado.
 *
 * **Deliberadamente NO se persiste**: se reinicia con el proceso y no cubre varias
 * instancias — misma decisión (y misma limitación asumida) que el contador de fallos
 * consecutivos de `pendingOrderSweeper.ts`. Protege del accidente, no del abuso; contra el
 * abuso están `orderRateLimiter` y el índice único de `products.code`.
 */

/**
 * Huella estable (sha256 en hex) de un payload arbitrario.
 *
 * El llamador es responsable de pasar una estructura **normalizada** (orden de
 * elementos y de claves fijos): `JSON.stringify` conserva el orden de inserción, así
 * que dos payloads equivalentes con las claves en distinto orden darían huellas
 * distintas.
 */
export function fingerprintOf(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Mapa con expiración por entrada. La purga es perezosa (en cada lectura/escritura) en
 * vez de por temporizador: sin un `setInterval` propio no hay handle que limpiar al
 * apagar el proceso, y el costo de recorrer el mapa es trivial porque su tamaño está
 * acotado por las peticiones que caben en la ventana del TTL.
 */
export class IdempotencyStore<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** Valor vigente de la clave, o `undefined` si nunca se guardó o ya expiró. */
  get(key: string): V | undefined {
    const now = Date.now();
    this.prune(now);
    return this.entries.get(key)?.value;
  }

  /**
   * `true` si la clave tiene una entrada vigente. Pregunta por la **entrada**, no por su
   * valor: apoyarse en `get(key) !== undefined` haría indistinguible "nunca se guardó" de
   * "se guardó el valor `undefined`" en un store cuyo tipo lo admita
   * (`IdempotencyStore<string | undefined>`), y una clave reclamada reportaría estar libre.
   */
  has(key: string): boolean {
    const now = Date.now();
    this.prune(now);
    return this.entries.has(key);
  }

  /** Guarda (o renueva) la clave con una vigencia de `ttlMs` a partir de ahora. */
  set(key: string, value: V): void {
    const now = Date.now();
    this.prune(now);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /**
   * Libera la clave antes de que expire. Se usa cuando el intento falló y no dejó
   * efecto persistido: sin esto el usuario tendría que esperar la ventana completa
   * para poder reintentar lo mismo.
   */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Libera la clave **solo si** el valor vigente sigue siendo el que guardó el llamador.
   *
   * El chequeo de identidad importa porque un intento puede tardar más que el TTL (el
   * timeout por defecto del SDK de Stripe son 80 s contra una ventana de 60 s): para
   * cuando ese intento falla, su entrada ya expiró y otra petición reclamó la misma clave.
   * Un `delete` a ciegas borraría **esa** entrada nueva y dejaría pasar el duplicado que
   * todo esto existe para evitar.
   */
  deleteIf(key: string, matches: (value: V) => boolean): void {
    const entry = this.entries.get(key);
    if (entry && matches(entry.value)) this.entries.delete(key);
  }

  /** Vacía el mapa. Pensado para aislar tests entre sí (el estado vive en el módulo). */
  clear(): void {
    this.entries.clear();
  }
}
