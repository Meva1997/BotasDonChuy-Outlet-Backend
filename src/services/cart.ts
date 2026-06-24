export interface CartLineItem {
  product: {
    type: "bota" | "sombrero" | "ropa";
    originalPrice: number;
    salePrice: number;
  };
  quantity: number;
}

export interface CartTotals {
  subtotal: number;
  savings: number;
  shipping: number;
  total: number;
}

// Tarifa fija por tipo de producto (el tipo más caro del carrito determina el costo).
// Bota: caja grande y pesada. Sombrero: voluminoso. Ropa: ligera.
const SHIPPING_BY_TYPE: Record<string, number> = {
  bota: 160,
  sombrero: 130,
  ropa: 100,
};
const SHIPPING_FALLBACK = 150;

export function computeShipping(items: CartLineItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(
    ...items.map((item) => SHIPPING_BY_TYPE[item.product.type] ?? SHIPPING_FALLBACK)
  );
}

export function computeTotals(items: CartLineItem[]): CartTotals {
  const subtotal = items.reduce(
    (acc, item) => acc + item.product.originalPrice * item.quantity,
    0
  );
  const savings = items.reduce(
    (acc, item) =>
      acc + (item.product.originalPrice - item.product.salePrice) * item.quantity,
    0
  );
  const shipping = computeShipping(items);

  return { subtotal, savings, shipping, total: subtotal - savings + shipping };
}
