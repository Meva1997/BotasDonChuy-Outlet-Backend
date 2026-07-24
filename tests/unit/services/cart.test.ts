import { computeTotals, computeShipping, CartLineItem } from "../../../src/services/cart";

function line(
  type: CartLineItem["product"]["type"],
  originalPrice: number,
  salePrice: number,
  quantity: number
): CartLineItem {
  return { product: { type, originalPrice, salePrice }, quantity };
}

describe("computeTotals", () => {
  it("carrito vacío: todo en cero", () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, savings: 0, shipping: 0, total: 0 });
  });

  it("con descuento: savings > 0 y total refleja el precio de venta + envío", () => {
    // 1 bota: original 1000, venta 800, qty 2 → subtotal 2000, savings 400, shipping 160
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
    // subtotal 2500, savings 400, shipping = max(100,130,160) = 160
    expect(totals).toEqual({ subtotal: 2500, savings: 400, shipping: 160, total: 2260 });
  });
});

describe("computeShipping", () => {
  it("carrito vacío → 0", () => {
    expect(computeShipping([])).toBe(0);
  });

  it("una sola línea usa la tarifa de su tipo", () => {
    expect(computeShipping([line("bota", 100, 100, 1)])).toBe(160);
    expect(computeShipping([line("sombrero", 100, 100, 1)])).toBe(130);
    expect(computeShipping([line("ropa", 100, 100, 1)])).toBe(100);
  });

  it("varias líneas: se cobra la tarifa del tipo más caro presente en el carrito", () => {
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

  it("cantidad de líneas no afecta el envío, solo el tipo", () => {
    expect(computeShipping([line("ropa", 100, 100, 50)])).toBe(100);
  });
});
