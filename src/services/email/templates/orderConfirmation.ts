import { formatMoney } from "../../../utils/formatMoney";
import { escapeHtml } from "./escapeHtml";

interface OrderConfirmationItem {
  nameSnapshot: string;
  size: number;
  quantity: number;
  unitSalePrice: number;
  unitOriginalPrice: number;
}

interface OrderConfirmationAddress {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  references?: string | null;
}

interface OrderConfirmationInput {
  createdAt: Date;
  customerName: string;
  items: OrderConfirmationItem[];
  subtotal: number;
  savings: number;
  shipping: number;
  /**
   * Cupón canjeado (Fase N.2), congelado en el pedido. Van juntos y solo se renderizan cuando el
   * descuento es mayor a 0 — igual que "Ahorraste". Sin esta fila, el correo mostraría un total
   * que no cuadra con `subtotal − savings + envío` y el comprador no sabría de dónde salió.
   */
  couponCode?: string | null;
  couponDiscount?: number;
  total: number;
  shippingAddress: OrderConfirmationAddress;
  shippingCarrier?: string | null;
  /**
   * Datos de rastreo. Hoy siempre `undefined` (Skydropx diferido, Fase 8); cuando
   * llegue, el mismo template renderiza el bloque de rastreo sin rediseñarse.
   */
  tracking?: { number: string; url?: string; carrier?: string };
  /**
   * Correo de rotación de código (Fase O.6): el dueño invalidó el link/código expuesto de este
   * pedido. Cambia únicamente el intro (`introHeading`/`introBody`) — el resto del correo
   * (items, totales, dirección, bloque de rastreo) se reutiliza tal cual.
   */
  codeRotated?: boolean;
  /**
   * Link a la página pública de seguimiento (Fase O.4), con el token opaco del pedido. Es la
   * razón de ser de esa fase: sin él, el cliente que borra este correo no tiene forma de
   * consultar su pedido y cada "¿ya salió?" acaba siendo trabajo manual del dueño por WhatsApp.
   */
  trackingPageUrl?: string;
  /**
   * El `publicToken` del pedido tal cual, para pintarlo A LA VISTA junto al botón. El link solo
   * existía dentro del `href`, así que quien quisiera usar la página de consulta —que pide el
   * código, no el correo— tenía que saber hacer "copiar dirección del enlace". Es exactamente lo
   * único que `GET /api/orders/lookup/:token` recibe, así que es lo que el comprador debe copiar.
   */
  trackingCode?: string | null;
  /** La página de consulta sin token (`<front>/pedido`), para decir dónde se pega el código. */
  trackingLookupUrl?: string;
}

/**
 * Fecha legible del pedido, p. ej. "14 de julio de 2026". Se fija a
 * `America/Mexico_City` (no UTC): a diferencia de `src/utils/date.ts` —que usa UTC para
 * estabilidad de agregación— este es un recibo al cliente de una tienda en Celaya, GTO,
 * así que la hora local es la correcta.
 */
function formatOrderDate(date: Date): string {
  return date.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Mexico_City",
  });
}

function itemRow(item: OrderConfirmationItem): string {
  const lineTotal = item.unitSalePrice * item.quantity;
  const hasDiscount = item.unitOriginalPrice > item.unitSalePrice;
  const priceCell = hasDiscount
    ? `<span style="color:#a1a1aa;text-decoration:line-through;font-size:12px;">${formatMoney(
        item.unitOriginalPrice,
      )}</span><br /><span style="color:#18181b;">${formatMoney(item.unitSalePrice)}</span>`
    : `${formatMoney(item.unitSalePrice)}`;

  return `<tr>
              <td style="padding:12px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;">
                ${escapeHtml(item.nameSnapshot)}<br />
                <span style="font-size:12px;color:#52525b;">Talla ${item.size} · Cantidad ${item.quantity}</span>
              </td>
              <td align="right" style="padding:12px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;white-space:nowrap;">
                ${priceCell}
              </td>
              <td align="right" style="padding:12px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;white-space:nowrap;color:#18181b;">
                ${formatMoney(lineTotal)}
              </td>
            </tr>`;
}

function totalsRow(label: string, value: string, opts?: { strong?: boolean; accent?: boolean }): string {
  const weight = opts?.strong ? "bold" : "normal";
  const color = opts?.accent ? "#7c2d12" : "#18181b";
  const size = opts?.strong ? "16px" : "14px";
  return `<tr>
              <td style="padding:4px 8px;font-size:${size};color:#52525b;">${label}</td>
              <td align="right" style="padding:4px 8px;font-size:${size};font-weight:${weight};color:${color};white-space:nowrap;">${value}</td>
            </tr>`;
}

