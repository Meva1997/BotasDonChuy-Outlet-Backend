import { Op } from "sequelize";
import { sequelize } from "../config/database";
import { Product } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { AppError } from "../middlewares/AppError";
import { computeTotals, type CartLineItem } from "./cart";
import { assertProductAvailable } from "./productAvailability";
import { getQuotationRate, toSkydropxAddress, SkydropxRequestError } from "./skydropx.service";
import { sendAlertEmail } from "./alert.service";
// El avance manual de estado (Fase O.1) reusa el rango y el correo del camino automático:
// misma regla "solo hacia adelante" y mismo `idempotencyKey`, así los dos no se duplican.
import {
  ORDER_STATUS_RANK,
  statusesBelow,
  sendShipmentEmail,
  createPaymentIntentForOrder,
} from "./payment.service";
import { IdempotencyStore, fingerprintOf } from "../utils/idempotency";
import { stripe } from "../config/stripe";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";
import type { CreateOrderInput, OrderStatusUpdateInput } from "../schemas/checkout";

const RATE_UNAVAILABLE_MESSAGE =
  "La tarifa de envío que elegiste ya no está disponible (las cotizaciones expiran a las 24 h). Vuelve a calcular el envío para continuar.";

/**
 * Convierte un carrito de cliente en una orden persistida.
 *
 * Garantías clave:
 *  - **Totales autoritativos**: se recalculan en el servidor con `computeTotals`
 *    a partir de los precios guardados; el cliente nunca envía montos.
 *  - **Stock atómico**: el descuento es un `UPDATE ... SET stock = stock - N
 *    WHERE stock >= N` condicional dentro de una transacción. Si dos clientes
 *    pelean la última unidad, Postgres bloquea la fila y el perdedor re-evalúa
 *    la condición contra el stock ya en 0 → 0 filas afectadas → 409. La talla
 *    queda inhabilitada (stock 0) para el segundo.
 *  - **Precios congelados**: cada `OrderItem` guarda los precios del momento de
 *    la compra, así órdenes históricas no cambian si el producto se reprecia.
 *  - **Atomicidad total**: cualquier `throw` revierte la transacción completa,
 *    de modo que nunca quedan descuentos de stock parciales.
 *
 * La orden nace en `status: "pending"` / `paymentStatus: "unpaid"`. El cobro
 * real (Stripe) y la liberación de reservas vencidas llegan en Fase 8.
 */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  // 0. Envío autoritativo (Fase 8.4). Si el checkout cotizó en vivo, re-consultamos
  //    la cotización en Skydropx y tomamos el `total` de ESE rate como costo de envío
  //    — jamás confiamos en un monto que mande el cliente (misma regla que
  //    `computeTotals` aplica a subtotal/savings). Si no vienen `quotationId`/`rateId`
  //    (el checkout cayó al fallback de tarifa plana), `shippingOverride` queda null y
  //    más abajo se usa `computeShipping` como hasta ahora.
  //    Se resuelve ANTES de abrir la transacción a propósito: es un `GET` de red (hasta
  //    5s) que no toca la BD, y meterlo dentro mantendría abiertos los locks de
  //    `ProductSize` durante la llamada, invitando contención/deadlocks entre checkouts.
  let shippingOverride:
    | {
        total: number;
        quotationId: string;
        rateId: string;
        carrier: string;
        requiresDropoff: boolean;
      }
    | null = null;
  if (input.quotationId && input.rateId) {
    const destinationAddress = toSkydropxAddress(input.customer);
    let rate;
    try {
      rate = await getQuotationRate(input.quotationId, input.rateId, destinationAddress);
    } catch (err) {
      // Un 4xx de Skydropx al re-consultar (p. ej. quotationId ya purgado/inválido)
      // significa que la cotización ya no existe, no una falla transitoria — mismo
      // caso que un rate no encontrado, así que se trata igual (409, "vuelve a
      // cotizar"). Solo una falla de red/5xx/timeout amerita el 503 "reintenta".
      const status = err instanceof SkydropxRequestError ? err.status : undefined;
      const isClientError = status !== undefined && status >= 400 && status < 500;
      if (isClientError) {
        throw new AppError(RATE_UNAVAILABLE_MESSAGE, 409);
      }
      throw new AppError(
        "No pudimos confirmar el costo de envío en este momento. Intenta de nuevo en unos segundos.",
        503,
      );
    }
    if (!rate) {
      throw new AppError(RATE_UNAVAILABLE_MESSAGE, 409);
    }
    shippingOverride = {
      total: rate.total,
      quotationId: input.quotationId,
      rateId: input.rateId,
      carrier: rate.carrier,
      // Autoritativo: sale de la re-consulta a Skydropx, no del cliente. Le dice
      // al dueño si tiene que llevar el paquete a la sucursal (sin recolección).
      requiresDropoff: rate.requiresDropoff,
    };
  }

  // 1. Agregar renglones duplicados del mismo (productId, size) sumando cantidad.
  //    Evita descontar mal el stock y deja un único OrderItem por par.
  const aggregated = new Map<string, { productId: number; size: number; quantity: number }>();
  for (const item of input.items) {
    const key = `${item.productId}-${item.size}`;
    const existing = aggregated.get(key);
    if (existing) existing.quantity += item.quantity;
    else aggregated.set(key, { ...item });
  }

  // 2. Orden determinista (productId, luego size) para evitar deadlocks entre
  //    checkouts concurrentes que tocan los mismos productos en distinto orden.
  const lines = Array.from(aggregated.values()).sort(
    (a, b) => a.productId - b.productId || a.size - b.size,
  );

  const order = await sequelize.transaction(async (t) => {
    const cartItems: CartLineItem[] = [];
    const itemRows: Array<{
      productId: number;
      nameSnapshot: string;
      size: number;
      quantity: number;
      unitOriginalPrice: number;
      unitSalePrice: number;
      unitCost: number;
    }> = [];

    for (const line of lines) {
      const product = await Product.findByPk(line.productId, { transaction: t });
      assertProductAvailable(product);

      // 3. Descuento atómico de stock por talla (pieza anti–race-condition).
      const [affected] = await ProductSize.update(
        { stock: sequelize.literal(`stock - ${line.quantity}`) },
        {
          where: {
            productId: line.productId,
            size: line.size,
            stock: { [Op.gte]: line.quantity },
          },
          transaction: t,
        },
      );
      if (affected === 0) {
        // Solo en el error path (raro): releer la fila cuesta un SELECT extra
        // pero permite decir cuántas piezas quedan en vez de un "sin stock" seco.
        const remaining = await ProductSize.findOne({
          where: { productId: line.productId, size: line.size },
          transaction: t,
        });
        const available = remaining?.stock ?? 0;
        throw new AppError(
          available > 0
            ? `Solo ${available === 1 ? "queda 1 pieza" : `quedan ${available} piezas`} de "${product.name}" en talla ${line.size}. Ajusta la cantidad para continuar.`
            : `"${product.name}" se agotó en talla ${line.size}. Quítalo del carrito para continuar.`,
          409,
        );
      }

      cartItems.push({
        product: {
          type: product.type,
          originalPrice: product.originalPrice,
          salePrice: product.salePrice,
        },
        quantity: line.quantity,
      });
      itemRows.push({
        productId: product.id,
        nameSnapshot: product.name,
        size: line.size,
        quantity: line.quantity,
        unitOriginalPrice: product.originalPrice,
        unitSalePrice: product.salePrice,
        unitCost: product.unitCost,
      });
    }

    // 4. Totales recalculados en el servidor (autoritativo). Si hay cotización en
    //    vivo, su `total` reemplaza el envío de tarifa plana y el total se recompone
    //    en consecuencia; si no, se usan los de `computeTotals` tal cual.
    const totals = computeTotals(cartItems);
    const shipping = shippingOverride ? shippingOverride.total : totals.shipping;
    const total = totals.subtotal - totals.savings + shipping;

    // 5. Crear la orden (mapeo del cliente a las columnas de la tabla). El
    //    `shippingCarrier` viene del rate elegido cuando hubo cotización en vivo; si
    //    no, del que haya mandado el cliente (o queda vacío).
    const { customer } = input;
    const created = await Order.create(
      {
        status: "pending",
        paymentStatus: "unpaid",
        subtotal: totals.subtotal,
        savings: totals.savings,
        shipping,
        total,
        customerName: customer.fullName,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        street: customer.street,
        neighborhood: customer.neighborhood,
        city: customer.city,
        state: customer.state,
        postalCode: customer.postalCode,
        references: customer.references ? customer.references : undefined,
        shippingCarrier:
          shippingOverride?.carrier ?? input.shippingCarrier ?? undefined,
        skydropxQuotationId: shippingOverride?.quotationId ?? undefined,
        skydropxRateId: shippingOverride?.rateId ?? undefined,
        // Solo se sabe con cotización en vivo; en tarifa plana de respaldo queda
        // null (no aplica: la tienda no manda por Skydropx en ese caso).
        shippingRequiresDropoff: shippingOverride?.requiresDropoff ?? undefined,
      },
      { transaction: t },
    );

    // 6. Congelar precios en cada OrderItem.
    await OrderItem.bulkCreate(
      itemRows.map((r) => ({ orderId: created.id, ...r })),
      { transaction: t },
    );

    return created;
  });

  // 7. Recargar con sus items para la respuesta. Se excluyen campos internos que
  //    la fila conserva para el panel admin pero que NUNCA se serializan al
  //    cliente en esta ruta pública: `unitCost` (costo/margen) en cada item, y
  //    `shippingRequiresDropoff` (info operativa de recolección — solo le sirve
  //    al dueño para saber si debe llevar el paquete a la sucursal).
  const full = await Order.findByPk(order.id, {
    attributes: { exclude: ["shippingRequiresDropoff"] },
    include: [
      { model: OrderItem, as: "items", attributes: { exclude: ["unitCost"] } },
    ],
  });
  return full!;
}

