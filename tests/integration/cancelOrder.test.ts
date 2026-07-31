/**
 * Parte 5 del roadmap (opcional/stretch) — release de stock y cancelación/reembolso manual
 * desde el panel admin. Nivel 3 (servicio + SDK mockeado, ver roadmap-testing.md): se llama
 * directo a `orders.service.ts` (no vía HTTP) con `Promise.all` contra una BD de test real —
 * igual que la Parte 4, los guards que se prueban aquí (`FOR UPDATE` + recheck de `status`) son
 * UPDATEs condicionales de verdad.
 *
 * Se mockea `config/stripe` completo (nunca llamar a Stripe de verdad para un refund/cancel).
 * `sendAlertEmail` (vía `email.service`) no hace falta mockearlo: sin `ALERT_EMAIL_TO` en
 * `.env.test` ya es un no-op que solo loguea, igual que en la Parte 4.
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
import { createProduct, createOrder, createOrderItem } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { ProductSize } from "../../src/models/ProductSize";
import { AppError } from "../../src/middlewares/AppError";
import { releaseOrderStock, cancelOrderByAdmin } from "../../src/services/orders.service";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  stripeMock.paymentIntents.cancel.mockReset();
  stripeMock.refunds.create.mockReset();
});

async function stockOf(productId: number, size: number): Promise<number> {
  const row = await ProductSize.findOne({ where: { productId, size } });
  return row!.stock;
}

describe("releaseOrderStock — idempotencia", () => {
  it("repone el stock de una orden pending y la deja cancelled/failed", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "pending" });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    await releaseOrderStock(order.id);

    expect(await stockOf(product.id, 25)).toBe(3);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("cancelled");
    expect(reloaded!.paymentStatus).toBe("failed");
  });

  it("llamarla dos veces no repone el stock por partida doble", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "pending" });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    await releaseOrderStock(order.id);
    await releaseOrderStock(order.id);

    expect(await stockOf(product.id, 25)).toBe(3);
  });

  it("nunca repone una orden ya pagada", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    await releaseOrderStock(order.id);

    expect(await stockOf(product.id, 25)).toBe(1);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid");
    expect(reloaded!.paymentStatus).toBe("paid");
  });
});

describe("cancelOrderByAdmin — pending", () => {
  it("repone el stock, cancela y best-effort cancela el PaymentIntent en Stripe", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({
      status: "pending",
      paymentIntentId: "pi_test_pending",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    stripeMock.paymentIntents.cancel.mockResolvedValue({});

    const result = await cancelOrderByAdmin(order.id, "cliente pidió cancelar por WhatsApp");

    expect(result.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(3);
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_test_pending");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("un fallo al cancelar el PaymentIntent no bloquea la cancelación (best-effort)", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({
      status: "pending",
      paymentIntentId: "pi_test_pending_fail",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    stripeMock.paymentIntents.cancel.mockRejectedValue(new Error("ya estaba cancelado"));

    const result = await cancelOrderByAdmin(order.id);

    expect(result.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(3);
  });
});

describe("cancelOrderByAdmin — paid", () => {
  it("reembolsa en Stripe antes de restockear y guarda refundId/refundedAt", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      paymentIntentId: "pi_test_paid",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    stripeMock.refunds.create.mockResolvedValue({ id: "re_test_1" });

    const result = await cancelOrderByAdmin(order.id, "cliente ya no lo quiere");

    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_test_paid" },
      { idempotencyKey: `refund-order-${order.id}` },
    );
    expect(result.status).toBe("cancelled");
    expect(result.paymentStatus).toBe("refunded");
    expect(result.refundId).toBe("re_test_1");
    expect(result.refundedAt).not.toBeNull();
    expect(await stockOf(product.id, 25)).toBe(3);
  });

  it("un reembolso fallido no restockea y lanza 502 (el dinero no volvió)", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      paymentIntentId: "pi_test_paid_fail",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    stripeMock.refunds.create.mockRejectedValue(new Error("Stripe caído (simulado)"));

    let caught: unknown;
    try {
      await cancelOrderByAdmin(order.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(502);

    expect(await stockOf(product.id, 25)).toBe(1);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid");
    expect(reloaded!.paymentStatus).toBe("paid");
  });

  it("dos cancelaciones concurrentes solo restockean una vez (guard FOR UPDATE)", async () => {
    const product = await createProduct({ sizes: { 25: 0 } });
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      paymentIntentId: "pi_test_concurrent",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    // Barrera de sincronización: `refunds.create` no resuelve hasta que AMBAS
    // cancelaciones lo hayan llamado. Esa llamada ocurre DESPUÉS del pre-chequeo de
    // estado y ANTES de la transacción que cierra la orden, así que la barrera fuerza
    // justo el interleaving que este test quiere probar: las dos leyeron `paid` y las
    // dos llegan al guard `FOR UPDATE`, donde solo una debe restockear.
    // Sin ella el test era intermitente: si la primera alcanzaba a commitear antes de
    // que la segunda leyera, la segunda veía `cancelled` y lanzaba 409 (comportamiento
    // correcto, pero otro camino) y el `Promise.all` se rechazaba.
    // Misma idempotencyKey en la vida real => Stripe devolvería el MISMO refund a
    // ambas llamadas; se simula devolviendo el mismo id en las dos.
    let arrived = 0;
    let openBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    stripeMock.refunds.create.mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) openBarrier();
      await barrier;
      return { id: "re_test_concurrent" };
    });

    await Promise.all([
      cancelOrderByAdmin(order.id),
      cancelOrderByAdmin(order.id),
    ]);

    // Las dos llegaron a reembolsar (misma idempotencyKey => un solo reembolso real).
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(2);

    expect(await stockOf(product.id, 25)).toBe(2);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("cancelled");
    expect(reloaded!.paymentStatus).toBe("refunded");
  });
});

describe("cancelOrderByAdmin — estados no cancelables", () => {
  it.each(["shipped", "delivered", "cancelled"] as const)(
    "una orden %s devuelve 409 y no toca stock ni Stripe",
    async (status) => {
      const product = await createProduct({ sizes: { 25: 1 } });
      const order = await createOrder({ status, paymentIntentId: "pi_test_closed" });
      await createOrderItem(order.id, product, { size: 25, quantity: 2 });

      await expect(cancelOrderByAdmin(order.id)).rejects.toMatchObject({ statusCode: 409 });

      expect(await stockOf(product.id, 25)).toBe(1);
      expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
      expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    },
  );
});
