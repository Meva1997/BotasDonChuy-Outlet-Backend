import request from "supertest";

/**
 * Fase O.4 — consulta pública de pedido (`GET /api/orders/lookup/:token`).
 * Nivel 2 (integración HTTP, ver roadmap-testing.md): ruta → rate limiter → controlador →
 * servicio → Postgres real.
 *
 * Las dos cosas que esta suite defiende, y que son el motivo de la fase:
 *  1. **Que la ruta no filtre nada.** Es la única lectura pública de órdenes que existe, y la
 *     proyección es a mano — un test que solo mire "trae el estado" no detectaría que alguien
 *     agregó un campo de más. Aquí se afirma tanto lo que debe venir como lo que NO.
 *  2. **Que el 404 sea indistinguible.** Token inexistente y token mal formado tienen que
 *     responder el mismo status y el mismo mensaje, o la ruta confirmaría qué tokens existen.
 *
 * `payment.service` se mockea igual que en `checkout.test.ts`: el checkout solo necesita
 * `createPaymentIntentForOrder`, y así ningún otro export arrastra Resend/Skydropx/Sentry.
 */
jest.mock("../../src/services/payment.service", () => ({
  createPaymentIntentForOrder: jest.fn().mockResolvedValue({
    clientSecret: "secret_test",
    paymentIntentId: "pi_test",
  }),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import {
  ACCEPTED_TERMS,
  createOrder,
  createOrderItem,
  createProduct,
} from "../setup/factories";
import { Order } from "../../src/models/Order";
import { resetCheckoutIdempotency } from "../../src/services/orders.service";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterEach(resetCheckoutIdempotency);
afterAll(closeTestDatabase);

/** Una orden entregada, con guía y un renglón, más su token de consulta. */
async function deliveredOrderWithToken(overrides: Partial<Record<string, unknown>> = {}) {
  const product = await createProduct({ sizes: { 26: 3 } });
  const order = await createOrder({ status: "shipped", paymentStatus: "paid" });
  await createOrderItem(order.id, product, { size: 26, quantity: 2 });
  await order.update({
    publicToken: "3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13",
    trackingNumber: "ESF1234567890",
    trackingUrl: "https://rastreo.test.mx/ESF1234567890",
    shipmentStatus: "in_transit",
    shippingCarrier: "Estafeta",
    labelUrl: "https://cdn.skydropx.test/labels/ship_1.pdf",
    paymentIntentId: "pi_secreto",
    shippingRequiresDropoff: true,
    skydropxShipmentId: "ship_1",
    ...overrides,
  });
  return order;
}

function lookup(token: string) {
  return request(app).get(`/api/orders/lookup/${token}`);
}

describe("GET /api/orders/lookup/:token — token válido", () => {
  it("devuelve estado, rastreo, totales, dirección y renglones del pedido", async () => {
    const order = await deliveredOrderWithToken();

    const res = await lookup(order.publicToken!);

    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(order.id);
    expect(res.body.order.status).toBe("shipped");
    expect(res.body.order.paymentStatus).toBe("paid");
    expect(res.body.order.trackingNumber).toBe("ESF1234567890");
    expect(res.body.order.trackingUrl).toBe("https://rastreo.test.mx/ESF1234567890");
    expect(res.body.order.shipmentStatus).toBe("in_transit");
    expect(res.body.order.shippingCarrier).toBe("Estafeta");
    expect(res.body.order.total).toBe(order.total);
    expect(res.body.order.shippingAddress).toEqual({
      street: "Calle Falsa 123",
      neighborhood: "Centro",
      city: "Celaya",
      state: "GTO",
      postalCode: "38000",
      references: null,
    });
    expect(res.body.order.items).toHaveLength(1);
    expect(res.body.order.items[0]).toEqual({
      nameSnapshot: "Bota de prueba",
      size: 26,
      quantity: 2,
      unitOriginalPrice: 1000,
      unitSalePrice: 800,
    });
  });

  it("un pedido pending (aún sin pagar) también se consulta, sin datos de guía", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "pending" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    await order.update({ publicToken: "11111111-2222-4333-8444-555555555555" });

    const res = await lookup(order.publicToken!);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("pending");
    expect(res.body.order.paymentStatus).toBe("unpaid");
    expect(res.body.order.trackingNumber).toBeNull();
    expect(res.body.order.trackingUrl).toBeNull();
    expect(res.body.order.shipmentStatus).toBeNull();
  });

  it("un pedido cancelado y reembolsado reporta su estado y la fecha del reembolso, sin el id de Stripe", async () => {
    const order = await createOrder({ status: "cancelled", paymentStatus: "refunded" });
    const refundedAt = new Date("2026-07-20T12:00:00.000Z");
    await order.update({
      publicToken: "22222222-3333-4444-8555-666666666666",
      refundId: "re_secreto",
      refundedAt,
    });

    const res = await lookup(order.publicToken!);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("cancelled");
    expect(res.body.order.paymentStatus).toBe("refunded");
    expect(new Date(res.body.order.refundedAt as string)).toEqual(refundedAt);
    expect(res.body.order).not.toHaveProperty("refundId");
    expect(JSON.stringify(res.body)).not.toContain("re_secreto");
  });
});

describe("GET /api/orders/lookup/:token — nada que no deba salir", () => {
  it("la respuesta no expone costos, ids de pago/envío, la etiqueta ni el propio token", async () => {
    const order = await deliveredOrderWithToken();

    const res = await lookup(order.publicToken!);

    expect(res.status).toBe(200);
    const body = res.body.order;
    // Campos prohibidos, uno por uno (la lista es el contrato de la fase).
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(body).not.toHaveProperty("shippingRequiresDropoff");
    expect(body).not.toHaveProperty("labelUrl");
    expect(body).not.toHaveProperty("skydropxShipmentId");
    expect(body).not.toHaveProperty("skydropxQuotationId");
    expect(body).not.toHaveProperty("skydropxRateId");
    expect(body).not.toHaveProperty("publicToken");
    expect(body).not.toHaveProperty("customerEmail");
    expect(body).not.toHaveProperty("customerPhone");
    expect(body.items[0]).not.toHaveProperty("unitCost");
    expect(body.items[0]).not.toHaveProperty("productId");
    // Y el barrido: ningún valor sensible aparece en NINGÚN nivel del JSON, por si un campo
    // nuevo lo colara con otro nombre.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("pi_secreto");
    expect(raw).not.toContain("ship_1");
    expect(raw).not.toContain("skydropx.test");
    expect(raw).not.toContain(order.publicToken!);
  });

  it("tampoco expone la constancia de aceptación de términos (Fase 27)", async () => {
    // Este link se comparte por WhatsApp: la constancia es un dato del comercio para acreditar
    // la operación ante un tercero, no algo que deba viajar con cada reenvío del seguimiento.
    // La IP, además, es dato personal — y aquí no hay ninguna credencial más allá del token.
    const order = await deliveredOrderWithToken({
      termsAcceptedAt: new Date("2026-08-19T12:00:00.000Z"),
      termsVersion: "2026-08-18",
      termsAcceptedIp: "189.203.44.12",
    });

    const res = await lookup(order.publicToken!);

    expect(res.status).toBe(200);
    expect(res.body.order).not.toHaveProperty("termsAcceptedAt");
    expect(res.body.order).not.toHaveProperty("termsVersion");
    expect(res.body.order).not.toHaveProperty("termsAcceptedIp");
    expect(JSON.stringify(res.body)).not.toContain("189.203.44.12");
  });
});

describe("GET /api/orders/lookup/:token — token que no resuelve", () => {
  const NOT_FOUND_MESSAGE =
    "No encontramos ningún pedido con ese enlace. Revisa que esté completo o busca el correo de confirmación que te enviamos.";

  it("un token inexistente (pero bien formado) responde 404 genérico", async () => {
    await deliveredOrderWithToken();

    const res = await lookup("99999999-8888-4777-8666-555555555555");

    expect(res.status).toBe(404);
    expect(res.body.message).toBe(NOT_FOUND_MESSAGE);
  });

  it("cambiar un solo carácter del token válido no devuelve el pedido", async () => {
    const order = await deliveredOrderWithToken();
    const tampered = order.publicToken!.replace(/.$/, "4");

    const res = await lookup(tampered);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe(NOT_FOUND_MESSAGE);
  });

  it("un token que no es UUID responde el MISMO 404, no un 500 de Postgres", async () => {
    // Sin la validación de formato, la comparación contra una columna `uuid` revienta en
    // Postgres y el errorHandler la degrada a "Error interno del servidor" — el mismo problema
    // que `parseId` resuelve para los ids numéricos, y además delataría la causa.
    const res = await lookup("no-es-un-uuid");

    expect(res.status).toBe(404);
    expect(res.body.message).toBe(NOT_FOUND_MESSAGE);
  });

  it("el mensaje es idéntico para un token inexistente y para uno mal formado", async () => {
    const inexistente = await lookup("99999999-8888-4777-8666-555555555555");
    const malFormado = await lookup("abc");

    expect(inexistente.status).toBe(malFormado.status);
    expect(inexistente.body.message).toBe(malFormado.body.message);
  });
});

describe("POST /api/orders — genera el token de consulta", () => {
  it("el checkout crea un publicToken único y lo devuelve al comprador", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = (email: string) => ({
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: {
        fullName: "Cliente de Prueba",
        email,
        phone: "4610000000",
        street: "Calle Falsa 123",
        neighborhood: "Centro",
        city: "Celaya",
        state: "Guanajuato",
        postalCode: "38000",
      },
      ...ACCEPTED_TERMS,
    });

    const first = await request(app).post("/api/orders").send(body("uno@test.com"));
    const second = await request(app).post("/api/orders").send(body("dos@test.com"));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // El comprador lo recibe en la respuesta del checkout: el pedido es suyo, y así el front
    // puede llevarlo a la página de seguimiento sin esperar el correo.
    expect(first.body.order.publicToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second.body.order.publicToken).not.toBe(first.body.order.publicToken);

    // Y sirve de verdad contra la ruta pública.
    const res = await lookup(first.body.order.publicToken);
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(first.body.order.id);
  });

  it("cada token apunta solo a su pedido", async () => {
    const a = await createOrder({ status: "paid", paymentStatus: "paid" });
    const b = await createOrder({ status: "paid", paymentStatus: "paid" });
    await a.update({ publicToken: "aaaaaaaa-1111-4111-8111-111111111111" });
    await b.update({ publicToken: "bbbbbbbb-2222-4222-8222-222222222222" });

    const resA = await lookup(a.publicToken!);
    const resB = await lookup(b.publicToken!);

    expect(resA.body.order.id).toBe(a.id);
    expect(resB.body.order.id).toBe(b.id);
    expect(resA.body.order.id).not.toBe(resB.body.order.id);
  });

  it("dos pedidos no pueden compartir token (índice único en la BD)", async () => {
    const a = await createOrder();
    const b = await createOrder();
    await a.update({ publicToken: "cccccccc-3333-4333-8333-333333333333" });

    await expect(
      b.update({ publicToken: "cccccccc-3333-4333-8333-333333333333" }),
    ).rejects.toThrow();
  });
});