// ── Checkout idempotente (Fase O.2) ───────────────────────────────────────────

/** Lo que devuelve un checkout: la orden persistida y el secreto para cobrarla. */
export interface PlacedOrder {
  order: Order;
  clientSecret: string | null;
}

/**
 * Lo mismo, más si esta respuesta es la **repetición** de un checkout anterior. El cuerpo
 * de un reenvío es byte a byte el del original (esa es justo la garantía de la fase), así
 * que sin este dato el cliente no puede distinguir "se creó tu pedido" de "ya lo tenías";
 * el controlador lo traduce al header `Idempotency-Replayed`.
 */
export interface PlaceOrderResult extends PlacedOrder {
  replayed: boolean;
}

/**
 * Estado que `executeCheckout` va marcando para que el manejo de errores sepa **hasta
 * dónde llegó** el intento. La distinción no es cosmética: mientras nada se haya
 * persistido, liberar la clave es lo correcto (el comprador corrige y reintenta al
 * instante); una vez que `createOrder` commiteó, liberarla convierte el reintento en un
 * segundo pedido con su segundo descuento de stock.
 */
interface CheckoutAttempt {
  persisted: boolean;
}

/**
 * Ventana de deduplicación del checkout. Corta a propósito: cubre el doble clic y el
 * reintento del navegador (segundos), no un segundo pedido legítimo del mismo cliente
 * más tarde. Coincide con la del import masivo por consistencia, no por necesidad.
 */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Se cachea la **promesa**, no el resultado: dos requests concurrentes (el caso real del
 * doble clic) llegan aquí antes de que el primero termine, y ambos deben esperar al
 * mismo checkout en vez de arrancar uno cada quien. `bodyHash` acompaña a la promesa
 * para detectar una `Idempotency-Key` reusada con otro carrito.
 */
