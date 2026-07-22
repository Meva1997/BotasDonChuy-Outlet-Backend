import crypto from "crypto";

/**
 * Compara dos cadenas en tiempo constante para no filtrar información por el tiempo de respuesta.
 * `timingSafeEqual` exige buffers del mismo tamaño (lanza si difieren), así que se compara la
 * longitud primero y se devuelve `false` sin fugar cuál byte difirió. Pensada para hashes/firmas ya
 * calculados (hex), donde una longitud distinta ya implica desigualdad.
 *
 * Helper compartido por `verifyResetCode` (código de recuperación) y `verifySkydropxWebhookSignature`
 * (firma HMAC del webhook), que antes duplicaban este mismo patrón.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
