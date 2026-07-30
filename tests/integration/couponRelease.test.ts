/**
 * Nivel 3 (Fase N.2) — la **liberación** del uso del cupón: llamadas directas al servicio con
 * SDK mockeado y Postgres real, igual que `cancelOrder.test.ts`.
 *
 * Es la mitad de la fase que el roadmap no pedía y sin la cual la promoción muere sola: si un
 * carrito abandonado o un pedido cancelado no devuelven el uso, un cupón de 50 canjes se agota
 * con pedidos que nunca se pagaron. Los guards que se prueban aquí son `UPDATE`s condicionales
 * de verdad, así que tienen que correr contra la BD.
 */
import { buildStripeMock } from "../setup/mocks/stripe";

const stripeMock = buildStripeMock();
jest.mock("../../src/config/stripe", () => ({
  stripe: stripeMock,
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_CURRENCY: "mxn",
  PENDING_ORDER_TTL_MINUTES: 30,
  PENDING_ORDER_SWEEP_INTERVAL_MINUTES: 10,
}));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import {
  createProduct,
  createOrder,
  createOrderItem,
  createCoupon,
  createCouponRedemption,
} from "../setup/factories";
import { Order } from "../../src/models/Order";
import { Coupon } from "../../src/models/Coupon";
import { CouponRedemption } from "../../src/models/CouponRedemption";
import { ProductSize } from "../../src/models/ProductSize";
import { releaseOrderStock, cancelOrderByAdmin } from "../../src/services/orders.service";
import { resolveCoupon } from "../../src/services/coupon.service";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  stripeMock.paymentIntents.cancel.mockReset();
  stripeMock.refunds.create.mockReset();
});

/** Pedido con cupón ya canjeado, como lo deja un checkout real. */
async function orderWithCoupon(
  overrides: {
    status?: "pending" | "paid";
    email?: string;
    paymentIntentId?: string | null;
  } = {},
) {
  const coupon = await createCoupon({ code: "VERANO25", redeemedCount: 1 });
  const order = await createOrder({
    status: overrides.status ?? "pending",
    customerEmail: overrides.email ?? "cliente@test.com",
    paymentIntentId: overrides.paymentIntentId ?? null,
    paymentStatus: overrides.status === "paid" ? "paid" : "unpaid",
    couponId: coupon.id,
    couponCode: coupon.code,
    couponDiscount: 120,
  });
  const redemption = await createCouponRedemption(coupon, order.id, {
    email: overrides.email ?? "cliente@test.com",
    discount: 120,
  });
  return { coupon, order, redemption };
}

async function countOf(couponId: number): Promise<number> {
  const fresh = await Coupon.findByPk(couponId);
  return fresh!.redeemedCount;
}

describe("releaseOrderStock — devuelve el uso del cupón", () => {
  it("libera el canje y repone el stock en la misma llamada", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order, redemption } = await orderWithCoupon();
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    await releaseOrderStock(order.id);

    // La liberación va DENTRO de la transacción que repone el stock: las dos cosas o ninguna.
    const size = await ProductSize.findOne({ where: { productId: product.id, size: 25 } });
    expect(size!.stock).toBe(3);
    await redemption.reload();
    expect(redemption.releasedAt).not.toBeNull();
    expect(await countOf(coupon.id)).toBe(0);
  });

  it("llamarla dos veces deja el contador en 0, no en −1", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order } = await orderWithCoupon();
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    await releaseOrderStock(order.id);
    await releaseOrderStock(order.id);

    expect(await countOf(coupon.id)).toBe(0);
  });

  it("dos liberaciones concurrentes decrementan una sola vez", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order } = await orderWithCoupon();
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    await Promise.all([releaseOrderStock(order.id), releaseOrderStock(order.id)]);

    expect(await countOf(coupon.id)).toBe(0);
    expect(await CouponRedemption.count({ where: { releasedAt: null } })).toBe(0);
  });

  it("un pedido PAGADO no libera nada (el guard de `pending` cubre también el cupón)", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order, redemption } = await orderWithCoupon({ status: "paid" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    await releaseOrderStock(order.id);

    await redemption.reload();
    expect(redemption.releasedAt).toBeNull();
    expect(await countOf(coupon.id)).toBe(1);
  });

  it("un pedido sin cupón no rompe la liberación de stock", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "pending" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    await releaseOrderStock(order.id);

    const size = await ProductSize.findOne({ where: { productId: product.id, size: 25 } });
    expect(size!.stock).toBe(2);
  });

  it("después de liberar, el MISMO correo puede volver a usar el cupón", async () => {
    // Es el predicado `releasedAt IS NULL` del índice parcial, de punta a punta: si el índice
    // no fuera parcial, un carrito abandonado inhabilitaría el cupón para esa persona por
    // siempre.
    const product = await createProduct({ sizes: { 25: 5 } });
    const { coupon, order } = await orderWithCoupon({ email: "juan@test.com" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    await expect(
      resolveCoupon({ code: coupon.code, netMerchandise: 800, email: "juan@test.com" }),
    ).rejects.toThrow(/cupón/i);

    await releaseOrderStock(order.id);

    const resolved = await resolveCoupon({
      code: coupon.code,
      netMerchandise: 800,
      email: "juan@test.com",
    });
    expect(resolved.discount).toBe(120);
  });
});

describe("cancelOrderByAdmin — devuelve el uso del cupón", () => {
  it("una orden pending cancelada libera el canje (vía releaseOrderStock)", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order } = await orderWithCoupon({ paymentIntentId: "pi_1" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    stripeMock.paymentIntents.cancel.mockResolvedValue({ id: "pi_1" });

    await cancelOrderByAdmin(order.id, "el cliente pidió cancelar");

    expect(await countOf(coupon.id)).toBe(0);
  });

  it("una orden PAGADA reembolsada libera el canje", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order, redemption } = await orderWithCoupon({
      status: "paid",
      paymentIntentId: "pi_2",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    stripeMock.refunds.create.mockResolvedValue({ id: "re_1" });

    await cancelOrderByAdmin(order.id);

    await redemption.reload();
    expect(redemption.releasedAt).not.toBeNull();
    expect(await countOf(coupon.id)).toBe(0);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.paymentStatus).toBe("refunded");
  });

  it("si el reembolso FALLA, el cupón NO se libera (el dinero no volvió)", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order, redemption } = await orderWithCoupon({
      status: "paid",
      paymentIntentId: "pi_3",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    stripeMock.refunds.create.mockRejectedValue(new Error("Stripe caído"));

    await expect(cancelOrderByAdmin(order.id)).rejects.toThrow(/reembolso/i);

    // Misma regla que el stock: si no se devolvió el dinero, no se devuelve nada.
    await redemption.reload();
    expect(redemption.releasedAt).toBeNull();
    expect(await countOf(coupon.id)).toBe(1);
  });

  it("dos cancelaciones concurrentes de una orden pagada decrementan una sola vez", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const { coupon, order } = await orderWithCoupon({
      status: "paid",
      paymentIntentId: "pi_4",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    stripeMock.refunds.create.mockResolvedValue({ id: "re_2" });

    const results = await Promise.allSettled([
      cancelOrderByAdmin(order.id),
      cancelOrderByAdmin(order.id),
    ]);

    // Una gana; la otra puede ganar también (el refund es idempotente por su clave) o recibir
    // el 409 de "ya está cancelado". Lo que no puede pasar es que el contador baje dos veces.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await countOf(coupon.id)).toBe(0);
  });
});