const recentCheckouts = new IdempotencyStore<{
  bodyHash: string;
  result: Promise<PlacedOrder>;
}>(CHECKOUT_IDEMPOTENCY_WINDOW_MS);

/**
 * Huella del intento de compra. Se normaliza antes de hashear porque el mismo carrito
 * puede llegar con los renglones en distinto orden o partidos en varias líneas de la
 * misma talla: se agregan y se ordenan igual que en `createOrder`, así el reenvío del
 * mismo carrito da la misma huella.
 *
 * `quotationId`/`rateId` SÍ entran: si el cliente volvió a cotizar entre un clic y el
 * otro, el envío que va a pagar es distinto y no es el mismo pedido.
 */
function checkoutFingerprint(input: CreateOrderInput): string {
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    const key = `${item.productId}-${item.size}`;
    quantities.set(key, (quantities.get(key) ?? 0) + item.quantity);
  }
  const c = input.customer;
  return fingerprintOf({
    items: Array.from(quantities.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    // Lista posicional en vez del objeto: no depende del orden de claves que produzca zod.
    customer: [
      c.fullName,
      c.email,
      c.phone,
      c.street,
      c.neighborhood,
      c.city,
      c.state,
      c.postalCode,
      c.references ?? "",
    ],
    shippingCarrier: input.shippingCarrier ?? null,
    quotationId: input.quotationId ?? null,
    rateId: input.rateId ?? null,
  });
}

