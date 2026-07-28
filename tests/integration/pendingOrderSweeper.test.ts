/**
 * Barrido de órdenes `pending` vencidas (`pendingOrderSweeper.ts`).
 *
 * Nivel 3 (servicio + SDK mockeado, ver roadmap-testing.md): se llama a `sweepOnce`
 * directo contra una BD de test real con Stripe mockeado — lo que se prueba es la
 * decisión de reponer o no el stock, y eso son UPDATEs de verdad sobre `product_sizes`.
 *
 * `startPendingOrderSweeper` no arranca en `NODE_ENV=test` (timer desactivado a
 * propósito), así que la suite ejecuta un ciclo suelto.
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

const sendEmailMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct, createOrder, createOrderItem } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { ProductSize } from "../../src/models/ProductSize";
import { sweepOnce } from "../../src/services/pendingOrderSweeper";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.paymentIntents.cancel.mockReset().mockResolvedValue({});
  sendEmailMock.mockClear();
});

/** Envejece la orden más allá del TTL para que el barrido la alcance. */
async function ageOrder(order: Order, minutes = 60): Promise<void> {
  await Order.update(
    { createdAt: new Date(Date.now() - minutes * 60_000) } as any,
    { where: { id: order.id }, silent: true },
  );
}

/**
 * Una orden `pending` con stock reservado, tal como la deja `createOrder`: la fila
 * `product_sizes` ya viene descontada (5 − 2 = 3).
 */
async function createStaleOrder(paymentIntentId: string | null) {
  const product = await createProduct({ sizes: { 25: 3 } });
  const order = await createOrder({ paymentIntentId });
  await createOrderItem(order.id, product, { size: 25, quantity: 2 });
  await ageOrder(order);
  return { product, order };
}

async function stockOf(productId: number, size: number): Promise<number> {
  const row = await ProductSize.findOne({ where: { productId, size } });
  return row!.stock;
}

describe("sweepOnce", () => {
  it("repone el stock de una orden pending que nunca llegó a tener PaymentIntent", async () => {
    // El caso que este barrido no alcanzaba antes: Stripe falló después de que la orden
    // ya estaba escrita y con su stock descontado, así que no hay PaymentIntent que
    // conciliar ni webhook que vaya a llegar — sin esto el stock quedaba reservado para
    // siempre.
    const { product, order } = await createStaleOrder(null);

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("cancela el PaymentIntent y repone el stock de una orden vencida sin pagar", async () => {
    const { product, order } = await createStaleOrder("pi_abandonada");
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_abandonada",
      status: "requires_payment_method",
    });

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_abandonada");
  });

  it("NO repone el stock si el PaymentIntent sí está pagado: la marca paid", async () => {
    const { product, order } = await createStaleOrder("pi_pagada");
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_pagada",
      status: "succeeded",
    });

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("paid");
    expect(await stockOf(product.id, 25)).toBe(3); // sigue reservado, se vendió
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("no toca una orden pending que todavía está dentro del TTL", async () => {
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({ paymentIntentId: null });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    // Sin envejecer: el comprador podría estar pagando en este momento.

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("pending");
    expect(await stockOf(product.id, 25)).toBe(3);
  });
});
