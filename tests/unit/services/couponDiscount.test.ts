/**
 * Nivel 1 (Fase N.2): la matemática del descuento, pura y sin BD.
 *
 * Es la única implementación que comparten el checkout y `POST /api/coupons/validate`, así que
 * cada invariante que se rompa aquí se rompe en los dos lados a la vez.
 */
import { computeCouponDiscount } from "../../../src/services/cart";

describe("computeCouponDiscount — porcentaje", () => {
  it("aplica el porcentaje sobre la mercancía neta", () => {
    expect(computeCouponDiscount({ type: "percent", value: 10 }, 2000)).toBe(200);
  });

  it("un 100% descuenta exactamente el neto, nunca más", () => {
    expect(computeCouponDiscount({ type: "percent", value: 100 }, 1499)).toBe(1499);
  });

  it("respeta el tope en pesos cuando el porcentaje lo excede", () => {
    // 50% de 4000 serían 2000; el tope lo baja a 500.
    expect(
      computeCouponDiscount({ type: "percent", value: 50, maxDiscount: 500 }, 4000),
    ).toBe(500);
  });

  it("ignora el tope cuando el porcentaje queda por debajo", () => {
    expect(
      computeCouponDiscount({ type: "percent", value: 10, maxDiscount: 500 }, 2000),
    ).toBe(200);
  });
});

describe("computeCouponDiscount — monto fijo", () => {
  it("descuenta el monto cuando cabe en el carrito", () => {
    expect(computeCouponDiscount({ type: "fixed", value: 300 }, 2000)).toBe(300);
  });

  it("un monto mayor que el carrito se recorta al neto (jamás un total negativo)", () => {
    // Sin este clamp, el total quedaría en negativo y Stripe rechazaría el cobro DESPUÉS de que
    // la orden ya se commiteó, dejando stock y cupón apartados 30 min.
    expect(computeCouponDiscount({ type: "fixed", value: 5000 }, 1600)).toBe(1600);
  });
});

describe("computeCouponDiscount — bordes y redondeo", () => {
  it("un neto de 0 no genera descuento", () => {
    expect(computeCouponDiscount({ type: "percent", value: 20 }, 0)).toBe(0);
  });

  it("un neto negativo (defensivo) tampoco", () => {
    expect(computeCouponDiscount({ type: "fixed", value: 100 }, -50)).toBe(0);
  });

  it("redondea a dos decimales, sin arrastrar flotantes", () => {
    // 15% de 2333.33 = 349.99950 → 350.00 exacto, no 349.99950000000004.
    expect(computeCouponDiscount({ type: "percent", value: 15 }, 2333.33)).toBe(350);
  });

  it("un porcentaje con decimales sigue dando un valor de dos decimales", () => {
    const discount = computeCouponDiscount({ type: "percent", value: 12.5 }, 1000.04);
    expect(discount).toBe(Number(discount.toFixed(2)));
    expect(discount).toBeCloseTo(125.01, 2);
  });

  it("el envío no puede intervenir: la función solo recibe el neto", () => {
    // El mismo neto da el mismo descuento sin importar el envío del pedido, porque el envío no
    // es un parámetro. Es la garantía estructural de que un cupón nunca regala la paquetería.
    expect(computeCouponDiscount({ type: "percent", value: 20 }, 1000)).toBe(200);
  });
});