/**
 * Checkout completo e idempotente (Fase O.2): crea la orden, su PaymentIntent y devuelve
 * el `clientSecret`.
 *
 * **Por qué existe:** `POST /api/orders` era la única entrada crítica sin protección contra
 * reenvío. Un doble clic creaba otra fila `Order`, otro PaymentIntent real en Stripe y
 * **descontaba el stock otra vez**; ese inventario fantasma no se liberaba hasta que
 * `pendingOrderSweeper` alcanzara la orden (más de `PENDING_ORDER_TTL_MINUTES`), o sea 30–40
 * minutos bloqueado justo en el momento de más tráfico. `orderRateLimiter` no lo cubre: dos
 * clics están muy por debajo de 10 req/min.
 *
 * **Por qué devuelve el original en vez de un 409** (a diferencia del import masivo, que sí
 * rechaza): el cliente está esperando para pagar. Un 409 lo deja sin poder completar la compra
 * y encima con stock ya apartado a su nombre. La respuesta correcta a un reenvío es la misma
 * respuesta del original — mismo `order`, mismo `clientSecret`, mismo 201.
 *
 * **Dos capas de clave:**
 *  1. `Idempotency-Key` explícita si el cliente la manda (lo correcto a largo plazo, y lo que
 *     Stripe ya usa internamente para el reembolso de `cancelOrderByAdmin`). Reusar la misma
 *     clave con OTRO carrito es un error del cliente, no un reenvío → 409, para no devolverle
 *     jamás un pedido que no es el que acaba de armar.
 *  2. Piso automático sin tocar el frontend: huella del carrito + datos del cliente. Dos
 *     compradores distintos no pueden colisionar aquí (la huella incluye correo, teléfono y
 *     dirección completa); los que sí colisionan son los dos clics de la misma persona.
 *
 * Un intento fallido libera la clave **solo si no alcanzó a persistir nada**: los errores
 * comunes (409 sin stock, 503 de cotización, 400 de validación) ocurren antes de escribir
 * y el comprador tiene que poder corregir y reintentar de inmediato en vez de esperar la
 * ventana completa. Si en cambio falla *después* de que `createOrder` commiteó (Stripe
 * caído, por ejemplo), la clave se conserva: la orden y su stock descontado ya existen, y
 * un reintento que las duplique es peor que repetir el mismo error.
 */
