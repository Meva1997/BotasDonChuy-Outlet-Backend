import { formatMoney } from "../../../utils/formatMoney";
import { escapeHtml } from "./escapeHtml";

/**
 * Aviso al DUEÑO de una venta nueva (Fase N.4). No es el recibo del cliente: aquí no hay copy de
 * agradecimiento, sino lo que hace falta para **despachar el pedido** — tallas, dirección, contacto
 * y, sobre todo, las dos condiciones operativas que obligan a hacer algo a mano (ver `actionBlocks`).
 *
 * Lo que NUNCA lleva: `unitCost` ni margen. Un correo no está autenticado, se reenvía y vive en una
 * bandeja; la regla del repo es que los campos de costo solo aparecen en rutas admin con JWT, y el
 * margen ya está en el dashboard.
 */

interface NewOrderItem {
  nameSnapshot: string;
  size: number;
  quantity: number;
  unitSalePrice: number;
}

interface NewOrderAddress {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  references?: string | null;
}

export interface NewOrderNotificationInput {
  orderId: number;
  createdAt: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: NewOrderItem[];
  subtotal: number;
  savings: number;
  shipping: number;
  couponCode?: string | null;
  couponDiscount?: number;
  total: number;
  shippingAddress: NewOrderAddress;
  shippingCarrier?: string | null;
  /**
   * `true` = la paquetería NO recoge a domicilio y hay que llevar el paquete a su sucursal. Dato
   * operativo del dueño (se excluye de toda respuesta al cliente) y por eso aquí **sí** va: es la
   * mitad de la razón por la que este correo existe.
   */
  requiresDropoff?: boolean | null;
  /**
   * `false` = el pedido se cobró con la tarifa plana de respaldo (Skydropx no cotizó al pagar), así
   * que no hay `rate_id` que convertir en guía y **nadie la va a generar automáticamente**. Sin
   * este aviso, ese pedido se queda esperando una guía que nunca llega.
   */
  hasSkydropxRate: boolean;
  /** Link al panel para abrir el pedido. */
  adminUrl?: string;
}

/** Piezas totales del pedido (no renglones): es lo que el dueño va a empacar. */
export function countPieces(items: { quantity: number }[]): number {
  return items.reduce((acc, item) => acc + item.quantity, 0);
}

/**
 * Asunto autocontenido a propósito: con el volumen de lanzamiento un correo por venta no es ruido,
 * pero para que siga sin serlo a 20–30 diarias tiene que poder **leerse sin abrirlo**. De ahí el
 * total y las piezas en el asunto, y el sufijo cuando el pedido exige una guía manual — que es la
 * única parte que no puede esperar.
 */
export function newOrderNotificationSubject(input: {
  orderId: number;
  total: number;
  pieces: number;
  hasSkydropxRate: boolean;
}): string {
  const pieces = `${input.pieces} ${input.pieces === 1 ? "pieza" : "piezas"}`;
  const suffix = input.hasSkydropxRate ? "" : " — GUÍA MANUAL";
  return `Venta #${input.orderId} — ${formatMoney(input.total)} — ${pieces}${suffix}`;
}

/** Hora local de la tienda, igual que la fecha del recibo del cliente (Celaya, GTO, no UTC). */
function formatOrderDateTime(date: Date): string {
  return date.toLocaleString("es-MX", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Mexico_City",
  });
}

function itemRow(item: NewOrderItem): string {
  return `<tr>
              <td style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;">
                ${escapeHtml(item.nameSnapshot)}<br />
                <span style="font-size:12px;color:#52525b;">Talla ${item.size}</span>
              </td>
              <td align="center" style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;white-space:nowrap;">
                ×${item.quantity}
              </td>
              <td align="right" style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;white-space:nowrap;">
                ${formatMoney(item.unitSalePrice * item.quantity)}
              </td>
            </tr>`;
}

function totalsRow(label: string, value: string, opts?: { strong?: boolean }): string {
  const weight = opts?.strong ? "bold" : "normal";
  const size = opts?.strong ? "16px" : "14px";
  return `<tr>
              <td style="padding:4px 8px;font-size:${size};color:#52525b;">${label}</td>
              <td align="right" style="padding:4px 8px;font-size:${size};font-weight:${weight};color:#18181b;white-space:nowrap;">${value}</td>
            </tr>`;
}

