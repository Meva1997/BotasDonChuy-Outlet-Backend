interface PasswordResetCodeInput {
  code: string;
  name?: string;
}

/**
 * Correo de recuperación de contraseña con un código de 5 dígitos numéricos.
 * CSS inline: los clientes de correo no cargan hojas de estilo externas.
 */
export function passwordResetCodeTemplate({
  code,
  name,
}: PasswordResetCodeInput): string {
  const saludo = name ? `Hola ${name},` : "Hola,";

  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background-color:#7c2d12;padding:24px 32px;">
                <h1 style="margin:0;font-size:20px;color:#ffffff;">Botas Don Chuy Outlet</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${saludo}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
                  Recibimos una solicitud para restablecer tu contraseña. Usa el siguiente
                  código de seguridad para continuar:
                </p>
                <div style="margin:0 0 24px;text-align:center;">
                  <span style="display:inline-block;font-size:36px;font-weight:bold;letter-spacing:10px;color:#7c2d12;background-color:#fef3c7;padding:16px 24px;border-radius:10px;">${code}</span>
                </div>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#52525b;">
                  Este código <strong>expira en 15 minutos</strong> y solo puede usarse una vez.
                </p>
                <p style="margin:0;font-size:14px;line-height:1.5;color:#52525b;">
                  Si no solicitaste este cambio, ignora este correo; tu contraseña seguirá igual.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  Este es un correo automático, por favor no respondas a este mensaje.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
