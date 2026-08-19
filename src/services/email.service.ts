import { resend, EMAIL_FROM } from "../config/resend";
import { logger } from "../config/logger";

interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  /**
   * Clave de idempotencia de Resend (expira a las 24h). Evita reenvíos cuando el
   * mismo evento se procesa dos veces. Patrón recomendado: `<evento>/<id>`.
   */
  idempotencyKey?: string;
}

/**
 * Envoltura base sobre resend.emails.send. **Loguea pero NUNCA lanza**: un correo
 * fallido (Resend caído, 403 por dominio no verificado, red, etc.) jamás debe
 * tumbar el request que lo dispara (forgot-password, checkout, webhook de Stripe).
 * Ver §6 del ROADMAP.
 *
 * La SDK de Resend no lanza en error de API: devuelve `{ data, error }`. Cubrimos
 * ambos caminos — el `error` de la respuesta y una excepción de red del try/catch.
 *
 * Devuelve `true`/`false` (nunca lanza) en vez de `void` porque el `error` de la SDK
 * es invisible para un `try/catch` de un llamador — sin este booleano no había forma
 * de distinguir "se mandó" de "se tragó un 403" desde afuera, así que un fallo por
 * ejemplo de dominio no verificado pasaba inadvertido incluso para el propio pedido
 * (ver `sendOrderEmail` en `payment.service.ts`, que es quien lo usa para alertar).
 */
export async function sendEmail({
  to,
  subject,
  html,
  idempotencyKey,
}: SendEmailInput): Promise<boolean> {
  try {
    const { data, error } = await resend.emails.send(
      { from: EMAIL_FROM, to, subject, html },
      idempotencyKey ? { idempotencyKey } : undefined,
    );

    if (error) {
      // Solo log, nunca Sentry.captureException ni sendAlertEmail: esta es la propia
      // ruta de correo — alertar por email aquí crearía un bucle si Resend está caído.
      logger.error({ err: error }, "[email] Resend devolvió un error");
      return false;
    }

    logger.info({ subject, to, resendId: data?.id }, "[email] Enviado");
    return true;
  } catch (err) {
    logger.error({ err }, "[email] Falló el envío (excepción)");
    return false;
  }
}
