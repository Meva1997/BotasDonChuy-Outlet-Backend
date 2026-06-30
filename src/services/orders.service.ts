import { Op } from "sequelize";
import { sequelize } from "../config/database";
import { Product } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { Order } from "../models/Order";
import { OrderItem } from "../models/OrderItem";
import { AppError } from "../middlewares/AppError";
import { computeTotals, type CartLineItem } from "./cart";
import type { CreateOrderInput } from "../schemas/checkout";

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
      if (!product || product.visible === false || product.deletedAt != null) {
        throw new AppError(
          `Producto no disponible (id ${line.productId}, talla ${line.size})`,
          409,
        );
      }

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
        throw new AppError(
          `Sin stock suficiente para el producto ${line.productId} talla ${line.size}`,
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

    // 4. Totales recalculados en el servidor (autoritativo).
    const totals = computeTotals(cartItems);

    // 5. Crear la orden (mapeo del cliente a las columnas de la tabla).
    const { customer } = input;
    const created = await Order.create(
      {
        status: "pending",
        paymentStatus: "unpaid",
        subtotal: totals.subtotal,
        savings: totals.savings,
        shipping: totals.shipping,
        total: totals.total,
        customerName: customer.fullName,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        street: customer.street,
        neighborhood: customer.neighborhood,
        city: customer.city,
        state: customer.state,
        postalCode: customer.postalCode,
        references: customer.references ? customer.references : undefined,
        shippingCarrier: input.shippingCarrier ?? undefined,
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

  // 7. Recargar con sus items para la respuesta. Se excluye `unitCost` (costo
  //    interno / margen): la fila lo conserva congelado para reportes admin,
  //    pero NUNCA se serializa al cliente en esta ruta pública.
  const full = await Order.findByPk(order.id, {
    include: [
      { model: OrderItem, as: "items", attributes: { exclude: ["unitCost"] } },
    ],
  });
  return full!;
}