function shippingSection(input: OrderConfirmationInput): string {
  if (input.tracking) {
    const carrier = input.tracking.carrier ?? input.shippingCarrier ?? "la paquetería";
    const trackButton = input.tracking.url
      ? `<div style="margin:12px 0 0;">
                  <a href="${escapeHtml(input.tracking.url)}" style="display:inline-block;background-color:#7c2d12;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:8px;">Rastrear mi pedido</a>
                </div>`
      : "";
    return `<div style="margin:24px 0 0;padding:16px;background-color:#fef3c7;border-radius:10px;">
                <p style="margin:0;font-size:14px;font-weight:bold;color:#7c2d12;">Tu pedido va en camino</p>
                <p style="margin:8px 0 0;font-size:14px;color:#52525b;">
                  Enviado con ${escapeHtml(carrier)}. Número de guía: <strong>${escapeHtml(input.tracking.number)}</strong>
                </p>
                ${trackButton}
              </div>`;
  }
  return `<div style="margin:24px 0 0;padding:16px;background-color:#fef3c7;border-radius:10px;">
                <p style="margin:0;font-size:14px;font-weight:bold;color:#7c2d12;">Estamos preparando tu envío</p>
                <p style="margin:8px 0 0;font-size:14px;color:#52525b;">
                  Te avisaremos con los datos de rastreo en cuanto tu pedido salga de nuestra bodega.
                </p>
              </div>`;
}

/**
 * Bloque con las dos formas de llegar a la página pública de seguimiento (Fase O.4): el botón de un
 * clic y el código copiable. Va en los dos correos (confirmación y "va en camino") a propósito: el
 * de confirmación es el que el cliente conserva, y es justo el que puede borrar o perder en spam —
 * cuantas más veces le llegue, menos probable es que la consulta acabe siendo un WhatsApp al dueño.
 *
 * El código se pinta a la vista porque el botón por sí solo no resuelve el caso de quien entra por
 * la página de consulta: ahí se pega el token, y dentro de un `href` no hay forma de copiarlo sin
 * saber usar el menú contextual del cliente de correo.
 */
function trackingPageSection(input: OrderConfirmationInput): string {
  const { trackingPageUrl: url, trackingCode: code, trackingLookupUrl: lookupUrl } = input;
  // Sin URL ni código (filas anteriores a la columna `publicToken`) no se renderiza nada, en vez de
  // un link roto o una caja vacía. En la práctica los dos salen del mismo token, así que van juntos.
  if (!url && !code) return "";

  const button = url
    ? `<a href="${escapeHtml(url)}" style="display:inline-block;border:1px solid #7c2d12;color:#7c2d12;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:8px;">Ver el estado de mi pedido</a>`
    : "";
  // El destino se nombra con un link si lo tenemos y como texto si no, para que la frase nunca
  // quede coja ("...cuando quieras en ." si faltara la URL).
  const where = lookupUrl
    ? `<a href="${escapeHtml(lookupUrl)}" style="color:#7c2d12;">${escapeHtml(lookupUrl)}</a>`
    : "nuestra página de seguimiento";
  // La caja NO es un `<a>`: si lo fuera, tocarla en el móvil navegaría en vez de dejar seleccionar
  // el texto, que es justo lo que esta caja existe para permitir. `word-break` porque el UUID mide
  // 36 caracteres y desbordaría el ancho de un correo en pantalla chica.
  const codeBox = code
    ? `<p style="margin:20px 0 8px;font-size:13px;color:#52525b;">
                  ¿Prefieres buscarlo tú? Copia este código de seguimiento:
                </p>
                <p style="margin:0;padding:12px;background-color:#fafafa;border:1px solid #e4e4e7;border-radius:8px;font-family:'Courier New',Courier,monospace;font-size:15px;letter-spacing:0.5px;color:#18181b;word-break:break-all;-webkit-user-select:all;user-select:all;">${escapeHtml(
        code,
      )}</p>
                <p style="margin:8px 0 0;font-size:12px;color:#a1a1aa;">
                  Guárdalo: con él puedes consultar tu pedido cuando quieras en ${where}
                </p>`
    : `<p style="margin:8px 0 0;font-size:12px;color:#a1a1aa;">
                  Guarda este enlace: con él puedes consultar tu pedido cuando quieras.
                </p>`;

  return `<div style="margin:24px 0 0;text-align:center;">
                ${button}
                ${codeBox}
              </div>`;
}

/**
 * Correo de confirmación de pedido: resumen de artículos (con precios congelados del
 * `OrderItem`, nunca del `Product` actual), totales y dirección de envío. Nunca incluye
 * `unitCost`. CSS inline: los clientes de correo no cargan hojas de estilo externas.
 */
