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
// ⚠️ Duplicado a propósito con frontend/lib/cart.ts (este backend es la autoridad
// de precios). Si cambias una tarifa, cámbiala también allí o el formulario del
// checkout mostrará un envío y la confirmación otro.
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

/** Lo que `computeCouponDiscount` necesita de un cupón. Deliberadamente NO es el modelo
 *  `Coupon`: así esta función queda pura y testeable sin Postgres, igual que el resto de
 *  este archivo. */
export interface CouponSpec {
  type: "percent" | "fixed";
  value: number;
  /** Tope en pesos del descuento. Solo aplica a `percent` (lo valida el schema). */
  maxDiscount?: number | null;
}

/**
 * Descuento en pesos de un cupón (Fase N.2). Es la ÚNICA implementación: la usan tanto
 * `orders.service.createOrder` como `POST /api/coupons/validate`, porque si fueran dos el
 * preview podría prometer un descuento distinto al que se cobra.
 *
 * Tres invariantes, y cada uno protege al dueño de una forma distinta de perder dinero:
 *
 *  1. **La base es la mercancía NETA** (`subtotal − savings`), que el llamador pasa aquí. En
 *     este repo `subtotal` está a precio ORIGINAL y `savings` es el descuento outlet, así que
 *     calcular sobre `subtotal` regalaría porcentaje sobre un precio que nadie paga.
 *  2. **El envío nunca entra.** No es un parámetro de esta función justamente para que no pueda
 *     colarse: un cupón de producto no debe regalar la paquetería, que se paga a un tercero.
 *  3. **Clamp a `[0, neto]`.** Un cupón `fixed` de $5,000 sobre un carrito de $1,600 descuenta
 *     $1,600 y nunca deja un total negativo (que Stripe rechazaría, y encima después de que
 *     `createOrder` ya commiteó — ver el guard de mínimo cobrable en `coupon.service.ts`).
 *
 * Todo se calcula en **centavos enteros** y se redondea UNA sola vez, antes de que el valor
 * toque la BD. La columna es `DECIMAL(10,2)`: sin este cuidado, Postgres redondearía por su
 * cuenta al guardar (medio hacia afuera del cero) mientras `/validate` —que nunca pasa por la
 * BD— mostraría el redondeo de JS (medio hacia arriba), y el preview diferiría del cobro en un
 * centavo justo en los porcentajes que caen exactamente a la mitad.
 */
export function computeCouponDiscount(
  coupon: CouponSpec,
  netMerchandise: number
): number {
  const netCents = Math.round(netMerchandise * 100);
  if (netCents <= 0) return 0;

  let cents =
    coupon.type === "percent"
      ? Math.round(netCents * (coupon.value / 100))
      : Math.round(coupon.value * 100);

  if (coupon.maxDiscount != null) {
    cents = Math.min(cents, Math.round(coupon.maxDiscount * 100));
  }
  cents = Math.min(Math.max(cents, 0), netCents);

  return cents / 100;
}
