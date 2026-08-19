import request from "supertest";
import crypto from "crypto";

/**
 * `POST /api/webhooks/stripe` y `POST /api/webhooks/skydropx` **por HTTP** — Nivel 2/3 mezclados.
 *
 * La lógica de negocio de los dos webhooks ya está cubierta a nivel de servicio
 * (`webhooks.test.ts` llama a `markOrderPaidFromWebhook` y a `applyShipmentUpdateFromWebhook`
 * directo). Lo que **solo** existe en la capa HTTP —y por lo tanto solo se puede probar aquí— es
 * el contrato con el proveedor, que es donde se pierde el dinero de verdad:
 *
 *  - las rutas se montan con `express.raw` **antes** del `express.json()` global, porque las dos
 *    firmas se calculan sobre el cuerpo CRUDO; si alguien reordenara ese `app.use`, la
 *    verificación fallaría siempre y **ningún pedido volvería a marcarse pagado**;
 *  - una firma ausente/inválida debe dar **400** (el proveedor no lo cuenta como entregado y
 *    reintenta), mientras que cualquier evento verificado —incluido uno que no manejamos— debe
 *    dar **200**, o el proveedor entra en un bucle de reintentos;
 *  - un evento cuya orden no existe también responde 200: si se degradara a 500, Stripe
 *    reintentaría ese evento para siempre.
 *
 * Se mockea `config/stripe` (para poder dictar qué devuelve `constructEvent` sin firmar de
 * verdad) y `email.service`; la firma de Skydropx se calcula **real** con el secreto de
 * `.env.test`, porque justamente es lo que se está probando. La BD no se mockea.
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

const sendEmailMock = jest.fn().mockResolvedValue(true);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createOrder, createOrderItem, createProduct } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { ProductSize } from "../../src/models/ProductSize";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  sendEmailMock.mockClear();
  stripeMock.webhooks.constructEvent.mockReset();
});

/** Evento de Stripe con la forma mínima que lee el controlador. */
function stripeEvent(type: string, paymentIntent: Record<string, unknown>) {
  return { type, data: { object: paymentIntent } };
}

/**
 * Firma HMAC-SHA512 real sobre el cuerpo crudo, con el secreto de `.env.test`, en el formato
 * `Authorization: HMAC <hex>` que manda Skydropx.
 */
function hmacHeader(rawBody: string): string {
  const firma = crypto
    .createHmac("sha512", process.env.SKYDROPX_WEBHOOK_SECRET!)
    .update(Buffer.from(rawBody))
    .digest("hex");
  return `HMAC ${firma}`;
}

/** Evento `packages` de Skydropx (JSON:API), ya serializado para poder firmarlo tal cual. */
function packagesEvent(
  shipmentId: string,
  attributes: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    data: {
      // Ojo: `data.id` es el id del PAQUETE, no el del envío. El que empata con la orden viaja
      // en `relationships.shipment.data.id`.
      id: "package_999",
      type: "packages",
      attributes: {
        status: "in_transit",
        tracking_number: "1Z-TRACK-1",
        tracking_url_provider: "https://rastreo.test/1Z-TRACK-1",
        label_url: "https://etiquetas.test/1Z-TRACK-1.pdf",
        ...attributes,
      },
      relationships: { shipment: { data: { id: shipmentId } } },
    },
  });
}

/** Pedido pendiente con su stock ya reservado (5 − 2 = 3), tal como lo deja el checkout. */
async function pendingOrderWithStock(paymentIntentId: string) {
  const product = await createProduct({ sizes: { 25: 3 } });
  const order = await createOrder({ paymentIntentId, paymentStatus: "processing" });
  await createOrderItem(order.id, product, { size: 25, quantity: 2 });
  return { product, order };
}

async function stockOf(productId: number, size: number): Promise<number> {
  const row = await ProductSize.findOne({ where: { productId, size } });
  return row!.stock;
}

describe("POST /api/webhooks/stripe — verificación de firma", () => {
  it("responde 400 sin el header stripe-signature, sin intentar verificar", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(stripeEvent("payment_intent.succeeded", { id: "pi_1" })));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/firma/i);
    expect(stripeMock.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it("responde 400 cuando la verificación de la firma falla", async () => {
    stripeMock.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=firma-falsa")
      .send(JSON.stringify(stripeEvent("payment_intent.succeeded", { id: "pi_1" })));

    // 400 y no 500: Stripe NO lo cuenta como entregado y lo reintenta, que es lo correcto ante
    // una firma que no cuadra.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/firma de webhook inválida/i);
  });

  it("verifica sobre el Buffer CRUDO, no sobre un cuerpo re-serializado", async () => {
    const raw = JSON.stringify(stripeEvent("payment_intent.succeeded", { id: "pi_crudo" }));
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", { id: "pi_crudo" }),
    );

    await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send(raw);

    // Si `express.json()` se montara antes que este `express.raw`, el primer argumento sería un
    // objeto ya parseado y la verificación de firma fallaría siempre en producción.
    const [body, firma, secreto] = stripeMock.webhooks.constructEvent.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString("utf8")).toBe(raw);
    expect(firma).toBe("t=1,v1=x");
    expect(secreto).toBe("whsec_test");
  });
});

