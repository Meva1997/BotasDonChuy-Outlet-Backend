import request from "supertest";

/**
 * `shippingRateLimiter` (20 req/min) es una instancia real de `express-rate-limit`
 * compartida; esta suite no necesita ejercitar el límite en sí (parte del roadmap
 * lo marca fuera de alcance, igual que `authRateLimiter` en la Parte 2), así que se
 * mockea para no arriesgar un 429 en medio de la suite.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

/**
 * `getShippingRates` (skydropx.service.ts) llamaría a Skydropx de verdad si no se
 * mockea. Se reemplaza el módulo completo salvo lo que el controller también usa
 * (`getOriginAddress`/`toSkydropxAddress`, funciones puras sin red) vía
 * `jest.requireActual`, mismo patrón documentado en tests/setup/mocks/skydropx.ts.
 */
const getShippingRatesMock = jest.fn();
jest.mock("../../src/services/skydropx.service", () => ({
  ...jest.requireActual("../../src/services/skydropx.service"),
  getShippingRates: getShippingRatesMock,
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct } from "../setup/factories";
import { sampleRate } from "../setup/mocks/skydropx";
import { SkydropxRequestError } from "../../src/services/skydropx.service";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  getShippingRatesMock.mockReset();
});

const validCustomer = {
  fullName: "Cliente de Prueba",
  email: "cliente@test.com",
  phone: "4610000000",
  street: "Calle Falsa 123",
  neighborhood: "Centro",
  city: "Celaya",
  state: "Guanajuato",
  postalCode: "38000",
};

describe("POST /api/shipping/rates — fallback a tarifa plana", () => {
  it("Skydropx rechaza (network/5xx) → 200 con la tarifa plana de respaldo", async () => {
    const product = await createProduct({ type: "bota" });
    getShippingRatesMock.mockRejectedValue(new Error("network down"));

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBeNull();
    expect(res.body.rates).toHaveLength(1);
    expect(res.body.rates[0]).toMatchObject({
      rateId: null,
      carrier: "Estándar",
    });
    expect(res.body.rates[0].amount).toBeGreaterThan(0);
  });

  it("Skydropx tarda (SkydropxRequestError 5xx) → 200 con la tarifa plana de respaldo", async () => {
    const product = await createProduct({ type: "bota" });
    getShippingRatesMock.mockRejectedValue(new SkydropxRequestError("timeout", 503));

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBeNull();
    expect(res.body.rates[0].rateId).toBeNull();
  });

  it("Skydropx responde sin tarifas utilizables (rates: []) → 200 con la tarifa plana de respaldo", async () => {
    const product = await createProduct({ type: "bota" });
    getShippingRatesMock.mockResolvedValue({ quotationId: "quotation_empty", rates: [] });

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBeNull();
    expect(res.body.rates[0].rateId).toBeNull();
  });

  it("Skydropx responde con tarifas utilizables → 200 con esas tarifas (no la de respaldo)", async () => {
    const product = await createProduct({ type: "bota" });
    getShippingRatesMock.mockResolvedValue({
      quotationId: "quotation_ok",
      rates: [sampleRate({ id: "rate_1", total: 150 }), sampleRate({ id: "rate_2", total: 200 })],
    });

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBe("quotation_ok");
    expect(res.body.rates).toHaveLength(2);
    expect(res.body.rates[0].id).toBe("rate_1");
    expect(getShippingRatesMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/shipping/rates — dimensión en 0 salta directo al fallback", () => {
  it("un producto con weightKg 0 nunca llama a Skydropx", async () => {
    const product = await createProduct({ type: "bota", weightKg: 0 });

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBeNull();
    expect(res.body.rates[0].rateId).toBeNull();
    expect(getShippingRatesMock).not.toHaveBeenCalled();
  });

  it("un producto con lengthCm/widthCm/heightCm en 0 también salta el fallback sin llamar a Skydropx", async () => {
    const product = await createProduct({ type: "bota", lengthCm: 0, widthCm: 0, heightCm: 0 });

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.quotationId).toBeNull();
    expect(getShippingRatesMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/shipping/rates — disponibilidad del producto", () => {
  it("un producto no visible en el carrito → 409", async () => {
    const product = await createProduct({ visible: false });

    const res = await request(app)
      .post("/api/shipping/rates")
      .send({
        customer: validCustomer,
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(409);
    expect(getShippingRatesMock).not.toHaveBeenCalled();
  });
});
