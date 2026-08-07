import { formatMoney } from "../../../utils/formatMoney";
import { formatStoreDayLabel } from "../../../utils/storeDay";
import { escapeHtml } from "./escapeHtml";

/**
 * Resumen diario de ventas para el dueño (Fase N.4). Es una herramienta de **reconciliación**, no
 * un disparador de acción: responde "cómo cerró el día", que es una pregunta distinta de "¿qué
 * empaco ahora?" — de ahí que no sustituya al aviso por venta sino que lo complemente.
 *
 * Cubre el **día anterior completo** en hora de la tienda, así que sus números no están truncados y
 * cuadran con lo que el dueño ve en el panel. Igual que el aviso por venta: sin `unitCost` ni
 * margen (un correo no está autenticado; el margen vive en el dashboard).
 */

/**
 * Una línea de artículos ya agrupada: mismo `nameSnapshot` + `size` + `unitSalePrice` colapsados en
 * una sola entrada con la cantidad sumada, para que el dueño vea "2 piezas de X talla 26" en vez de
 * dos renglones idénticos. El agrupado ocurre en el servicio (`groupOrderItems`), no aquí — el
 * template solo pinta lo que ya le llega agrupado.
 */
export interface DigestOrderItemLine {
  nameSnapshot: string;
  size: number;
  quantity: number;
  unitSalePrice: number;
}

export interface DigestOrderRow {
  id: number;
  /** Hora local de la tienda, ya formateada ("14:35"). */
  time: string;
  customerName: string;
  pieces: number;
  total: number;
  /** Estado del pedido al momento de armar el resumen (`paid`, `shipped`, …). */
  status: string;
  /** El pedido sigue sin guía de Skydropx: necesita atención del dueño. */
  needsLabel: boolean;
  /** La paquetería no recoge a domicilio. */
  requiresDropoff: boolean;
  /** Artículos vendidos en este pedido, agrupados por modelo/talla/precio. */
  items: DigestOrderItemLine[];
}

export interface DailySalesDigestInput {
  /** Día de la tienda que cubre el resumen, `YYYY-MM-DD`. */
  day: string;
  orders: DigestOrderRow[];
  totals: {
    orderCount: number;
    pieces: number;
    revenue: number;
    shipping: number;
    couponDiscount: number;
    savings: number;
  };
  adminUrl?: string;
}

const STATUS_LABELS: Record<string, string> = {
  paid: "Pagado",
  shipped: "Enviado",
  delivered: "Entregado",
};

/** Asunto autocontenido, igual que el aviso por venta: se lee sin abrir el correo. */
export function dailySalesDigestSubject(input: {
  day: string;
  orderCount: number;
  revenue: number;
}): string {
  const label = formatStoreDayLabel(input.day);
  if (input.orderCount === 0) return `Resumen del ${label} — sin ventas`;
  const orders = `${input.orderCount} ${input.orderCount === 1 ? "venta" : "ventas"}`;
  return `Resumen del ${label} — ${orders} — ${formatMoney(input.revenue)}`;
}

function totalsRow(label: string, value: string, opts?: { strong?: boolean }): string {
  const weight = opts?.strong ? "bold" : "normal";
  const size = opts?.strong ? "16px" : "14px";
  return `<tr>
              <td style="padding:4px 8px;font-size:${size};color:#52525b;">${label}</td>
              <td align="right" style="padding:4px 8px;font-size:${size};font-weight:${weight};color:#18181b;white-space:nowrap;">${value}</td>
            </tr>`;
}

/**
 * Una línea por grupo de artículo ("2 piezas · Bota Alta Café · talla 26 · $850.00 c/u"), para que el
 * dueño vea qué se vendió sin entrar al panel. El "c/u" solo aparece cuando hay más de una pieza —
 * con una sola pieza sería redundante.
 */
function itemLine(item: DigestOrderItemLine): string {
  const piecesLabel = item.quantity === 1 ? "pieza" : "piezas";
  const priceLabel =
    item.quantity > 1 ? `${formatMoney(item.unitSalePrice)} c/u` : formatMoney(item.unitSalePrice);
  return `${item.quantity} ${piecesLabel} · ${escapeHtml(item.nameSnapshot)} · talla ${item.size} · ${priceLabel}`;
}

function itemsBlock(items: DigestOrderItemLine[]): string {
  if (items.length === 0) return "";
  return `<div style="margin:6px 0 0;font-size:12px;line-height:1.6;color:#71717a;">
                  ${items.map(itemLine).join("<br />\n                  ")}
                </div>`;
}