describe("POST /api/webhooks/stripe — despacho de eventos", () => {
  it("payment_intent.succeeded marca el pedido como pagado", async () => {
    const { order } = await pendingOrderWithStock("pi_ok");
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", { id: "pi_ok" }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("paid");
    expect(refreshed!.paymentStatus).toBe("paid");
  });

  it("payment_intent.payment_failed deja el pedido pending para poder reintentar el cobro", async () => {
    const { product, order } = await pendingOrderWithStock("pi_falla");
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.payment_failed", { id: "pi_falla" }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    expect(res.status).toBe(200);
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.paymentStatus).toBe("failed");
    // Sigue `pending` y con su stock reservado: un rechazo transitorio (fondos, 3DS) se puede
    // reintentar sobre el mismo PaymentIntent; el barrido lo liberará si se abandona.
    expect(refreshed!.status).toBe("pending");
    expect(await stockOf(product.id, 25)).toBe(3); // intacto, sigue apartado
  });

  it("payment_intent.canceled repone el stock y cancela el pedido", async () => {
    const { product, order } = await pendingOrderWithStock("pi_cancelada");
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.canceled", {
        id: "pi_cancelada",
        metadata: { orderId: String(order.id) },
      }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    expect(res.status).toBe(200);
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5); // 3 apartadas + las 2 devueltas
  });

  it("payment_intent.canceled sin orderId en metadata no revienta ni repone nada", async () => {
    const { product } = await pendingOrderWithStock("pi_sin_meta");
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.canceled", { id: "pi_sin_meta", metadata: {} }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    // `Number(undefined)` es NaN → falsy → no se llama a releaseOrderStock. Un 500 aquí haría
    // que Stripe reintentara este evento inútil para siempre.
    expect(res.status).toBe(200);
    expect(await stockOf(product.id, 25)).toBe(3); // sin reponer: no se supo qué pedido era
  });

  it("un evento verificado que no manejamos responde 200 (sin bucle de reintentos)", async () => {
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("charge.refunded", { id: "ch_1" }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("un evento de un PaymentIntent sin orden responde 200 en vez de 500", async () => {
    stripeMock.webhooks.constructEvent.mockReturnValue(
      stripeEvent("payment_intent.succeeded", { id: "pi_fantasma" }),
    );

    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=x")
      .send("{}");

    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/skydropx — verificación de firma HMAC", () => {
  it("responde 400 sin header Authorization", async () => {
    const raw = packagesEvent("shipment_1");

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .send(raw);

    expect(res.status).toBe(400);
  });

  it("responde 400 con un esquema de auth que no es HMAC", async () => {
    const raw = packagesEvent("shipment_1");

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer un-token-cualquiera")
      .send(raw);

    expect(res.status).toBe(400);
  });

  it("responde 400 con una firma que no corresponde al cuerpo", async () => {
    const raw = packagesEvent("shipment_1");
    // Firma válida en forma, calculada sobre OTRO cuerpo: es el intento de manipulación real.
    const firmaDeOtroCuerpo = hmacHeader(packagesEvent("shipment_distinto"));

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", firmaDeOtroCuerpo)
      .send(raw);

    expect(res.status).toBe(400);
  });

  it("responde 400 con una firma bien firmada pero de cuerpo no-JSON", async () => {
    const raw = "esto no es json";

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cuerpo de webhook inválido/i);
  });
});

describe("POST /api/webhooks/skydropx — evento packages", () => {
  /** Pedido pagado cuya guía ya se creó: es el que un evento de paquete viene a actualizar. */
  async function paidOrderWithShipment(shipmentId: string) {
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await order.update({ skydropxShipmentId: shipmentId });
    return order;
  }

  it("puebla el rastreo, avanza el estado y responde 200", async () => {
    const order = await paidOrderWithShipment("shipment_abc");
    const raw = packagesEvent("shipment_abc");

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.trackingNumber).toBe("1Z-TRACK-1");
    expect(refreshed!.trackingUrl).toBe("https://rastreo.test/1Z-TRACK-1");
    expect(refreshed!.labelUrl).toBe("https://etiquetas.test/1Z-TRACK-1.pdf");
    expect(refreshed!.status).toBe("shipped");
  });

  it("un estado `delivered` deja el pedido entregado", async () => {
    const order = await paidOrderWithShipment("shipment_entregada");
    const raw = packagesEvent("shipment_entregada", { status: "delivered" });

    await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("delivered");
  });

  it("un evento de otro tipo se acepta con 200 sin tocar nada", async () => {
    const order = await paidOrderWithShipment("shipment_otro");
    const raw = JSON.stringify({
      data: { id: "s1", type: "shipments", attributes: { status: "created" } },
    });

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(200);
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("paid");
    expect(refreshed!.trackingNumber).toBeNull();
  });

  it("un packages sin el id del envío en relationships responde 200 sin buscar orden", async () => {
    // `data.id` (el del paquete) NO sirve para localizar la orden; sin `relationships.shipment`
    // no hay nada que hacer, pero tampoco es un error del proveedor.
    const raw = JSON.stringify({
      data: { id: "package_1", type: "packages", attributes: { status: "in_transit" } },
    });

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("un envío realmente ajeno responde 200, no 503 (no debe entrar en bucle)", async () => {
    await paidOrderWithShipment("shipment_propia");
    const raw = packagesEvent("shipment_de_otra_cuenta");

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(200);
  });

  it("responde 503 si el evento llega mientras una guía se está creando", async () => {
    // Centinela recién reclamado: el id real todavía no se persiste, así que este evento no
    // encuentra su orden. Pedir reintento es mejor que perderlo — al reintentar ya estará.
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await order.update({
      skydropxShipmentId: "creating",
      shipmentClaimedAt: new Date(),
    });
    const raw = packagesEvent("shipment_aun_no_persistida");

    const res = await request(app)
      .post("/api/webhooks/skydropx")
      .set("Content-Type", "application/json")
      .set("Authorization", hmacHeader(raw))
      .send(raw);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/reintentar/i);
  });
});