export function orderConfirmationTemplate(input: OrderConfirmationInput): string {
  const {
    createdAt,
    customerName,
    items,
    subtotal,
    savings,
    shipping,
    total,
    shippingAddress,
    shippingCarrier,
  } = input;

  const addr = shippingAddress;
  const carrierLine = shippingCarrier
    ? `<p style="margin:8px 0 0;font-size:14px;color:#52525b;">Paquetería: ${escapeHtml(shippingCarrier)}</p>`
    : "";
  // La intro cambia según el disparo: `codeRotated` es el correo de rotación de código (Fase
  // O.6, revisa primero — es el único que no habla de pago ni de envío), luego `tracking` es el
  // correo "pedido enviado" (Fase 8.6), y sin ninguno de los dos es la confirmación de pago
  // (Fase 9.3). Sin esto, el correo de envío abriría con "Tu pago fue confirmado", copy de
  // confirmación que no corresponde a un aviso de que el pedido ya salió.
  const introHeading = input.codeRotated
    ? `Actualizamos tu código de rastreo, ${escapeHtml(customerName)}`
    : input.tracking
      ? `¡Tu pedido va en camino, ${escapeHtml(customerName)}!`
      : `¡Gracias por tu compra, ${escapeHtml(customerName)}!`;
  // Sin número de pedido a propósito: `Order.id` es un consecutivo global de la tienda, no del
  // comprador, así que "tu pedido #20" le sugiere veinte compras que no hizo. Tampoco le sirve de
  // referencia — la credencial de su pedido es el código de seguimiento de más abajo, y la consulta
  // pública es por token justamente porque un id secuencial sería enumerable. La fecha sí se queda:
  // es lo que le permite distinguir dos compras en su bandeja.
  const introBody = input.codeRotated
    ? `Por seguridad generamos un nuevo código de seguimiento para tu pedido del ${formatOrderDate(createdAt)}. El código anterior ya no funciona — usa el que aparece abajo para consultar tu pedido.`
    : input.tracking
      ? `Tu pedido del ${formatOrderDate(createdAt)} ya salió de nuestra bodega. Abajo están los datos de rastreo y el resumen de tu compra.`
      : `Tu pago fue confirmado. Aquí está el resumen de tu pedido del ${formatOrderDate(createdAt)}.`;
  const savingsRow =
    savings > 0 ? totalsRow("Ahorraste", `− ${formatMoney(savings)}`, { accent: true }) : "";
  // El código pasa por `escapeHtml` aunque su charset ya prohíba `<` y `&`: la regla del repo es
  // que toda cadena no numérica interpolada pase por aquí, y así una relajación futura de ese
  // charset no reabre el hueco.
  const couponRow =
    input.couponDiscount && input.couponDiscount > 0
      ? totalsRow(
          input.couponCode ? `Cupón ${escapeHtml(input.couponCode)}` : "Cupón",
          `− ${formatMoney(input.couponDiscount)}`,
          { accent: true },
        )
      : "";

  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background-color:#7c2d12;padding:24px 32px;">
                <h1 style="margin:0;font-size:20px;color:#ffffff;">Botas Don Chuy Outlet</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;font-size:18px;font-weight:bold;line-height:1.4;">${introHeading}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#52525b;">
                  ${introBody}
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #e4e4e7;">
                  <tr>
                    <td style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Artículo</td>
                    <td align="right" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Precio</td>
                    <td align="right" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Total</td>
                  </tr>
                  ${items.map(itemRow).join("\n                  ")}
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  ${totalsRow("Subtotal", formatMoney(subtotal))}
                  ${savingsRow}
                  <!-- El cupón va ANTES del envío a propósito: es la prueba visual de que el
                       descuento se aplicó a la mercancía y no a la paquetería. -->
                  ${couponRow}
                  ${totalsRow("Envío", formatMoney(shipping))}
                  ${totalsRow("Total", formatMoney(total), { strong: true, accent: true })}
                </table>

                <div style="margin:0 0 8px;padding:16px;background-color:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
                  <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#18181b;">Dirección de envío</p>
                  <p style="margin:0;font-size:14px;line-height:1.5;color:#52525b;">
                    ${escapeHtml(addr.street)}<br />
                    ${escapeHtml(addr.neighborhood)}<br />
                    ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)}, C.P. ${escapeHtml(addr.postalCode)}${
    addr.references ? `<br />Referencias: ${escapeHtml(addr.references)}` : ""
  }
                  </p>
                  ${carrierLine}
                </div>

                ${shippingSection(input)}
                ${trackingPageSection(input)}
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