export async function placeOrder(
  input: CreateOrderInput,
  idempotencyKey?: string,
): Promise<PlaceOrderResult> {
  const bodyHash = checkoutFingerprint(input);
  const key = idempotencyKey ? `key:${fingerprintOf(idempotencyKey)}` : `body:${bodyHash}`;

  const cached = recentCheckouts.get(key);
  if (cached) {
    if (cached.bodyHash !== bodyHash) {
      throw new AppError(
        "Esa clave de idempotencia ya se usó para otro pedido. Vuelve a cargar el checkout para generar una nueva y reintenta.",
        409,
      );
    }
    logger.info({ key }, "[orders] checkout duplicado: se devuelve el pedido original");
    return { ...(await cached.result), replayed: true };
  }

  // El `get` y el `set` van sin `await` de por medio a propósito: Node no interrumpe entre
  // ellos, así que dos requests concurrentes no pueden reclamar la clave los dos.
  const attempt: CheckoutAttempt = { persisted: false };
  const result = executeCheckout(input, attempt);
  recentCheckouts.set(key, { bodyHash, result });
  // El `.catch` es solo para decidir si se libera la clave; la promesa original es la que
  // se espera abajo, así que el error sí llega al llamador (y no queda ningún rechazo sin
  // manejar). Se registra ANTES del `await` para que corra aunque el llamador se vaya.
  result.catch((err) => releaseKeyOnFailure(key, result, attempt, err));
  return { ...(await result), replayed: false };
}

/**
 * Decide si un intento fallido libera su clave. Ver el bloque de `placeOrder`: liberar es
 * lo correcto solo mientras el intento no haya escrito nada.
 */
function releaseKeyOnFailure(
  key: string,
  result: Promise<PlacedOrder>,
  attempt: CheckoutAttempt,
  err: unknown,
): void {
  if (attempt.persisted) {
    logger.error(
      { key, err },
      "[orders] el checkout falló después de crear la orden: la clave NO se libera para que un reenvío no duplique el pedido ni el descuento de stock",
    );
    return;
  }
  // `deleteIf` y no `delete`: si este intento tardó más que el TTL, la entrada vigente ya
  // es la de otra petición y borrarla dejaría pasar un duplicado.
  recentCheckouts.deleteIf(key, (entry) => entry.result === result);
}

async function executeCheckout(
  input: CreateOrderInput,
  attempt: CheckoutAttempt,
): Promise<PlacedOrder> {
  const order = await createOrder(input);
  // Desde aquí el intento ya dejó huella en la BD (fila `Order` + stock descontado): lo que
  // falle de ahora en adelante NO puede tratarse como "no pasó nada, reintenta".
  attempt.persisted = true;

  const payment = await createPaymentIntentForOrder(order);
  if (payment.paymentIntentId) {
    await order.update({
      paymentIntentId: payment.paymentIntentId,
      paymentStatus: "processing",
    });
  }

  return { order, clientSecret: payment.clientSecret };
}

/**
 * Vacía la memoria de checkouts recientes. Existe **solo para los tests**: el estado vive en
 * el módulo y sobrevive al `truncateAll` entre casos, así que sin esto un caso que repite el
 * mismo carrito que otro recibiría la orden (ya borrada) del anterior.
 */
export function resetCheckoutIdempotency(): void {
  recentCheckouts.clear();
}

/**
 * Reversa del descuento de stock de una orden que no se pagó (cancelada o
 * abandonada). Es la operación inversa exacta del descuento atómico de
 * `createOrder`: por cada `OrderItem` devuelve su cantidad a la fila
 * `ProductSize` correspondiente.
 *
 * Garantías:
 *  - **Idempotente**: bloquea la fila de la orden (`FOR UPDATE`) y solo repone si
 *    aún está `pending`. Si otra ruta (webhook `canceled` vs. barrido) ya la
 *    cerró, no vuelve a sumar stock.
 *  - **Nunca repone una orden pagada**: si `status`/`paymentStatus` es `paid`, sale
 *    sin tocar nada (defensa contra una carrera con `payment_intent.succeeded`).
 *  - **Atómica**: todo ocurre en una transacción; cualquier fallo revierte tanto la
 *    reposición como el cambio de estado.
 */