function orderRow(order: DigestOrderRow): string {
  const flags: string[] = [];
  if (order.needsLabel) flags.push("sin guía");
  if (order.requiresDropoff) flags.push("llevar a sucursal");
  const flagLine =
    flags.length > 0
      ? `<br /><span style="font-size:12px;color:#b91c1c;">${escapeHtml(flags.join(" · "))}</span>`
      : "";
  return `<tr>
              <td style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;">
                <strong>#${order.id}</strong> · ${order.time}<br />
                <span style="font-size:12px;color:#52525b;">${escapeHtml(order.customerName)} · ${
    STATUS_LABELS[order.status] ?? escapeHtml(order.status)
  }</span>${flagLine}
                ${itemsBlock(order.items)}
              </td>
              <td align="center" style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;white-space:nowrap;">
                ${order.pieces}
              </td>
              <td align="right" style="padding:10px 8px;border-bottom:1px solid #f4f4f5;font-size:14px;color:#18181b;white-space:nowrap;">
                ${formatMoney(order.total)}
              </td>
            </tr>`;
}

/**
 * Bloque de "requieren acción": los pedidos del día que siguen sin guía o que hay que llevar a
 * sucursal. Es lo que evita que un pedido se quede esperando una guía que nadie va a generar — el
 * mismo hueco que abrió la Fase O.1 y que el aviso por venta cubre en caliente, aquí revisado al
 * cierre del día por si el aviso se perdió.
 */
function actionSection(orders: DigestOrderRow[]): string {
  const pending = orders.filter((o) => o.needsLabel || o.requiresDropoff);
  if (pending.length === 0) return "";
  const items = pending
    .map((o) => {
      const reasons: string[] = [];
      if (o.needsLabel) reasons.push("todavía sin guía");
      if (o.requiresDropoff) reasons.push("hay que llevarlo a la sucursal de la paquetería");
      return `<li style="margin:0 0 4px;">Pedido <strong>#${o.id}</strong>: ${escapeHtml(reasons.join(" y "))}.</li>`;
    })
    .join("\n                    ");
  return `<div style="margin:0 0 20px;padding:14px 16px;background-color:#fef2f2;border-left:4px solid #dc2626;border-radius:6px;">
                  <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#991b1b;">Requieren acción</p>
                  <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5;color:#7f1d1d;">
                    ${items}
                  </ul>
                </div>`;
}

function emptyBody(day: string): string {
  return `<p style="margin:0;font-size:15px;line-height:1.6;color:#52525b;">
                  No hubo ventas el ${formatStoreDayLabel(day)}.
                </p>
                <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#a1a1aa;">
                  Este resumen llega todos los días aunque no haya ventas: así un día flojo se
                  distingue de un sistema caído.
                </p>`;
}

function adminButton(url?: string): string {
  if (!url) return "";
  return `<div style="margin:24px 0 0;text-align:center;">
                  <a href="${escapeHtml(url)}" style="display:inline-block;background-color:#7c2d12;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:8px;">Abrir el panel</a>
                </div>`;
}

export function dailySalesDigestTemplate(input: DailySalesDigestInput): string {
  const { totals } = input;
  const label = formatStoreDayLabel(input.day);

  const body =
    totals.orderCount === 0
      ? emptyBody(input.day)
      : `${actionSection(input.orders)}

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #e4e4e7;">
                  <tr>
                    <td style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Pedido</td>
                    <td align="center" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Pzas</td>
                    <td align="right" style="padding:8px;font-size:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.5px;">Total</td>
                  </tr>
                  ${input.orders.map(orderRow).join("\n                  ")}
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0;">
                  ${totalsRow("Piezas vendidas", String(totals.pieces))}
                  ${totalsRow("Envío cobrado", formatMoney(totals.shipping))}
                  ${
                    totals.savings > 0
                      ? totalsRow("Ahorro outlet otorgado", `− ${formatMoney(totals.savings)}`)
                      : ""
                  }
                  ${
                    totals.couponDiscount > 0
                      ? totalsRow("Descuento por cupón", `− ${formatMoney(totals.couponDiscount)}`)
                      : ""
                  }
                  ${totalsRow("Ingreso cobrado", formatMoney(totals.revenue), { strong: true })}
                </table>`;

  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background-color:#7c2d12;padding:20px 32px;">
                <h1 style="margin:0;font-size:20px;color:#ffffff;">Resumen del ${label}</h1>
                <p style="margin:4px 0 0;font-size:14px;color:#fed7aa;">
                  ${totals.orderCount} ${totals.orderCount === 1 ? "venta" : "ventas"} · ${formatMoney(totals.revenue)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;">
                ${body}
                ${adminButton(input.adminUrl)}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  Cubre de las 00:00 a las 23:59 (hora de Celaya) del ${label}. Aviso automático de
                  Botas Don Chuy Outlet; no respondas a este mensaje.
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
