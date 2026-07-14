import { resend, EMAIL_FROM } from "../config/resend";

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
 */
export async function sendEmail({
  to,
  subject,
  html,
  idempotencyKey,
}: SendEmailInput): Promise<void> {
  try {
    const { data, error } = await resend.emails.send(
      { from: EMAIL_FROM, to, subject, html },
      idempotencyKey ? { idempotencyKey } : undefined,
    );

    if (error) {
      console.error("[email] Resend devolvió un error:", error);
      return;
    }

    console.log(`[email] Enviado "${subject}" a ${to} (id: ${data?.id})`);
  } catch (err) {
    console.error("[email] Falló el envío (excepción):", err);
  }
}