export async function releaseOrderStock(
  orderId: number,
  finalStatus: "cancelled" = "cancelled",
): Promise<void> {
  await sequelize.transaction(async (t) => {
    // Se bloquea SOLO la fila de la orden (sin incluir items): Postgres rechaza
    // `FOR UPDATE` sobre el lado nullable de un LEFT JOIN, y para la idempotencia
    // basta con serializar el acceso a la orden.
    const order = await Order.findByPk(orderId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    // Solo se repone una orden que sigue reservando stock (pending). Una orden ya
    // pagada, cancelada o entregada no debe devolver stock.
    if (!order || order.status !== "pending") return;

    const items = await OrderItem.findAll({
      where: { orderId },
      transaction: t,
    });
    for (const item of items) {
      await ProductSize.update(
        { stock: sequelize.literal(`stock + ${item.quantity}`) },
        {
          where: { productId: item.productId, size: item.size },
          transaction: t,
        },
      );
    }

    await order.update(
      { status: finalStatus, paymentStatus: "failed" },
      { transaction: t },
    );
  });
}

/**
 * Cancelación/reembolso manual de una orden desde el panel admin (Fase H.5), para
 * cuando el cliente pide cancelar fuera del flujo de Stripe (WhatsApp, llamada).
 *
 *  - Solo son cancelables `pending` y `paid`. Una orden `shipped`/`delivered` ya salió
 *    con guía (no tiene sentido restockearla) y una `cancelled` ya está cerrada → 409.
 *  - **`pending`** (sin cobro capturado): reusa `releaseOrderStock` (restock + `cancelled`)
 *    y, best-effort, cancela el PaymentIntent en Stripe para no dejarlo huérfano.
 *  - **`paid`**: reembolsa en Stripe **antes** de restockear. El reembolso lleva una
 *    `idempotencyKey` derivada del id de la orden, así dos cancelaciones concurrentes no
 *    generan dos reembolsos. El restock va en una transacción que re-verifica
 *    `status === "paid"` bajo `FOR UPDATE`: si otra llamada ya lo cerró, no repone de más.
 *    Un reembolso fallido NO restockea (el dinero no volvió) y dispara una alerta operativa.
 */
export async function cancelOrderByAdmin(
  orderId: number,
  reason?: string,
): Promise<Order> {
  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new AppError("No se encontró el pedido que quieres cancelar.", 404);
  }

  if (order.status === "cancelled") {
    throw new AppError("Este pedido ya está cancelado.", 409);
  }
  if (order.status === "shipped" || order.status === "delivered") {
    throw new AppError(
      "Este pedido ya fue enviado y no se puede cancelar desde aquí. Gestiona la devolución con la paquetería.",
      409,
    );
  }

  if (order.status === "pending") {
    // Aún no hay cobro capturado; liberar el stock reservado y cerrar la orden.
    await releaseOrderStock(orderId);
    // Best-effort: cancelar el PaymentIntent para no dejarlo colgado en Stripe.
    if (order.paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(order.paymentIntentId);
      } catch (err) {
        logger.warn(
          { orderId, paymentIntentId: order.paymentIntentId, err },
          "[cancel] no se pudo cancelar el PaymentIntent de una orden pending",
        );
      }
    }
    logger.info({ orderId, reason }, "[cancel] orden pending cancelada por admin");
  } else {
    // status === "paid": reembolso real antes de restockear.
    if (!order.paymentIntentId) {
      throw new AppError(
        "El pedido figura como pagado pero no tiene un pago de Stripe asociado; no se puede reembolsar automáticamente.",
        409,
      );
    }

    let refund;
    try {
      refund = await stripe.refunds.create(
        { payment_intent: order.paymentIntentId },
        { idempotencyKey: `refund-order-${order.id}` },
      );
    } catch (err) {
      logger.error(
        { orderId, paymentIntentId: order.paymentIntentId, err },
        "[cancel] falló el reembolso en Stripe",
      );
      Sentry.captureException(err, { extra: { orderId } });
      void sendAlertEmail({
        subject: `Reembolso fallido al cancelar la orden #${orderId}`,
        context: {
          orderId,
          paymentIntentId: order.paymentIntentId,
          reason,
          error: (err as Error).message,
        },
      });
      throw new AppError(
        "No se pudo procesar el reembolso en Stripe. El pedido no se canceló; intenta de nuevo o revísalo en el panel de Stripe.",
        502,
      );
    }

    // Reembolso OK: restock + cierre en una transacción, con guard de idempotencia.
    await sequelize.transaction(async (t) => {
      const locked = await Order.findByPk(orderId, {
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      // Si otra cancelación concurrente ya lo cerró, no repongas de más (el reembolso
      // de esa otra llamada es el mismo por la idempotencyKey, no un cobro extra).
      if (!locked || locked.status !== "paid") return;

      const items = await OrderItem.findAll({ where: { orderId }, transaction: t });
      for (const item of items) {
        await ProductSize.update(
          { stock: sequelize.literal(`stock + ${item.quantity}`) },
          { where: { productId: item.productId, size: item.size }, transaction: t },
        );
      }

      await locked.update(
        {
          status: "cancelled",
          paymentStatus: "refunded",
          refundId: refund.id,
          refundedAt: new Date(),
        },
        { transaction: t },
      );
    });
    logger.info(
      { orderId, refundId: refund.id, reason },
      "[cancel] orden paid cancelada y reembolsada por admin",
    );
  }

  const full = await Order.findByPk(orderId, {
    include: [{ model: OrderItem, as: "items" }],
  });
  return full!;
}

/**
 * Avance manual del estado de envío desde el panel admin (Fase O.1), con la guía capturada
 * a mano si la hay.
 *
 * Existe porque `Order.status` solo llegaba a `shipped`/`delivered` desde
 * `applyShipmentUpdateFromWebhook`, o sea únicamente cuando Skydropx reporta un envío que
 * Skydropx creó. Un pedido que cayó al fallback de tarifa plana en el checkout nace sin
 * `skydropxRateId` → nunca se genera guía → nunca llega webhook → se quedaba en `paid` para
 * siempre, sin correo de "va en camino" y contando como pendiente en el dashboard.
 *
 * Reglas:
 *  - **Solo hacia adelante**, con el MISMO `ORDER_STATUS_RANK` que usa el webhook: un intento
 *    de retroceder (`delivered` → `shipped`) responde 409. Repetir el estado actual sí se
 *    permite — es como el dueño agrega una guía a un pedido que ya marcó enviado sin ella.
 *  - **`cancelled` no se toca aquí** (ni como origen ni como destino): cancelar es exclusivo de
 *    `cancelOrderByAdmin`, el único camino que reembolsa y restockea.
 *  - **Un pedido `pending` no se puede enviar**: todavía no hay cobro capturado y su stock sigue
 *    reservado a expensas del barrido de órdenes vencidas. Marcarlo enviado despacharía mercancía
 *    no pagada y dejaría a `pendingOrderSweeper` cancelando el PaymentIntent de un pedido ya en
 *    camino.
 *  - El correo "tu pedido va en camino" se reclama con el MISMO guard atómico del webhook
 *    (`WHERE trackingNumber IS NULL`), así que sale **exactamente una vez** por pedido sin
 *    importar si la guía la puso Skydropx o el dueño, y los dos caminos no pueden duplicarlo.
 */
export async function updateOrderStatusByAdmin(
  orderId: number,
  input: OrderStatusUpdateInput,
): Promise<Order> {
  const order = await Order.findByPk(orderId);
  if (!order) {
    throw new AppError("No se encontró el pedido que quieres actualizar.", 404);
  }

  if (order.status === "cancelled") {
    throw new AppError(
      "Este pedido está cancelado y ya no puede marcarse como enviado o entregado.",
      409,
    );
  }
  if (order.status === "pending") {
    throw new AppError(
      "Este pedido todavía no está pagado. Espera a que se confirme el pago para marcarlo como enviado.",
      409,
    );
  }

  const target = input.status;
  const currentRank = ORDER_STATUS_RANK[order.status];
  if (ORDER_STATUS_RANK[target] < currentRank) {
    throw new AppError(
      `Este pedido ya está marcado como ${order.status === "delivered" ? "entregado" : "enviado"} y el estado no puede retroceder.`,
      409,
    );
  }

  // Campos "último gana" (la captura manual es la fuente más reciente). Solo se escriben los
  // que vengan en el body: una llamada que solo cambia el estado nunca borra la guía guardada.
  const fieldUpdates: { trackingUrl?: string; shippingCarrier?: string } = {};
  if (input.trackingUrl) fieldUpdates.trackingUrl = input.trackingUrl;
  if (input.shippingCarrier) fieldUpdates.shippingCarrier = input.shippingCarrier;

  // Avance de estado atómico y solo hacia adelante, en su propio UPDATE con el mismo
  // `WHERE status IN (<rangos por debajo>)` del webhook: si un evento de Skydropx entra
  // concurrentemente, la BD serializa el cambio y ninguno de los dos retrocede al otro.
  // Se omite cuando el estado no cambia (re-`PATCH` para agregar la guía).
  if (ORDER_STATUS_RANK[target] > currentRank) {
    await Order.update(
      { status: target },
      { where: { id: order.id, status: { [Op.in]: statusesBelow(target) } } },
    );
  }

  // Guard atómico del correo: idéntico al del webhook. Solo la PRIMERA vez que un pedido
  // recibe número de guía se reclama el envío del correo; los `PATCH` posteriores actualizan
  // datos pero no lo reenvían.
  let shipmentEmailClaimed = false;
  if (input.trackingNumber && order.trackingNumber == null) {
    const [claimed] = await Order.update(
      { ...fieldUpdates, trackingNumber: input.trackingNumber },
      { where: { id: order.id, trackingNumber: null } },
    );
    shipmentEmailClaimed = claimed === 1;
    if (!shipmentEmailClaimed) {
      // El webhook (u otro PATCH concurrente) ya reclamó el trackingNumber: solo persistir el resto.
      await Order.update(fieldUpdates, { where: { id: order.id } });
    }
  } else if (Object.keys(fieldUpdates).length > 0) {
    await Order.update(fieldUpdates, { where: { id: order.id } });
  }

  const full = await Order.findByPk(orderId, {
    include: [{ model: OrderItem, as: "items" }],
  });

  if (shipmentEmailClaimed) {
    // Fire-and-forget, misma razón que en el webhook: `sendShipmentEmail` recarga la orden y
    // habla con Resend, y el panel no debe quedarse esperando esa ida y vuelta. Nunca lanza
    // (tiene su propio try/catch), así que un correo fallido no revierte el cambio de estado.
    // Se le pasa la instancia `order` (no la `full` que se devuelve): el helper hace su propio
    // `reload()` con los items sin `unitCost`, y hacerlo sobre `full` mutaría en segundo plano
    // el objeto que el controlador está por serializar.
    void sendShipmentEmail(order, {
      number: input.trackingNumber!,
      url: input.trackingUrl ?? order.trackingUrl ?? undefined,
      carrier: input.shippingCarrier ?? order.shippingCarrier ?? undefined,
    });
  }

  logger.info(
    { orderId, status: target, trackingNumber: input.trackingNumber },
    "[orders] estado de envío actualizado manualmente por admin",
  );

  return full!;
}
