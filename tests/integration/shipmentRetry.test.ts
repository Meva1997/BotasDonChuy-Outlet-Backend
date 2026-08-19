import request from "supertest";

/**
 * Fase O.3 — reintento de guía de Skydropx (`POST /api/admin/orders/:id/shipment/retry`) y su
 * barrido automático (`shipmentRetrySweeper`). Nivel 2/3 mezclados (ver roadmap-testing.md): el
 * endpoint se ejercita por HTTP contra Postgres real y el barrido llamando a su `sweepShipmentsOnce`
 * (el timer no corre bajo `NODE_ENV=test`).
 *
 * Se mockean `skydropx.service` (crear una guía real cuesta saldo) y `email.service` (nunca mandar
 * un correo por Resend; `alert.service` reusa `sendEmail`, así que queda cubierto también). La BD
 * NO se mockea: lo que se prueba aquí son guards que viven en `UPDATE ... WHERE` condicionales —
 * el centinela y su liberación por antigüedad — y un mock de Sequelize no los reproduciría.
 */
const sendEmailMock = jest.fn().mockResolvedValue(true);
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

import app from "../../src/app";
import { sequelize } from "../../src/config/database";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createOrder, signToken } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { applyShipmentUpdateFromWebhook } from "../../src/services/payment.service";
import {
  SkydropxRequestError,
  SkydropxShipmentUncertainError,
} from "../../src/services/skydropx.service";
import {
  sweepShipmentsOnce,
  resetShipmentRetryAttempts,
  startShipmentRetrySweeper,
  stopShipmentRetrySweeper,
} from "../../src/services/shipmentRetrySweeper";
import {
  SHIPMENT_RETRY_DELAY_MINUTES,
  SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES,
} from "../../src/config/skydropx";

let token: string;

beforeAll(async () => {
  await setupTestDatabase();
  // `sendAlertEmail` no-opea sin destino configurado, y una de las pruebas del barrido afirma
  // justo sobre esa alerta.
  process.env.ALERT_EMAIL_TO = "alertas@test.com";
});
afterEach(truncateAll);
afterAll(async () => {
  delete process.env.ALERT_EMAIL_TO;
  await closeTestDatabase();
});

beforeEach(async () => {
  sendEmailMock.mockClear();
  resetShipmentRetryAttempts();
  getQuotationRateMock.mockReset();
  createShipmentMock.mockReset();
  getShippingRatesMock.mockReset();
  // Por defecto: la cotización guardada sigue vigente (no hace falta re-cotizar) y la guía se crea.
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
    shipmentId: "shipment_creada_1",
    carrierName: "DHL",
  });
  const { user } = await createAdminUser();
  token = signToken(user);
});

/** Pedido pagado con cotización viva de Skydropx pero sin guía: el caso que esta fase resuelve. */
async function paidOrderWithoutLabel(overrides: Record<string, unknown> = {}) {
  const order = await createOrder({ status: "paid", paymentStatus: "paid" });
  await order.update({
    skydropxQuotationId: "quotation_test_1",
    skydropxRateId: "rate_test_1",
    ...overrides,
  });
  return order;
}

/**
 * Envejece `createdAt`/`updatedAt` con SQL directo: Sequelize los gestiona solo, así que un
 * `update()` normal no puede fijarlos. `createdAt` es lo que decide si el barrido considera
 * candidato a un pedido.
 *
 * Ojo: `updatedAt` **no** mide la antigüedad del centinela (eso es `shipmentClaimedAt`, una
 * columna propia justo para que cualquier otra escritura sobre el pedido no reinicie el reloj).
 */
async function ageOrder(
  orderId: number,
  minutes: number,
  field: "updatedAt" | "createdAt" | "both" = "both",
): Promise<void> {
  const moment = new Date(Date.now() - minutes * 60_000);
  const columns =
    field === "both" ? ['"updatedAt"', '"createdAt"'] : [`"${field}"`];
  await sequelize.query(
    `UPDATE orders SET ${columns.map((c) => `${c} = :moment`).join(", ")} WHERE id = :id`,
    { replacements: { moment, id: orderId } },
  );
}

/** Minutos suficientes para que un centinela cuente como huérfano. */
const STALE_MINUTES = SHIPMENT_RETRY_DELAY_MINUTES + 5;

/** Momento de reclamo lo bastante viejo para que el centinela cuente como huérfano. */
const staleClaim = () => new Date(Date.now() - STALE_MINUTES * 60_000);

