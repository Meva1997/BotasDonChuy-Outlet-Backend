import request from "supertest";

/**
 * Fase O.1 — avance manual de estado de envío (`PATCH /api/admin/orders/:id/status`).
 * Nivel 2 (integración HTTP, ver roadmap-testing.md): el flujo completo
 * ruta → requireAuth → controlador → servicio → Postgres real.
 *
 * Se mockea `email.service` (nunca mandar un correo real por Resend). NO se mockea
 * `payment.service`: el test clave de esta fase es que el correo "va en camino" sale una
 * sola vez cuando el webhook de Skydropx y el PATCH del dueño se pelean por el mismo
 * número de guía, y para eso los dos caminos tienen que ser los de verdad — el guard que
 * los serializa es un UPDATE condicional contra la BD, no algo que un mock reproduzca.
 */
const sendEmailMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createOrder, createOrderItem, createProduct, signToken } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { applyShipmentUpdateFromWebhook } from "../../src/services/payment.service";

let token: string;

beforeAll(async () => {
  await setupTestDatabase();
});
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(async () => {
  sendEmailMock.mockClear();
  const { user } = await createAdminUser();
  token = signToken(user);
});

/**
 * El correo se dispara fire-and-forget (`void`, sin await) para no dejar al panel esperando
 * a Resend — ver `updateOrderStatusByAdmin`. Para afirmar sobre ese efecto en segundo plano
 * hay que esperarlo con polling real: la recarga de la orden hace I/O contra Postgres.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Tiempo agotado esperando la condición del test.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Margen para que un segundo correo (si el guard fallara) alcance a llegar antes de afirmar. */
const EXTRA_EMAIL_WINDOW_MS = 100;

async function paidOrderWithItem() {
  const product = await createProduct({ sizes: { 25: 3 } });
  const order = await createOrder({ status: "paid", paymentStatus: "paid" });
  await createOrderItem(order.id, product, { size: 25, quantity: 1 });
  return order;
}

function patchStatus(orderId: number, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/admin/orders/${orderId}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("PATCH /api/admin/orders/:id/status — transición válida", () => {
  it("marca un pedido pagado como enviado, guarda la guía y manda el correo una sola vez", async () => {
    const order = await paidOrderWithItem();

    const res = await patchStatus(order.id, {
      status: "shipped",
      trackingNumber: "TRK-MANUAL-1",
      trackingUrl: "https://rastreo.test.mx/TRK-MANUAL-1",
      shippingCarrier: "Estafeta",
    });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("shipped");
    expect(res.body.order.trackingNumber).toBe("TRK-MANUAL-1");
    expect(res.body.order.items).toHaveLength(1);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("shipped");
    expect(reloaded!.trackingNumber).toBe("TRK-MANUAL-1");
    expect(reloaded!.trackingUrl).toBe("https://rastreo.test.mx/TRK-MANUAL-1");
    expect(reloaded!.shippingCarrier).toBe("Estafeta");

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      idempotencyKey: `order-shipped/${order.id}`,
    });
    expect(sendEmailMock.mock.calls[0][0].html).toContain("TRK-MANUAL-1");
  });

  it("shipped → delivered avanza sin reenviar el correo", async () => {
    const order = await paidOrderWithItem();
    await order.update({ status: "shipped", trackingNumber: "TRK-YA-ENVIADA" });

    const res = await patchStatus(order.id, { status: "delivered" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("delivered");
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("marcar delivered sin guía es válido (entrega en mano) y no manda correo", async () => {
    const order = await paidOrderWithItem();

    const res = await patchStatus(order.id, { status: "delivered" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("delivered");
    expect(res.body.order.trackingNumber).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("repetir el estado actual sirve para agregar la guía después, y ahí sí manda el correo", async () => {
    const order = await paidOrderWithItem();

    const first = await patchStatus(order.id, { status: "shipped" });
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).not.toHaveBeenCalled(); // sin guía todavía: nada que rastrear

    const second = await patchStatus(order.id, {
      status: "shipped",
      trackingNumber: "TRK-TARDIA",
    });
    expect(second.status).toBe(200);
    expect(second.body.order.trackingNumber).toBe("TRK-TARDIA");

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/admin/orders/:id/status — transiciones rechazadas", () => {
  it("retroceder de delivered a shipped responde 409 y no cambia el estado", async () => {
    const order = await paidOrderWithItem();
    await order.update({ status: "delivered" });

    const res = await patchStatus(order.id, { status: "shipped" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no puede retroceder/i);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("delivered");
  });

  it("un pedido cancelado no se puede marcar como enviado (409)", async () => {
    const order = await paidOrderWithItem();
    await order.update({ status: "cancelled", paymentStatus: "refunded" });

    const res = await patchStatus(order.id, { status: "shipped" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cancelado/i);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("cancelled");
  });

  it("un pedido aún no pagado no se puede marcar como enviado (409)", async () => {
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({ status: "pending" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });

    const res = await patchStatus(order.id, { status: "shipped" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no está pagado/i);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("pending");
  });

  it('"cancelled" no es un estado aceptado por esta ruta (400)', async () => {
    const order = await paidOrderWithItem();

    const res = await patchStatus(order.id, { status: "cancelled" });

    expect(res.status).toBe(400);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid"); // sigue pagada: cancelar es otra ruta (con reembolso)
  });

  it("un pedido inexistente responde 404 y un id no numérico 400", async () => {
    expect((await patchStatus(999999, { status: "shipped" })).status).toBe(404);
    const bad = await request(app)
      .patch("/api/admin/orders/abc/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "shipped" });
    expect(bad.status).toBe(400);
  });

  it("sin token responde 401", async () => {
    const order = await paidOrderWithItem();

    const res = await request(app)
      .patch(`/api/admin/orders/${order.id}/status`)
      .send({ status: "shipped" });

    expect(res.status).toBe(401);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid");
  });
});

describe("PATCH /api/admin/orders/:id/status — carrera con el webhook de Skydropx", () => {
  it("webhook y PATCH compitiendo por el mismo tracking → un solo correo", async () => {
    const order = await paidOrderWithItem();
    await order.update({ skydropxShipmentId: "shipment_race_1" });

    // Los dos caminos reclaman el mismo número de guía a la vez: el guard atómico
    // (`WHERE trackingNumber IS NULL`) deja que solo uno se lleve el correo.
    await Promise.all([
      patchStatus(order.id, { status: "shipped", trackingNumber: "TRK-RACE" }),
      applyShipmentUpdateFromWebhook({
        shipmentId: "shipment_race_1",
        status: "in_transit",
        trackingNumber: "TRK-RACE",
        trackingUrl: "https://rastreo.test.mx/TRK-RACE",
        labelUrl: "https://labels.test.mx/TRK-RACE.pdf",
      }),
    ]);

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("shipped");
    expect(reloaded!.trackingNumber).toBe("TRK-RACE");
  });
});
