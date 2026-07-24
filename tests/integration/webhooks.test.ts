/**
 * Parte 4 del roadmap — idempotencia de los webhooks (pago, guía, estado de envío).
 * Nivel 3 (servicio + SDK mockeado, ver roadmap-testing.md): se llama directo a
 * `payment.service.ts` con `Promise.all` contra una BD de test real — los guards que
 * se prueban aquí son UPDATEs condicionales de verdad, no algo que un mock de Sequelize
 * pudiera reproducir con la misma fidelidad.
 *
 * Se mockean `email.service` (nunca mandar un correo real) y `skydropx.service` (nunca
 * llamar a la API real ni gastar saldo creando una guía) — igual que Stripe en la Parte 3,
 * estos dos cuestan dinero/mandan correos reales. `alert.service.ts` reusa `sendEmail`
 * internamente, así que mockear `email.service` también cubre las alertas sin un mock aparte.
 */
const sendEmailMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

const getQuotationRateMock = jest.fn();
const createShipmentMock = jest.fn();
const getShippingRatesMock = jest.fn();
jest.mock("../../src/services/skydropx.service", () => ({
  ...jest.requireActual("../../src/services/skydropx.service"),
  getQuotationRate: getQuotationRateMock,
  createShipment: createShipmentMock,
  getShippingRates: getShippingRatesMock,
}));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createOrder } from "../setup/factories";
import { Order } from "../../src/models/Order";
import {
  markOrderPaidFromWebhook,
  createShipmentForOrder,
  applyShipmentUpdateFromWebhook,
} from "../../src/services/payment.service";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  sendEmailMock.mockClear();
  getQuotationRateMock.mockReset();
  createShipmentMock.mockReset();
  getShippingRatesMock.mockReset();
});

/**
 * `markOrderPaidFromWebhook`/`createShipmentForOrder`/`applyShipmentUpdateFromWebhook`
 * disparan su correo y su guía fire-and-forget (`void`, sin await) para no bloquear el
 * 200 del webhook — ver payment.service.ts. Para afirmar sobre ese efecto en segundo
 * plano hay que esperarlo con polling real (no fake timers: la recarga de la orden y el
 * guard hacen I/O real contra Postgres).
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

describe("markOrderPaidFromWebhook — idempotencia", () => {
  it("dos llamadas concurrentes → un solo affected===1 y un solo correo", async () => {
    const order = await createOrder({
      status: "pending",
      paymentStatus: "processing",
      paymentIntentId: "pi_test_concurrent",
    });

    await Promise.all([
      markOrderPaidFromWebhook("pi_test_concurrent"),
      markOrderPaidFromWebhook("pi_test_concurrent"),
    ]);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid");
    expect(reloaded!.paymentStatus).toBe("paid");

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    // Un margen de sobra para que un segundo envío (si el guard fallara) alcance a llegar.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("una orden ya cancelada no se resucita a paid con un evento tardío", async () => {
    const order = await createOrder({
      status: "cancelled",
      paymentStatus: "failed",
      paymentIntentId: "pi_test_cancelled",
    });

    await markOrderPaidFromWebhook("pi_test_cancelled");

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("cancelled");
    expect(reloaded!.paymentStatus).toBe("failed");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("createShipmentForOrder — guard centinela", () => {
  it("dos llamadas concurrentes → una sola llama a Skydropx para crear la guía", async () => {
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await order.update({
      skydropxQuotationId: "quotation_test_1",
      skydropxRateId: "rate_test_1",
    });

    getQuotationRateMock.mockResolvedValue({
      rateId: "rate_test_1",
      carrier: "dhl",
      service: "Estándar",
      amount: 150,
      total: 150,
      days: 3,
      requiresDropoff: false,
    });
    createShipmentMock.mockResolvedValue({
      shipmentId: "shipment_test_1",
      carrierName: "DHL",
    });

    await Promise.all([createShipmentForOrder(order), createShipmentForOrder(order)]);

    expect(createShipmentMock).toHaveBeenCalledTimes(1);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_test_1");
  });

  it("si la creación falla, el centinela se libera a null (permite reintento)", async () => {
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await order.update({
      skydropxQuotationId: "quotation_test_2",
      skydropxRateId: "rate_test_2",
    });

    getQuotationRateMock.mockResolvedValue({
      rateId: "rate_test_2",
      carrier: "dhl",
      service: "Estándar",
      amount: 150,
      total: 150,
      days: 3,
      requiresDropoff: false,
    });
    createShipmentMock.mockRejectedValue(new Error("Skydropx caído (simulado)"));

    await createShipmentForOrder(order);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBeNull();
  });
});

describe("applyShipmentUpdateFromWebhook — avance solo hacia adelante", () => {
  it("un evento fuera de orden no retrocede el status (delivered no vuelve a shipped)", async () => {
    const order = await createOrder({ status: "delivered" });
    await order.update({
      skydropxShipmentId: "shipment_test_delivered",
      trackingNumber: "TRACK123",
    });

    const result = await applyShipmentUpdateFromWebhook({
      shipmentId: "shipment_test_delivered",
      status: "in_transit",
      trackingNumber: "TRACK123",
      trackingUrl: null,
      labelUrl: null,
    });

    expect(result).toBe("applied");
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("delivered");
  });

  it("una orden cancelled no se reactiva por un evento de rastreo", async () => {
    const order = await createOrder({ status: "cancelled" });
    await order.update({ skydropxShipmentId: "shipment_test_cancelled" });

    const result = await applyShipmentUpdateFromWebhook({
      shipmentId: "shipment_test_cancelled",
      status: "in_transit",
      trackingNumber: "TRACK456",
      trackingUrl: null,
      labelUrl: null,
    });

    expect(result).toBe("applied");
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("cancelled");
  });

  it("la primera vez que llega un trackingNumber dispara el correo 'pedido enviado' una sola vez", async () => {
    const order = await createOrder({ status: "paid" });
    await order.update({ skydropxShipmentId: "shipment_test_tracking" });

    await Promise.all([
      applyShipmentUpdateFromWebhook({
        shipmentId: "shipment_test_tracking",
        status: "picked_up",
        trackingNumber: "TRACK789",
        trackingUrl: "https://track.test/789",
        labelUrl: null,
      }),
      applyShipmentUpdateFromWebhook({
        shipmentId: "shipment_test_tracking",
        status: "picked_up",
        trackingNumber: "TRACK789",
        trackingUrl: "https://track.test/789",
        labelUrl: null,
      }),
    ]);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("shipped");
    expect(reloaded!.trackingNumber).toBe("TRACK789");

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
