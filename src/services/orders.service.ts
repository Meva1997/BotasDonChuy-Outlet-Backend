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
import type { CreateOrderInput } from "../schemas/checkout";

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