function warningBlock(title: string, body: string): string {
  return `<div style="margin:0 0 12px;padding:14px 16px;background-color:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;">
                  <p style="margin:0;font-size:14px;font-weight:bold;color:#991b1b;">${title}</p>
                  <p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#7f1d1d;">${body}</p>
                </div>`;
}

/**
 * Los dos avisos que convierten este correo en un disparador de acción. El texto del primero es el
 * mismo que responde el `409` de `retryShipmentForOrder`, para que el dueño lea la misma
 * instrucción venga del correo o del panel.
 */
function actionBlocks(input: NewOrderNotificationInput): string {
  const blocks: string[] = [];
  if (!input.hasSkydropxRate) {
    blocks.push(
      warningBlock(
        "Esta venta necesita guía manual",
        "Se cobró con la tarifa plana de respaldo, así que no tiene una tarifa de Skydropx que convertir en guía. Genérala en el panel de Skydropx y captura su número al marcar el pedido como enviado.",
      ),
    );
  }
  if (input.requiresDropoff) {
    blocks.push(
      warningBlock(
        "La paquetería no recoge a domicilio",
        "Hay que llevar el paquete a la sucursal de la paquetería para que salga.",
      ),
    );
  }
  return blocks.join("\n                ");
}

function adminButton(url?: string): string {
  if (!url) return "";
  return `<div style="margin:24px 0 0;text-align:center;">
                  <a href="${escapeHtml(url)}" style="display:inline-block;background-color:#7c2d12;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:8px;">Abrir el panel</a>
                </div>`;
}

export function newOrderNotificationTemplate(input: NewOrderNotificationInput): string {
  const addr = input.shippingAddress;
  const pieces = countPieces(input.items);
  const savingsRow =
    input.savings > 0 ? totalsRow("Ahorro outlet", `− ${formatMoney(input.savings)}`) : "";
  const couponRow =
    input.couponDiscount && input.couponDiscount > 0
      ? totalsRow(
          input.couponCode ? `Cupón ${escapeHtml(input.couponCode)}` : "Cupón",
          `− ${formatMoney(input.couponDiscount)}`,
        )
      : "";
  const carrierLine = input.shippingCarrier
    ? `<p style="margin:8px 0 0;font-size:14px;color:#52525b;">Paquetería: ${escapeHtml(input.shippingCarrier)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background-color:#166534;padding:20px 32px;">
                <h1 style="margin:0;font-size:20px;color:#ffffff;">Nueva venta · #${input.orderId}</h1>
                <p style="margin:4px 0 0;font-size:14px;color:#dcfce7;">${formatMoney(input.total)} · ${pieces} ${
    pieces === 1 ? "pieza" : "piezas"
  } · ${formatOrderDateTime(input.createdAt)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;">
                ${actionBlocks(input)}

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #e4e4e7;">
                  <tr>
                    <td style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Artículo</td>
                    <td align="center" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Cant.</td>
                    <td align="right" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Importe</td>
                  </tr>
                  ${input.items.map(itemRow).join("\n                  ")}
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  ${totalsRow("Subtotal", formatMoney(input.subtotal))}
                  ${savingsRow}
                  ${couponRow}
                  ${totalsRow("Envío", formatMoney(input.shipping))}
                  ${totalsRow("Total cobrado", formatMoney(input.total), { strong: true })}
                </table>

                <div style="margin:0 0 12px;padding:16px;background-color:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
                  <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#18181b;">Enviar a</p>
                  <p style="margin:0;font-size:14px;line-height:1.5;color:#52525b;">
                    <strong style="color:#18181b;">${escapeHtml(input.customerName)}</strong><br />
                    ${escapeHtml(addr.street)}<br />
                    ${escapeHtml(addr.neighborhood)}<br />
                    ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)}, C.P. ${escapeHtml(addr.postalCode)}${
    addr.references ? `<br />Referencias: ${escapeHtml(addr.references)}` : ""
  }
                  </p>
                  ${carrierLine}
                </div>

                <div style="margin:0;padding:16px;background-color:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
                  <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#18181b;">Contacto del cliente</p>
                  <p style="margin:0;font-size:14px;line-height:1.5;color:#52525b;">
                    ${escapeHtml(input.customerEmail)}<br />
                    ${escapeHtml(input.customerPhone)}
                  </p>
                </div>

                ${adminButton(input.adminUrl)}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  Aviso automático de Botas Don Chuy Outlet. No respondas a este mensaje.
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
