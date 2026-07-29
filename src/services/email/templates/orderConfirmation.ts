import { formatMoney } from "../../../utils/formatMoney";

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
  orderId: number;
  createdAt: Date;
  customerName: string;
  items: OrderConfirmationItem[];
  subtotal: number;
  savings: number;
  shipping: number;
  total: number;
  shippingAddress: OrderConfirmationAddress;
  shippingCarrier?: string | null;
  /**
   * Datos de rastreo. Hoy siempre `undefined` (Skydropx diferido, Fase 8); cuando
   * llegue, el mismo template renderiza el bloque de rastreo sin rediseñarse.
   */
  tracking?: { number: string; url?: string; carrier?: string };
  /**
   * Link a la página pública de seguimiento (Fase O.4), con el token opaco del pedido. Es la
   * razón de ser de esa fase: sin él, el cliente que borra este correo no tiene forma de
   * consultar su pedido y cada "¿ya salió?" acaba siendo trabajo manual del dueño por WhatsApp.
   */
  trackingPageUrl?: string;
}

/**
 * Escapa los metacaracteres HTML de un texto controlado por el usuario (nombre, dirección,
 * nombre de producto) antes de interpolarlo en el correo. Sin esto, un `&`/`<`/`>` legítimo
 * en una dirección rompe el render y un valor malicioso inyectaría markup. Se define local
 * (plantilla autónoma, igual que `formatMoney`).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Formatea un número como moneda es-MX: `$1,920.50`. Se duplica el helper privado de
 * `dashboard.service.ts` (no está exportado) para que este módulo de plantilla se
 * mantenga autónomo, igual que `passwordResetCode.ts`.
 */
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
 * Bloque con el link a la página pública de seguimiento (Fase O.4). Va en los dos correos
 * (confirmación y "va en camino") a propósito: el de confirmación es el que el cliente conserva,
 * y es justo el que puede borrar o perder en spam — cuantas más veces le llegue el link, menos
 * probable es que la consulta acabe siendo un WhatsApp al dueño.
 */
function trackingPageSection(url?: string): string {
  if (!url) return "";
  return `<div style="margin:24px 0 0;text-align:center;">
                <a href="${escapeHtml(url)}" style="display:inline-block;border:1px solid #7c2d12;color:#7c2d12;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:8px;">Ver el estado de mi pedido</a>
                <p style="margin:8px 0 0;font-size:12px;color:#a1a1aa;">
                  Guarda este enlace: con él puedes consultar tu pedido cuando quieras.
                </p>
              </div>`;
}

/**
 * Correo de confirmación de pedido: resumen de artículos (con precios congelados del
 * `OrderItem`, nunca del `Product` actual), totales y dirección de envío. Nunca incluye
 * `unitCost`. CSS inline: los clientes de correo no cargan hojas de estilo externas.
 */
export function orderConfirmationTemplate(input: OrderConfirmationInput): string {
  const {
    orderId,
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
  // La intro cambia según el disparo: con `tracking` es el correo "pedido enviado" (Fase 8.6), sin
  // él es la confirmación de pago (Fase 9.3). Sin esto, el correo de envío abriría con "Tu pago fue
  // confirmado", copy de confirmación que no corresponde a un aviso de que el pedido ya salió.
  const introHeading = input.tracking
    ? `¡Tu pedido va en camino, ${escapeHtml(customerName)}!`
    : `¡Gracias por tu compra, ${escapeHtml(customerName)}!`;
  const introBody = input.tracking
    ? `Tu pedido <strong>#${orderId}</strong> del ${formatOrderDate(createdAt)} ya salió de nuestra bodega. Abajo están los datos de rastreo y el resumen de tu compra.`
    : `Tu pago fue confirmado. Aquí está el resumen de tu pedido <strong>#${orderId}</strong> del ${formatOrderDate(createdAt)}.`;
  const savingsRow =
    savings > 0 ? totalsRow("Ahorraste", `− ${formatMoney(savings)}`, { accent: true }) : "";

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
                ${trackingPageSection(input.trackingPageUrl)}
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
