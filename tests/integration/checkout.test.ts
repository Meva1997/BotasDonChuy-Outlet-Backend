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

/**
 * Solo `getQuotationRate` se reemplaza: `createOrder` también usa `toSkydropxAddress` y
 * `SkydropxRequestError` del mismo módulo, y mockearlo entero los volvería `undefined`.
 */
const getQuotationRateMock = jest.fn();
jest.mock("../../src/services/skydropx.service", () => ({
  ...jest.requireActual("../../src/services/skydropx.service"),
  getQuotationRate: getQuotationRateMock,
}));

/**
 * `orderRateLimiter` (10 req/min) comparte su store en memoria por todo el proceso de Jest, no
 * por test, y esta suite ya pasa de 10 `POST /api/orders` (descuento atómico, sin tallas, totales
 * autoritativos, quotationId/rateId, bultos). Mismo mock que `checkoutIdempotency.test.ts`/
 * `auth.test.ts`/`shippingRates.test.ts`: el rate limit es una defensa contra el abuso, no lo que
 * se prueba aquí.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct } from "../setup/factories";
import { ProductSize } from "../../src/models/ProductSize";
import { createPaymentIntentForOrder } from "../../src/services/payment.service";
import { resetCheckoutIdempotency } from "../../src/services/orders.service";

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
// La memoria de checkouts recientes (Fase O.2) vive en el módulo y sobrevive al truncate:
// sin limpiarla, un caso que repite el mismo carrito que otro recibiría su orden ya borrada.
afterEach(resetCheckoutIdempotency);
afterAll(closeTestDatabase);

beforeEach(() => {
  createPaymentIntentForOrderMock.mockReset().mockResolvedValue({
    clientSecret: "secret_test_123",
    paymentIntentId: "pi_test_123",
  });
  getQuotationRateMock.mockReset();
});

describe("POST /api/orders — descuento atómico de stock", () => {
  it("dos compras concurrentes por la última pieza → una 201 y una 409; stock final en 0", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });

    // Dos COMPRADORES distintos (no el mismo dos veces): desde la Fase O.2 dos requests
    // idénticos son un doble clic y se deduplican, así que la carrera por la última pieza
    // solo existe entre clientes diferentes.
    const items = [{ productId: product.id, size: 25, quantity: 1 }];
    const bodyA = { items, customer: validCustomer };
    const bodyB = {
      items,
      customer: { ...validCustomer, email: "otro@test.com", phone: "4619999999" },
    };

    const [resA, resB] = await Promise.all([
      request(app).post("/api/orders").send(bodyA),
      request(app).post("/api/orders").send(bodyB),
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

describe("POST /api/orders — productos sin tallas (hasSizes:false)", () => {
  it("compra un producto sin tallas con size:0 (centinela) y descuenta la única fila", async () => {
    const product = await createProduct({ hasSizes: false, sizes: { 0: 12 } });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 0, quantity: 2 }],
        customer: validCustomer,
      });

    expect(res.status).toBe(201);

    const row = await ProductSize.findOne({ where: { productId: product.id, size: 0 } });
    expect(row!.stock).toBe(10);
  });

  it("un producto sin tallas se agota sin mencionar 'talla' en el mensaje", async () => {
    const product = await createProduct({ hasSizes: false, sizes: { 0: 1 } });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 0, quantity: 2 }],
        customer: validCustomer,
      });

    expect(res.status).toBe(409);
    expect(res.body.message).not.toMatch(/talla/i);
  });

  it("mandar una talla real (size != 0) para un producto sin tallas → 400", async () => {
    const product = await createProduct({ hasSizes: false, sizes: { 0: 5 } });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no maneja tallas/i);
  });

  it("mandar size:0 para un producto CON tallas → 400", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 0, quantity: 1 }],
        customer: validCustomer,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/selecciona una talla/i);
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

describe("POST /api/orders — bultos congelados en el pedido (Fase N.6)", () => {
  const quoted = {
    items: (productId: number) => [{ productId, size: 25, quantity: 4 }],
    ids: { quotationId: "quotation_multi", rateId: "rate_multi" },
  };

  it("congela el `packageCount` de la tarifa re-consultada, no uno que mande el cliente", async () => {
    // La guía se genera minutos después y en otro proceso: para entonces el acomodo ya no se
    // puede reconstruir (las dimensiones del catálogo pudieron cambiar y `GET /quotations/{id}`
    // no devuelve los `parcels` cotizados), así que el conteo tiene que quedar guardado aquí.
    const product = await createProduct({ sizes: { 25: 10 } });
    getQuotationRateMock.mockResolvedValue({
      rateId: "rate_multi",
      carrier: "DHL",
      service: "Estándar",
      amount: 300,
      total: 300,
      days: 3,
      packageCount: 2,
      requiresDropoff: false,
    });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: quoted.items(product.id),
        customer: validCustomer,
        ...quoted.ids,
        // Un `packageCount` inventado por el cliente no debe llegar a la orden, igual que
        // tampoco llega un monto de envío.
        packageCount: 99,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.packageCount).toBe(2);
    expect(res.body.order.shipping).toBe(300);
  });

  it("sin cotización en vivo (tarifa plana) el pedido no guarda bultos", async () => {
    // `null` = "este pedido no tiene guía de Skydropx que declarar"; el generador la lee como 1.
    const product = await createProduct({ sizes: { 25: 10 } });

    const res = await request(app)
      .post("/api/orders")
      .send({ items: quoted.items(product.id), customer: validCustomer });

    expect(res.status).toBe(201);
    expect(res.body.order.packageCount).toBeNull();
    expect(getQuotationRateMock).not.toHaveBeenCalled();
  });
});