/** Centinela huérfano: reclamado hace rato, con el pedido ya fuera de la ventana de gracia. */
async function orphanSentinelOrder() {
  const order = await paidOrderWithoutLabel({
    skydropxShipmentId: "creating",
    shipmentClaimedAt: staleClaim(),
  });
  await ageOrder(order.id, STALE_MINUTES);
  return order;
}

function retryShipment(orderId: number) {
  return request(app)
    .post(`/api/admin/orders/${orderId}/shipment/retry`)
    .set("Authorization", `Bearer ${token}`);
}

describe("POST /api/admin/orders/:id/shipment/retry — reintento exitoso", () => {
  it("genera la guía de un pedido pagado que se quedó sin ella", async () => {
    const order = await paidOrderWithoutLabel();

    const res = await retryShipment(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.skydropxShipmentId).toBe("shipment_creada_1");
    expect(createShipmentMock).toHaveBeenCalledTimes(1);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_creada_1");
  });

  it("declara en la guía los bultos congelados en el pedido (Fase N.6)", async () => {
    // El acomodo en cajas se decidió en el checkout y se guardó en `Order.packageCount`. La
    // guía se genera minutos después, así que si no leyera esa columna declararía un solo
    // bulto y la paquetería cobraría los otros dos aparte al recibir el envío.
    const order = await paidOrderWithoutLabel({ packageCount: 3 });

    await retryShipment(order.id);

    expect(createShipmentMock).toHaveBeenCalledWith(
      "rate_test_1",
      expect.any(Object),
      expect.any(Object),
      3,
    );
  });

  it("un pedido sin `packageCount` (previo a la fase o con tarifa plana) declara un bulto", async () => {
    const order = await paidOrderWithoutLabel({ packageCount: null });

    await retryShipment(order.id);

    expect(createShipmentMock).toHaveBeenCalledWith(
      "rate_test_1",
      expect.any(Object),
      expect.any(Object),
      1,
    );
  });

  it("libera el centinela huérfano y genera una sola guía", async () => {
    // El proceso murió entre reclamar "creating" y llamar a Skydropx: sin liberarlo, este pedido
    // no podría volver a generar guía nunca.
    const order = await orphanSentinelOrder();

    const res = await retryShipment(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.skydropxShipmentId).toBe("shipment_creada_1");
    expect(createShipmentMock).toHaveBeenCalledTimes(1);
  });

  it("no manda alerta operativa: el error (o el éxito) se responde en el momento", async () => {
    const order = await paidOrderWithoutLabel();

    await retryShipment(order.id);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/orders/:id/shipment/retry — no genera una segunda guía", () => {
  it("un pedido con guía real responde 409 sin llamar a Skydropx", async () => {
    const order = await paidOrderWithoutLabel({ skydropxShipmentId: "shipment_ya_existente" });

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("shipment_ya_existente");
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("un pedido con guía cobrada sin persistir responde 409 con el id a reconciliar", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:shipment_cobrada",
    });
    await ageOrder(order.id, STALE_MINUTES); // aunque sea vieja, NO se libera: ya se pagó

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("shipment_cobrada");
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("un centinela reciente responde 409 (creación en vuelo, no huérfana)", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "creating",
      shipmentClaimedAt: new Date(),
    });

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/se está generando/i);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("dos reintentos concurrentes → una sola llamada a Skydropx y un solo 200", async () => {
    const order = await orphanSentinelOrder();

    const [first, second] = await Promise.all([
      retryShipment(order.id),
      retryShipment(order.id),
    ]);

    expect(createShipmentMock).toHaveBeenCalledTimes(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_creada_1");
  });
});

describe("POST /api/admin/orders/:id/shipment/retry — pedidos que no aplican", () => {
  it("un pedido con tarifa plana de respaldo responde 409 (no hay rate que convertir)", async () => {
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/tarifa plana/i);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("un pedido aún no pagado responde 409", async () => {
    const order = await createOrder({ status: "pending" });
    await order.update({
      skydropxQuotationId: "quotation_test_1",
      skydropxRateId: "rate_test_1",
    });

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no está pagado/i);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("un pedido cancelado responde 409", async () => {
    const order = await paidOrderWithoutLabel();
    await order.update({ status: "cancelled", paymentStatus: "refunded" });

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cancelado/i);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("un pedido inexistente responde 404, un id no numérico 400 y sin token 401", async () => {
    expect((await retryShipment(999999)).status).toBe(404);

    const badId = await request(app)
      .post("/api/admin/orders/abc/shipment/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(badId.status).toBe(400);

    const order = await paidOrderWithoutLabel();
    const noToken = await request(app).post(
      `/api/admin/orders/${order.id}/shipment/retry`,
    );
    expect(noToken.status).toBe(401);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/orders/:id/shipment/retry — cuando Skydropx vuelve a fallar", () => {
  it("responde 502 y deja el pedido reintentable (centinela liberado a null)", async () => {
    const order = await paidOrderWithoutLabel();
    createShipmentMock.mockRejectedValue(new Error("Skydropx caído (simulado)"));

    const res = await retryShipment(order.id);

    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/no se pudo generar la guía/i);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBeNull(); // se puede volver a intentar de inmediato
  });
});

describe("POST /api/admin/orders/:id/shipment/retry — Skydropx no respondió al crear la guía", () => {
  /**
   * El fallo más caro y el que menos se ve: el `POST /shipments` se va y muere por timeout o
   * conexión cortada. Skydropx pudo haberla creado **y cobrado** sin que nosotros viéramos su id,
   * así que liberar el centinela aquí convertiría el reintento de esta fase en una segunda guía
   * pagada. `createShipment` lo distingue de un 4xx (rechazo explícito, nada creado) lanzando
   * `SkydropxShipmentUncertainError`.
   */
  function timeoutOnCreate() {
    createShipmentMock.mockRejectedValue(
      new SkydropxShipmentUncertainError(
        "No se pudo confirmar si Skydropx creó la guía",
        new Error("The operation was aborted due to timeout"),
      ),
    );
  }

  it("NO libera el centinela: deja el pedido marcado como no conciliado", async () => {
    const order = await paidOrderWithoutLabel();
    timeoutOnCreate();

    const res = await retryShipment(order.id);

    expect(res.status).toBe(502);
    const reloaded = await Order.findByPk(order.id);
    // Lo importante: NO quedó en `null` (que sería "reintentable" y pagaría una segunda guía).
    expect(reloaded!.skydropxShipmentId).toBe("unreconciled:desconocido");
  });

  it("alerta de inmediato aunque el reintento apague las alertas por intento", async () => {
    const order = await paidOrderWithoutLabel();
    timeoutOnCreate();

    await retryShipment(order.id);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/no se pudo confirmar/i);
  });

  it("un reintento posterior responde 409 y no vuelve a llamar a Skydropx", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:desconocido",
    });
    await ageOrder(order.id, STALE_MINUTES);

    const res = await retryShipment(order.id);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no respondió/i);
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("con force: true (el dueño ya verificó que no existe) genera una sola guía", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:desconocido",
    });

    const res = await retryShipment(order.id).send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body.order.skydropxShipmentId).toBe("shipment_creada_1");
    expect(createShipmentMock).toHaveBeenCalledTimes(1);
  });

  it("force NO desbloquea una guía de id conocido: esa sí existe y está cobrada", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:shipment_cobrada",
    });

    const res = await retryShipment(order.id).send({ force: true });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("shipment_cobrada");
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("el barrido tampoco toca un pedido sin conciliar", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:desconocido",
    });
    await ageOrder(order.id, STALE_MINUTES);

    await sweepShipmentsOnce();

    expect(createShipmentMock).not.toHaveBeenCalled();
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("unreconciled:desconocido");
  });

  it("un 4xx de Skydropx sí libera el centinela: ahí no se creó ni se cobró nada", async () => {
    const order = await paidOrderWithoutLabel();
    createShipmentMock.mockRejectedValue(
      new SkydropxRequestError("Saldo insuficiente", 422, "/api/v1/shipments"),
    );

    const res = await retryShipment(order.id);

    expect(res.status).toBe(502);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBeNull(); // reintentable de inmediato
  });
});

