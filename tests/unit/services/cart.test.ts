import { computeTotals, computeShipping, CartLineItem } from "../../../src/services/cart";

// Dimensiones representativas por tipo, tomadas del catálogo sembrado (src/seed.ts). Desde la
// Fase N.6 `computeShipping` acomoda el carrito en cajas reales, así que el envío depende de
// estas medidas y no solo del tipo.
const DIMS: Record<CartLineItem["product"]["type"], Omit<CartLineItem["product"], "type" | "originalPrice" | "salePrice">> = {
  bota: { weightKg: 2.5, lengthCm: 35, widthCm: 30, heightCm: 20 },
  sombrero: { weightKg: 0.8, lengthCm: 45, widthCm: 45, heightCm: 20 },
  ropa: { weightKg: 0.3, lengthCm: 30, widthCm: 25, heightCm: 10 },
};

function line(
  type: CartLineItem["product"]["type"],
  originalPrice: number,
  salePrice: number,
  quantity: number
): CartLineItem {
  return { product: { type, originalPrice, salePrice, ...DIMS[type] }, quantity };
}

describe("computeTotals", () => {
  it("carrito vacío: todo en cero", () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, savings: 0, shipping: 0, total: 0 });
  });

  it("con descuento: savings > 0 y total refleja el precio de venta + envío", () => {
    // 1 bota: original 1000, venta 800, qty 2 → subtotal 2000, savings 400.
    // 2 botas caben en una sola caja, así que el envío sigue siendo un bulto: 160.
    const totals = computeTotals([line("bota", 1000, 800, 2)]);
    expect(totals).toEqual({ subtotal: 2000, savings: 400, shipping: 160, total: 1760 });
  });

  it("sin descuento: originalPrice === salePrice → savings 0", () => {
    const totals = computeTotals([line("ropa", 500, 500, 3)]);
    expect(totals).toEqual({ subtotal: 1500, savings: 0, shipping: 100, total: 1600 });
  });

  it("varias líneas: subtotal y savings se suman por línea, shipping usa el tipo más caro", () => {
    const totals = computeTotals([
      line("ropa", 500, 500, 1), // subtotal 500, savings 0
      line("sombrero", 800, 600, 1), // subtotal 800, savings 200
      line("bota", 1200, 1000, 1), // subtotal 1200, savings 200
    ]);
    // subtotal 2500, savings 400. Las tres piezas caben en una caja grande, y dentro de una
    // caja manda el tipo más caro: max(100,130,160) = 160.
    expect(totals).toEqual({ subtotal: 2500, savings: 400, shipping: 160, total: 2260 });
  });
});

describe("computeShipping", () => {
  it("carrito vacío → 0", () => {
    expect(computeShipping([])).toBe(0);
  });

  it("una sola pieza usa la tarifa de su tipo", () => {
    expect(computeShipping([line("bota", 100, 100, 1)])).toBe(160);
    expect(computeShipping([line("sombrero", 100, 100, 1)])).toBe(130);
    expect(computeShipping([line("ropa", 100, 100, 1)])).toBe(100);
  });

  it("dentro de una misma caja se cobra el tipo más caro que lleva", () => {
    expect(
      computeShipping([line("ropa", 100, 100, 1), line("sombrero", 100, 100, 1)])
    ).toBe(130);
    expect(
      computeShipping([
        line("ropa", 100, 100, 1),
        line("sombrero", 100, 100, 1),
        line("bota", 100, 100, 1),
      ])
    ).toBe(160);
  });

  it("el caso del reporte: 3 botas + 1 sombrero caben en una caja y se cobra un bulto", () => {
    // 3×21,000 + 40,500 = 103,500 cm³, dentro del volumen aprovechable de la caja grande.
    expect(
      computeShipping([line("bota", 100, 100, 3), line("sombrero", 100, 100, 1)])
    ).toBe(160);
  });

  it("REGRESIÓN Fase N.6: la cantidad SÍ afecta el envío cuando ya no cabe en una caja", () => {
    // Antes de esta fase `computeShipping` era un `Math.max` por tipo que ignoraba la cantidad:
    // estos tres casos cobraban $160, $160 y $100 respectivamente, sin importar cuántas piezas
    // llevara el carrito. Como la paquetería cobra una guía POR BULTO, cada caja extra salía de
    // la utilidad del dueño.

    // 8 botas = 168,000 cm³ → no caben en una sola caja grande (108,000 aprovechables): 5 + 3.
    expect(computeShipping([line("bota", 100, 100, 8)])).toBe(320);

    // 1 pieza vs 8 del mismo tipo ya no cuestan lo mismo.
    expect(computeShipping([line("bota", 100, 100, 8)])).toBeGreaterThan(
      computeShipping([line("bota", 100, 100, 1)])
    );

    // 50 piezas de ropa: 4 cajas (14 + 14 + 14 + 8), no una.
    expect(computeShipping([line("ropa", 100, 100, 50)])).toBe(400);
  });
});
