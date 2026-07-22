import { sendEmail } from "./email.service";
import { logger } from "../config/logger";

interface SendAlertEmailInput {
  subject: string;
  context: Record<string, unknown>;
}

/**
 * Alerta operativa por correo (Fase H.4) para fallos que necesitan atención humana:
 * guías Skydropx que cobraron pero no se persistieron, o una orden que el sweeper de
 * pendientes no logra reconciliar tras varios intentos. Reusa `sendEmail`, que nunca
 * lanza — así que esta función tampoco lanza.
 *
 * Invariante: email.service.ts NUNCA debe llamar a `sendAlertEmail` desde sus propios
 * catches — eso crearía un bucle (una falla de Resend intentando avisar vía Resend).
 */
export async function sendAlertEmail({ subject, context }: SendAlertEmailInput): Promise<void> {
  const to = process.env.ALERT_EMAIL_TO;
  if (!to) {
    logger.warn({ subject }, "ALERT_EMAIL_TO no configurado; alerta omitida");
    return;
  }

  const html = `<p>${subject}</p><pre>${JSON.stringify(context, null, 2)}</pre>`;
  await sendEmail({ to, subject: `[ALERTA] ${subject}`, html });
}