describe("POST /api/admin/orders/:id/shipment/retry — pedido ya enviado a mano", () => {
  /**
   * El camino documentado cuando la guía automática falla: el dueño la genera en el panel de
   * Skydropx y captura su número con `PATCH /status` (Fase O.1). Eso deja el pedido `shipped` con
   * `skydropxShipmentId` en `null`, así que sin este guard el botón de reintentar cobraría una
   * segunda guía por un pedido que ya salió.
   */
  it.each(["shipped", "delivered"] as const)(
    "un pedido %s responde 409 sin llamar a Skydropx",
    async (status) => {
      const order = await paidOrderWithoutLabel();
      await order.update({ status, trackingNumber: "TRK-MANUAL" });

      const res = await retryShipment(order.id);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/cada guía se cobra/i);
      expect(createShipmentMock).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/admin/orders — datos de la guía para imprimirla", () => {
  it("incluye labelUrl, trackingNumber y skydropxShipmentId del pedido", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "shipment_impresa",
      trackingNumber: "TRK-1",
      labelUrl: "https://labels.test.mx/shipment_impresa.pdf",
    });

    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const found = res.body.orders.find((o: { id: number }) => o.id === order.id);
    expect(found).toMatchObject({
      skydropxShipmentId: "shipment_impresa",
      trackingNumber: "TRK-1",
      labelUrl: "https://labels.test.mx/shipment_impresa.pdf",
    });
  });
});

