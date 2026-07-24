import request from "supertest";

/**
 * `createPaymentIntentForOrder` (payment.service.ts) llamaría a Stripe de verdad si no
 * se mockea — ver el roadmap, Parte 3. Se reemplaza el módulo completo (no solo la
 * función) para que ningún otro export de `payment.service.ts` arrastre sus propios
 * imports (Resend, Skydropx, Sentry) a esta suite; el checkout solo usa
 * `createPaymentIntentForOrder`.
 */
jest.mock("../../src/services/payment.service", () => ({
  createPaymentIntentForOrder: jest.fn(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct } from "../setup/factories";
import { ProductSize } from "../../src/models/ProductSize";
import { createPaymentIntentForOrder } from "../../src/services/payment.service";

const createPaymentIntentForOrderMock = createPaymentIntentForOrder as jest.Mock;

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

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  createPaymentIntentForOrderMock.mockReset().mockResolvedValue({
    clientSecret: "secret_test_123",
    paymentIntentId: "pi_test_123",
  });
});

describe("POST /api/orders — descuento atómico de stock", () => {
  it("dos compras concurrentes por la última pieza → una 201 y una 409; stock final en 0", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });

    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
    };

    const [resA, resB] = await Promise.all([
      request(app).post("/api/orders").send(body),
      request(app).post("/api/orders").send(body),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const losingRes = resA.status === 409 ? resA : resB;
    expect(losingRes.body.message).toMatch(/se agotó/i);

    const size = await ProductSize.findOne({
      where: { productId: product.id, size: 25 },
    });
    expect(size!.stock).toBe(0);
  });
});

describe("POST /api/orders — totales autoritativos", () => {
  it("ignora cualquier precio/total que mande el cliente y recalcula server-side", async () => {
    const product = await createProduct({
      type: "bota",
      originalPrice: 1000,
      salePrice: 800,
      sizes: { 25: 5 },
    });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [
          {
            productId: product.id,
            size: 25,
            quantity: 2,
            // Campos que un cliente malicioso podría intentar inyectar en el
            // renglón — el schema no los reconoce, así que se descartan.
            unitSalePrice: 1,
            price: 1,
          },
        ],
        customer: validCustomer,
        // Igual a nivel de la orden completa.
        total: 1,
        subtotal: 1,
        savings: 999999,
      });

    expect(res.status).toBe(201);
    // subtotal = 1000 × 2, savings = (1000-800) × 2, shipping (bota) = 160.
    expect(res.body.order.subtotal).toBe(2000);
    expect(res.body.order.savings).toBe(400);
    expect(res.body.order.shipping).toBe(160);
    expect(res.body.order.total).toBe(2000 - 400 + 160);
  });
});

describe("POST /api/orders — refine quotationId/rateId", () => {
  it("quotationId sin rateId → 400", async () => {
    const product = await createProduct();

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        quotationId: "quotation_123",
      });

    expect(res.status).toBe(400);
  });

  it("rateId sin quotationId → 400", async () => {
    const product = await createProduct();

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        rateId: "rate_123",
      });

    expect(res.status).toBe(400);
  });
});
