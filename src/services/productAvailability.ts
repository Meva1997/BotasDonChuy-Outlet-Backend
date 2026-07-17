import { AppError } from "../middlewares/AppError";
import type { Product } from "../models/Product";

/**
 * Guardia compartida entre el checkout (`orders.service.createOrder`) y la
 * cotización de envío (`shipping.controller.getShippingRates`): un producto
 * inexistente, oculto o soft-deleted no puede comprarse ni cotizarse, y ambos
 * flujos deben mostrar el mismo mensaje accionable (CLAUDE.md — los mensajes
 * de error son la copia de UI del frontend).
 */
export function assertProductAvailable(
  product: Product | null | undefined,
): asserts product is Product {
  if (!product || product.visible === false || product.deletedAt != null) {
    throw new AppError(
      product
        ? `"${product.name}" ya no está disponible. Quítalo del carrito para continuar.`
        : "Uno de los productos de tu carrito ya no está disponible. Revísalo para continuar.",
      409,
    );
  }
}