describe("applyShipmentUpdateFromWebhook — reconciliación de una guía cobrada sin persistir", () => {
  it("el webhook de esa guía sana la fila y deja el id real", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:shipment_cobrada",
    });

    const result = await applyShipmentUpdateFromWebhook({
      shipmentId: "shipment_cobrada",
      status: "in_transit",
      trackingNumber: "TRK-RECONCILIADA",
      trackingUrl: "https://rastreo.test.mx/TRK-RECONCILIADA",
      labelUrl: "https://labels.test.mx/shipment_cobrada.pdf",
    });

    expect(result).toBe("applied");
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_cobrada");
    expect(reloaded!.trackingNumber).toBe("TRK-RECONCILIADA");
    expect(reloaded!.status).toBe("shipped");
  });

  /**
   * El 503 ("reintenta, la guía se está creando ahora") solo tiene sentido mientras haya una
   * creación **en vuelo**. Un centinela rancio no lo es —por eso el barrido lo libera— y contarlo
   * hacía que los eventos de guías ajenas (las que el dueño genera a mano en el panel de Skydropx,
   * que es justo lo que los mensajes de esta fase le piden hacer) se respondieran 503 en bucle
   * mientras esa fila existiera.
   */
  it("un evento ajeno se descarta con 200 aunque haya un centinela rancio", async () => {
    await paidOrderWithoutLabel({
      skydropxShipmentId: "creating",
      shipmentClaimedAt: staleClaim(),
    });

    const result = await applyShipmentUpdateFromWebhook({
      shipmentId: "shipment_de_otra_cuenta",
      status: "in_transit",
      trackingNumber: "TRK-AJENA",
      trackingUrl: null,
      labelUrl: null,
    });

    expect(result).toBe("unknown");
  });

  it("pero un centinela recién reclamado sí pide reintento (la guía va en camino)", async () => {
    await paidOrderWithoutLabel({
      skydropxShipmentId: "creating",
      shipmentClaimedAt: new Date(),
    });

    const result = await applyShipmentUpdateFromWebhook({
      shipmentId: "shipment_todavia_sin_persistir",
      status: "in_transit",
      trackingNumber: "TRK-EN-VUELO",
      trackingUrl: null,
      labelUrl: null,
    });

    expect(result).toBe("retry-later");
  });
});

