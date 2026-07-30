import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { FRONTEND_URL } from "../config/resend";
import { sendEmail } from "./email.service";
import {
  countPieces,
  newOrderNotificationSubject,
  newOrderNotificationTemplate,
} from "./email/templates/newOrderNotification";
import { logger } from "../config/logger";

/**
 * Avisos de NEGOCIO al dueño (Fase N.4), separados de `alert.service.ts`, que solo manda correo
 * cuando algo **falla**. Hasta esta fase no existía nada para el evento más importante de la
 * tienda —una venta— y el dueño se enteraba de un pedido pagado solo si abría el panel.
 *
 * La separación no es cosmética: van a otro destinatario configurable (`OWNER_NOTIFICATION_EMAIL`)
 * justamente para que "vendiste" se pueda filtrar, silenciar o redirigir aparte de "algo se rompió"
 * — y para que más adelante las alertas técnicas puedan irse a otra persona sin perder los avisos
 * de venta.
 */

/**
 * Destinatario de los avisos de venta. Se lee en **cada llamada** y no al cargar el módulo, igual
 * que `alert.service.ts`: así los tests pueden definirla en un `beforeAll` y el operador puede
 * cambiarla sin reiniciar el proceso.
 *
 * Sin `OWNER_NOTIFICATION_EMAIL` cae a `ALERT_EMAIL_TO` (que muchos despliegues ya tienen puesta),
 * y sin ninguna de las dos la fase entera queda apagada — ese es su interruptor, por eso no hay una
 * env var booleana aparte.
 */
export function ownerNotificationRecipient(): string | undefined {
  const explicit = process.env.OWNER_NOTIFICATION_EMAIL?.trim();
  if (explicit) return explicit;
  const fallback = process.env.ALERT_EMAIL_TO?.trim();
  return fallback || undefined;
}

/** Link al panel. Es una sola página (`/admin`), así que no se inventa una ruta profunda. */
function adminUrl(): string {
  return `${FRONTEND_URL.replace(/\/+$/, "")}/admin`;
}

/**
 * Aviso de venta nueva. Se dispara **fire-and-forget** desde `markOrderPaidFromWebhook`, dentro de
 * su guard atómico `affected === 1` — el mismo `UPDATE` condicional que serializa a nivel de BD el
 * webhook de Stripe y el `pendingOrderSweeper`, así que el aviso sale exactamente una vez por
 * pedido sin lógica de deduplicación propia. El `idempotencyKey` de Resend (24h) es el segundo
 * cinturón, igual que en los correos al cliente.
 *
 * **Nunca lanza**: `sendEmail` ya "loguea pero no lanza" y el try/catch cubre además la consulta.
 * Un aviso fallido jamás debe propagar a un webhook que tiene que responder 200.
 *
 * Recarga el pedido en una **instancia nueva** (`findByPk`) en vez de `order.reload()`: el correo
 * de confirmación al cliente se dispara en paralelo sobre esa misma instancia y también la recarga,
 * con otro juego de `attributes`. Dos `reload()` concurrentes sobre el mismo objeto se pisan a
 * media renderización — es la misma familia de bug que obligó, en `updateOrderStatusByAdmin`, a no
 * pasarle a `sendShipmentEmail` la instancia que se está serializando de vuelta.
 */
export async function sendNewOrderNotification(order: Order): Promise<void> {
  const to = ownerNotificationRecipient();
  if (!to) {
    logger.warn(
      { orderId: order.id },
      "OWNER_NOTIFICATION_EMAIL/ALERT_EMAIL_TO no configurados; aviso de venta omitido",
    );
    return;
  }

  try {
    const full = await Order.findByPk(order.id, {
      include: [
        // Sin `unitCost`: este correo no lo renderiza y lo más seguro es que ni salga de Postgres.
        { model: OrderItem, as: "items", attributes: { exclude: ["unitCost"] } },
      ],
    });
    if (!full) {
      logger.warn({ orderId: order.id }, "[aviso-venta] el pedido ya no existe; aviso omitido");
      return;
    }

    const items = (full.items ?? []).map((it) => ({
      nameSnapshot: it.nameSnapshot,
      size: it.size,
      quantity: it.quantity,
      unitSalePrice: it.unitSalePrice,
    }));
    // Un pedido sin tarifa de Skydropx cayó al fallback de tarifa plana: `createShipmentForOrder`
    // se retira sin generar guía, así que la tiene que hacer el dueño a mano. Se sabe desde el
    // checkout (no hace falta esperar a la creación de la guía), que es lo que permite mandar este
    // aviso de inmediato en vez de encadenarlo a una llamada a Skydropx que puede tardar o fallar.
    const hasSkydropxRate = Boolean(full.skydropxRateId);

    await sendEmail({
      to,
      subject: newOrderNotificationSubject({
        orderId: full.id,
        total: full.total,
        pieces: countPieces(items),
        hasSkydropxRate,
      }),
      html: newOrderNotificationTemplate({
        orderId: full.id,
        createdAt: full.createdAt,
        customerName: full.customerName,
        customerEmail: full.customerEmail,
        customerPhone: full.customerPhone,
        items,
        subtotal: full.subtotal,
        savings: full.savings,
        shipping: full.shipping,
        couponCode: full.couponCode,
        couponDiscount: full.couponDiscount,
        total: full.total,
        shippingAddress: {
          street: full.street,
          neighborhood: full.neighborhood,
          city: full.city,
          state: full.state,
          postalCode: full.postalCode,
          references: full.references,
        },
        shippingCarrier: full.shippingCarrier,
        requiresDropoff: full.shippingRequiresDropoff,
        hasSkydropxRate,
        adminUrl: adminUrl(),
      }),
      idempotencyKey: `new-order/${full.id}`,
    });
  } catch (err) {
    // Sin `sendAlertEmail` aquí: si Resend está caído, alertar por el mismo canal caería en el
    // bucle que `alert.service.ts` documenta explícitamente.
    logger.error({ orderId: order.id, err }, "[aviso-venta] no se pudo enviar el aviso de venta");
  }
}
