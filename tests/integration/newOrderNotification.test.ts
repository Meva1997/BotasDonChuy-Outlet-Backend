/**
 * Fase N.4 — aviso de venta nueva al dueño. Nivel 3 (servicio + SDK mockeado): se llama directo a
 * `markOrderPaidFromWebhook` contra una BD de test real, porque lo que garantiza que el aviso salga
 * UNA sola vez es un `UPDATE` condicional de verdad (el guard `affected === 1` que comparte con el
 * correo de confirmación), no algo que un mock de Sequelize reprodujera con la misma fidelidad.
 *
 * Se mockean `email.service` (nunca mandar un correo real) y `skydropx.service` (nunca gastar saldo
 * creando una guía), igual que en `webhooks.test.ts`.
 */
const sendEmailMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

jest.mock("../../src/services/skydropx.service", () => ({
  ...jest.requireActual("../../src/services/skydropx.service"),
  getQuotationRate: jest.fn().mockResolvedValue(null),
  createShipment: jest.fn().mockRejectedValue(new Error("skydropx apagado en este test")),
  getShippingRates: jest.fn().mockResolvedValue({ quotationId: "q", rates: [] }),
}));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createOrder, createProduct, createOrderItem } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { markOrderPaidFromWebhook } from "../../src/services/payment.service";
import { sweepOnce } from "../../src/services/pendingOrderSweeper";
import { stripe } from "../../src/config/stripe";

const OWNER_EMAIL = "duenio@botasdonchuy.test";
const ALERT_EMAIL = "alertas@botasdonchuy.test";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  sendEmailMock.mockClear();
  process.env.OWNER_NOTIFICATION_EMAIL = OWNER_EMAIL;
  delete process.env.ALERT_EMAIL_TO;
});

afterEach(() => {
  delete process.env.OWNER_NOTIFICATION_EMAIL;
  delete process.env.ALERT_EMAIL_TO;
});

/**
 * El aviso se dispara fire-and-forget (`void`, sin await) para no bloquear el 200 del webhook, así
 * que hay que esperarlo con polling real — mismo helper y misma razón que en `webhooks.test.ts`.
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

/**
 * Los avisos de venta enviados. Se filtran por su `idempotencyKey` y no por el destinatario: con
 * `ALERT_EMAIL_TO` puesta, las alertas operativas (p. ej. la de "no se pudo generar la guía", que
 * este test provoca al tener Skydropx mockeado a error) llegan al mismo buzón y contarían de más.
 */
function saleNotifications() {
  return sendEmailMock.mock.calls
    .map((c) => c[0])
    .filter((arg) => String(arg.idempotencyKey ?? "").startsWith("new-order/"));
}

async function payableOrder(overrides: Parameters<typeof createOrder>[0] = {}) {
  const order = await createOrder({
    status: "pending",
    paymentStatus: "processing",
    paymentIntentId: `pi_${Math.random().toString(36).slice(2)}`,
    skydropxQuotationId: "quo_1",
    skydropxRateId: "rate_1",
    ...overrides,
  });
  const product = await createProduct({ name: "Bota vaquera", sizes: { 26: 5 } });
  await createOrderItem(order.id, product, { size: 26, quantity: 2 });
  return order;
}

describe("aviso de venta nueva (Fase N.4)", () => {
  it("un pedido pagado dispara exactamente un aviso al dueño", async () => {
    const order = await payableOrder();

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    await waitFor(() => saleNotifications().length >= 1);
    // Margen de sobra para que un segundo envío (si algo se duplicara) alcance a llegar.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const avisos = saleNotifications();
    expect(avisos).toHaveLength(1);
    expect(avisos[0].subject).toContain(`Venta #${order.id}`);
    expect(avisos[0].idempotencyKey).toBe(`new-order/${order.id}`);
    // El aviso lleva lo que hace falta para empacar: tallas, cantidades y dirección.
    expect(avisos[0].html).toContain("Bota vaquera");
    expect(avisos[0].html).toContain("Talla 26");
    expect(avisos[0].html).toContain("Calle Falsa 123");
  });

  it("el webhook y el sweeper concurrentes mandan un solo aviso", async () => {
    // El caso real: el webhook de Stripe llega justo cuando `pendingOrderSweeper` reconcilia la
    // misma orden. Los dos entran por `markOrderPaidFromWebhook`, y lo único que los serializa es
    // el `UPDATE` condicional — sin él, el dueño recibiría dos avisos de la misma venta.
    const order = await payableOrder({
      createdAt: new Date(Date.now() - 60 * 60_000), // vencida para el barrido
    });
    jest
      .spyOn(stripe.paymentIntents, "retrieve")
      .mockResolvedValue({ id: order.paymentIntentId, status: "succeeded" } as any);

    await Promise.all([markOrderPaidFromWebhook(order.paymentIntentId!), sweepOnce()]);

    await waitFor(() => saleNotifications().length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(saleNotifications()).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it("marca GUÍA MANUAL cuando el pedido cayó a la tarifa plana de respaldo", async () => {
    // Sin `skydropxRateId`, `createShipmentForOrder` se retira sin generar guía: nadie la va a
    // crear automáticamente y el pedido se quedaría esperando una guía que nunca llega.
    const order = await payableOrder({ skydropxQuotationId: null, skydropxRateId: null });

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    await waitFor(() => saleNotifications().length >= 1);
    const aviso = saleNotifications()[0];
    expect(aviso.subject).toContain("GUÍA MANUAL");
    expect(aviso.html).toContain("Esta venta necesita guía manual");
  });

  it("avisa del dropoff cuando la paquetería no recoge a domicilio", async () => {
    const order = await payableOrder({ shippingRequiresDropoff: true });

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    await waitFor(() => saleNotifications().length >= 1);
    expect(saleNotifications()[0].html).toContain("La paquetería no recoge a domicilio");
  });

  it("nunca expone el costo unitario, aunque sea un correo al dueño", async () => {
    // Un correo no está autenticado: se reenvía y vive en una bandeja. Barrido sobre el HTML
    // completo, no solo sobre los campos esperados (mismo criterio que orderLookup.test.ts).
    const order = await payableOrder();

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    await waitFor(() => saleNotifications().length >= 1);
    const html: string = saleNotifications()[0].html;
    expect(html.toLowerCase()).not.toContain("unitcost");
    // El producto de la factory cuesta 400 (unitCost); su precio de venta es otro número.
    expect(html).not.toContain("$400.00");
  });

  it("cae a ALERT_EMAIL_TO cuando no hay OWNER_NOTIFICATION_EMAIL", async () => {
    delete process.env.OWNER_NOTIFICATION_EMAIL;
    process.env.ALERT_EMAIL_TO = ALERT_EMAIL;
    const order = await payableOrder();

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    await waitFor(() => saleNotifications().length >= 1);
    expect(saleNotifications()).toHaveLength(1);
    expect(saleNotifications()[0].to).toBe(ALERT_EMAIL);
  });

  it("sin ninguna de las dos env, no manda aviso y el pago se procesa igual", async () => {
    delete process.env.OWNER_NOTIFICATION_EMAIL;
    delete process.env.ALERT_EMAIL_TO;
    const order = await payableOrder();

    await markOrderPaidFromWebhook(order.paymentIntentId!);

    // El correo de confirmación al cliente sí sale; el del dueño no.
    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(saleNotifications()).toHaveLength(0);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.status).toBe("paid");
    expect(reloaded!.paymentStatus).toBe("paid");
  });
});