describe("shipmentRetrySweeper — recuperación automática", () => {
  it("genera la guía de un pedido pagado que lleva rato sin ella", async () => {
    const order = await paidOrderWithoutLabel();
    await ageOrder(order.id, STALE_MINUTES);

    await sweepShipmentsOnce();

    expect(createShipmentMock).toHaveBeenCalledTimes(1);
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_creada_1");
  });

  it("libera el centinela huérfano de un pedido y le genera la guía", async () => {
    const order = await orphanSentinelOrder();

    await sweepShipmentsOnce();

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("shipment_creada_1");
  });

  it("no toca un pedido recién pagado (el intento automático puede seguir en curso)", async () => {
    await paidOrderWithoutLabel();

    await sweepShipmentsOnce();

    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("no toca un pedido con guía cobrada sin persistir (pagaría una segunda)", async () => {
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "unreconciled:shipment_cobrada",
    });
    await ageOrder(order.id, STALE_MINUTES);

    await sweepShipmentsOnce();

    expect(createShipmentMock).not.toHaveBeenCalled();
    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("unreconciled:shipment_cobrada");
  });

  it("no toca un pedido con tarifa plana ni uno sin pagar", async () => {
    const flatRate = await createOrder({ status: "paid", paymentStatus: "paid" });
    const unpaid = await createOrder({ status: "pending" });
    await unpaid.update({
      skydropxQuotationId: "quotation_test_1",
      skydropxRateId: "rate_test_1",
    });
    await ageOrder(flatRate.id, STALE_MINUTES);
    await ageOrder(unpaid.id, STALE_MINUTES);

    await sweepShipmentsOnce();

    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it("no toca un pedido con rate pero sin cotización (nunca podría generar guía)", async () => {
    // `createShipmentForOrder` exige las dos, así que este pedido se saldría en su primera línea:
    // sin filtrarlo en el `WHERE` gastaría los 3 intentos y dispararía la alerta de "no se pudo
    // generar la guía" sin haber hecho una sola llamada a Skydropx.
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await order.update({ skydropxRateId: "rate_test_1" });
    await ageOrder(order.id, STALE_MINUTES);

    await sweepShipmentsOnce();
    await sweepShipmentsOnce();
    await sweepShipmentsOnce();
    await sweepShipmentsOnce();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createShipmentMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("no gasta un intento cuando otra llamada tiene el centinela", async () => {
    // Caso real: el cliente paga tarde (3DS) y el webhook está creando la guía justo cuando corre
    // el barrido. Contarlo como fallo acercaba la alerta de un pedido que iba perfectamente.
    const order = await paidOrderWithoutLabel({
      skydropxShipmentId: "creating",
      shipmentClaimedAt: new Date(),
    });
    await ageOrder(order.id, STALE_MINUTES, "createdAt");

    await sweepShipmentsOnce();

    expect(createShipmentMock).not.toHaveBeenCalled();

    // Y cuando el centinela sí queda huérfano, el pedido conserva sus 3 intentos completos.
    await order.update({ shipmentClaimedAt: staleClaim() });
    createShipmentMock.mockRejectedValue(new Error("Skydropx caído (simulado)"));
    for (let i = 0; i < 3; i++) {
      await sweepShipmentsOnce();
      await ageOrder(order.id, STALE_MINUTES, "createdAt");
    }
    expect(createShipmentMock).toHaveBeenCalledTimes(3);
  });

  it("conserva el contador de un pedido que se cae de un ciclo y vuelve", async () => {
    // El contador se caducaba por "no apareció en el resultado de este ciclo", pero ese resultado
    // viene recortado por el `LIMIT`: un pedido que rota fuera de la página volvía a cero y podía
    // gastar otros 3 intentos y mandar una segunda alerta idéntica.
    const order = await paidOrderWithoutLabel();
    await ageOrder(order.id, STALE_MINUTES);
    createShipmentMock.mockRejectedValue(new Error("Skydropx caído (simulado)"));

    await sweepShipmentsOnce(); // intento 1
    await ageOrder(order.id, STALE_MINUTES);

    // Sale de la candidatura por un ciclo (equivale a caerse de la página del LIMIT) y vuelve.
    await order.update({ skydropxShipmentId: "shipment_temporal" });
    await sweepShipmentsOnce();
    await order.update({ skydropxShipmentId: null });
    await ageOrder(order.id, STALE_MINUTES);

    await sweepShipmentsOnce(); // intento 2
    await ageOrder(order.id, STALE_MINUTES);
    await sweepShipmentsOnce(); // intento 3 → alerta
    await ageOrder(order.id, STALE_MINUTES);
    await sweepShipmentsOnce(); // ya agotado: no debe llamar

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createShipmentMock).toHaveBeenCalledTimes(3);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("tras agotar los reintentos alerta una sola vez y deja de intentar", async () => {
    const order = await paidOrderWithoutLabel();
    await ageOrder(order.id, STALE_MINUTES);
    createShipmentMock.mockRejectedValue(new Error("Skydropx caído (simulado)"));

    // 3 ciclos = los 3 intentos permitidos; el cuarto ya no debe llamar a Skydropx (el pedido
    // queda excluido de la propia consulta de candidatos, no solo saltado en el bucle).
    // Se reenvejece `createdAt` en cada vuelta porque el fallo libera el centinela a `null` y la
    // candidatura pasa a depender solo de la antigüedad del pedido.
    for (let i = 0; i < 4; i++) {
      await sweepShipmentsOnce();
      await ageOrder(order.id, STALE_MINUTES);
    }

    // La alerta sale fire-and-forget (`void sendAlertEmail`), así que hay que darle su turno.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createShipmentMock).toHaveBeenCalledTimes(3);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/no se pudo generar la guía/i);
  });

  it("deja de intentar un pedido cuya guía pudo haberse cobrado, sin gastar sus intentos", async () => {
    // Skydropx no respondió a media creación: pudo haber creado Y cobrado la guía. El barrido
    // no puede reintentar a ciegas (pagaría una segunda), así que solo lo registra y lo suelta
    // — la fila queda marcada y sale de la candidatura de los ciclos siguientes.
    const order = await paidOrderWithoutLabel();
    await ageOrder(order.id, STALE_MINUTES);
    createShipmentMock.mockRejectedValue(
      new SkydropxShipmentUncertainError("timeout sin respuesta", new Error("AbortError")),
    );

    await sweepShipmentsOnce();

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.skydropxShipmentId).toBe("unreconciled:desconocido");

    // Ciclos posteriores no vuelven a llamar a Skydropx aunque el pedido siga sin guía real.
    await ageOrder(order.id, STALE_MINUTES);
    await sweepShipmentsOnce();
    await ageOrder(order.id, STALE_MINUTES);
    await sweepShipmentsOnce();
    expect(createShipmentMock).toHaveBeenCalledTimes(1);

    // La alerta salió de `createShipmentForOrder` (incondicional y `fatal` para este caso), no
    // de la ruta de "agotó sus 3 intentos": el pedido nunca gastó intentos.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).not.toMatch(/reintentos/i);
  });

  it("un error de BD con un pedido no frena el barrido de los demás", async () => {
    // `retryShipmentFromSweeper` no lanza por un fallo de Skydropx (lo traga
    // `createShipmentForOrder`), pero sí puede lanzar por la BD. Si eso tumbara el ciclo, un
    // solo pedido problemático dejaría sin guía a todos los que vinieran detrás.
    const primero = await paidOrderWithoutLabel();
    await ageOrder(primero.id, STALE_MINUTES + 10); // más viejo: se procesa primero
    const segundo = await paidOrderWithoutLabel();
    await ageOrder(segundo.id, STALE_MINUTES);

    const findByPkSpy = jest
      .spyOn(Order, "findByPk")
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    await expect(sweepShipmentsOnce()).resolves.toBeUndefined();

    findByPkSpy.mockRestore();
    const reloadedSegundo = await Order.findByPk(segundo.id);
    expect(reloadedSegundo!.skydropxShipmentId).toBe("shipment_creada_1");
  });
});

describe("startShipmentRetrySweeper / stopShipmentRetrySweeper", () => {
  /**
   * El cron se salta bajo `NODE_ENV=test` a propósito (una suite no debe arrancar timers), así
   * que para ejercitar el arranque real hay que fingir otro entorno. Se restaura siempre.
   */
  async function withProductionEnv(fn: () => Promise<void> | void): Promise<void> {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await fn();
    } finally {
      process.env.NODE_ENV = original;
      stopShipmentRetrySweeper();
    }
  }

  it("no arranca ningún timer bajo NODE_ENV=test", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");

    startShipmentRetrySweeper();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("arranca un timer con el intervalo configurado", async () => {
    await withProductionEnv(() => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");

      startShipmentRetrySweeper();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0][1]).toBe(
        SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES * 60_000,
      );
      setIntervalSpy.mockRestore();
    });
  });

  it("es idempotente: dos arranques no dejan dos barridos concurrentes", async () => {
    await withProductionEnv(() => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");

      startShipmentRetrySweeper();
      startShipmentRetrySweeper();

      // Dos timers duplicarían las llamadas a Skydropx, cuyo límite de 2 req/s es de la cuenta
      // entera y se comparte con los checkouts en vivo.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });
  });

  it("stop detiene el timer y permite volver a arrancarlo", async () => {
    await withProductionEnv(() => {
      const clearIntervalSpy = jest.spyOn(global, "clearInterval");

      startShipmentRetrySweeper();
      stopShipmentRetrySweeper();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      const setIntervalSpy = jest.spyOn(global, "setInterval");
      startShipmentRetrySweeper();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });
  });

  it("stop es idempotente: el apagado ordenado puede llamarlo sin que haya arrancado", () => {
    expect(() => {
      stopShipmentRetrySweeper();
      stopShipmentRetrySweeper();
    }).not.toThrow();
  });
});
