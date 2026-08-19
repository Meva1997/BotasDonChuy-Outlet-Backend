import request from "supertest";

/**
 * Idempotencia de `POST /api/orders` (Fase O.2 — roadmap-operacion-y-negocio.md).
 *
 * Lo que se verifica es que un reenvío del mismo checkout (doble clic, retry del navegador)
 * NO cree un segundo pedido: una sola fila `Order`, un solo PaymentIntent, el stock descontado
 * una vez y el mismo `clientSecret` en las dos respuestas.
 *
 * Se mockea `payment.service` completo igual que en `checkout.test.ts` (el checkout solo usa
 * `createPaymentIntentForOrder`, y así ningún otro export arrastra Resend/Skydropx/Sentry a
 * esta suite). El contador de llamadas al mock ES la prueba de que Stripe se llamó una vez.
 */
jest.mock("../../src/services/payment.service", () => ({
  createPaymentIntentForOrder: jest.fn(),
}));

/**
 * `orderRateLimiter` (10 req/min) comparte su store en memoria por todo el proceso de Jest,
 * no por test, y esta suite hace bastantes más de 10 checkouts. Se mockea igual que en
 * `auth.test.ts`/`shippingRates.test.ts`: el rate limit es una defensa contra el abuso, algo
 * distinto de la idempotencia (el accidente), y probarlo no es parte de esta fase.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { ACCEPTED_TERMS, createProduct } from "../setup/factories";
import { Order } from "../../src/models/Order";
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
afterEach(resetCheckoutIdempotency);
afterAll(closeTestDatabase);

beforeEach(() => {
  let counter = 0;
  createPaymentIntentForOrderMock.mockReset().mockImplementation(async () => {
    counter += 1;
    // Un secreto distinto por llamada: si dos respuestas traen el mismo, es porque hubo
    // una sola llamada a Stripe (no porque el mock devuelva siempre lo mismo).
    return {
      clientSecret: `secret_test_${counter}`,
      paymentIntentId: `pi_test_${counter}`,
    };
  });
});

describe("POST /api/orders — idempotencia por huella del carrito", () => {
  it("dos POST idénticos concurrentes → un solo pedido, un solo PaymentIntent, stock descontado una vez", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 2 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const [resA, resB] = await Promise.all([
      request(app).post("/api/orders").send(body),
      request(app).post("/api/orders").send(body),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.order.id).toBe(resB.body.order.id);
    expect(resA.body.clientSecret).toBe(resB.body.clientSecret);

    expect(await Order.count()).toBe(1);
    expect(createPaymentIntentForOrderMock).toHaveBeenCalledTimes(1);

    const size = await ProductSize.findOne({
      where: { productId: product.id, size: 25 },
    });
    expect(size!.stock).toBe(3); // 5 − 2, no 5 − 4
  });

  it("el reenvío secuencial (el original ya terminó) también devuelve el pedido original", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const first = await request(app).post("/api/orders").send(body);
    const second = await request(app).post("/api/orders").send(body);

    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(second.body.clientSecret).toBe(first.body.clientSecret);
    expect(await Order.count()).toBe(1);
    expect(createPaymentIntentForOrderMock).toHaveBeenCalledTimes(1);

    // El cuerpo de las dos respuestas es el mismo: el header es lo único que distingue
    // "se creó tu pedido" de "este ya lo tenías".
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    expect(second.headers["idempotency-replayed"]).toBe("true");
  });

  it("el mismo carrito con los renglones en otro orden se reconoce como el mismo pedido", async () => {
    const product = await createProduct({ sizes: { 25: 5, 26: 5 } });
    const lineA = { productId: product.id, size: 25, quantity: 1 };
    const lineB = { productId: product.id, size: 26, quantity: 1 };

    const first = await request(app)
      .post("/api/orders")
      .send({ items: [lineA, lineB], customer: validCustomer, ...ACCEPTED_TERMS });
    const second = await request(app)
      .post("/api/orders")
      .send({ items: [lineB, lineA], customer: validCustomer, ...ACCEPTED_TERMS });

    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await Order.count()).toBe(1);
  });

  it("un carrito distinto del mismo cliente sí crea un segundo pedido", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });

    const first = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
      });
    const second = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 2 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
      });

    expect(second.body.order.id).not.toBe(first.body.order.id);
    expect(await Order.count()).toBe(2);
    expect(createPaymentIntentForOrderMock).toHaveBeenCalledTimes(2);
  });

  it("dos compradores distintos con el mismo carrito son dos pedidos", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const items = [{ productId: product.id, size: 25, quantity: 1 }];

    const first = await request(app)
      .post("/api/orders")
      .send({ items, customer: validCustomer, ...ACCEPTED_TERMS });
    const second = await request(app)
      .post("/api/orders")
      .send({
        items,
        customer: { ...validCustomer, email: "otra@test.com", phone: "4611111111" },
        ...ACCEPTED_TERMS,
      });

    expect(second.body.order.id).not.toBe(first.body.order.id);
    expect(await Order.count()).toBe(2);
  });

  it("un intento que no persistió nada libera la clave: el MISMO carrito puede reintentarse ya", async () => {
    // El carrito es idéntico en los dos envíos (misma huella → misma clave), que es lo
    // único que prueba de verdad la liberación: con dos carritos distintos el reintento
    // usaría otra clave y pasaría aunque la clave del primero se quedara ocupada.
    const product = await createProduct({ sizes: { 25: 0 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    // Sin stock → 409 antes de escribir nada.
    const failed = await request(app).post("/api/orders").send(body);
    expect(failed.status).toBe(409);
    expect(await Order.count()).toBe(0);

    // Entra mercancía y el comprador reintenta de inmediato: no debe quedar bloqueado.
    await ProductSize.update({ stock: 3 }, { where: { productId: product.id, size: 25 } });

    const retried = await request(app).post("/api/orders").send(body);
    expect(retried.status).toBe(201);
    expect(await Order.count()).toBe(1);
  });

  it("si el pedido ya se creó y falla el cobro, el reenvío NO crea un segundo pedido", async () => {
    // La rama cara: `createOrder` commiteó (fila + stock descontado) y Stripe se cayó
    // después. Liberar la clave aquí convertiría el reintento —el más probable de todos,
    // porque el comprador acaba de ver un error— en un segundo pedido con stock apartado
    // hasta que lo alcance el barrido de pendientes.
    createPaymentIntentForOrderMock.mockRejectedValue(new Error("Stripe no responde"));

    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 2 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const first = await request(app).post("/api/orders").send(body);
    expect(first.status).toBe(500);
    expect(await Order.count()).toBe(1);

    const retried = await request(app).post("/api/orders").send(body);
    expect(retried.status).toBe(500);
    expect(await Order.count()).toBe(1);
    expect(createPaymentIntentForOrderMock).toHaveBeenCalledTimes(1);

    const size = await ProductSize.findOne({ where: { productId: product.id, size: 25 } });
    expect(size!.stock).toBe(3); // 5 − 2, no 5 − 4
  });
});

describe("POST /api/orders — header Idempotency-Key", () => {
  it("la misma clave con el mismo carrito devuelve el pedido original", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const first = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "checkout-abc-123")
      .send(body);
    const second = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "checkout-abc-123")
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await Order.count()).toBe(1);
    expect(createPaymentIntentForOrderMock).toHaveBeenCalledTimes(1);
  });

  it("la clave tiene prioridad sobre la huella: claves distintas con el mismo carrito son dos pedidos", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const first = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "intento-1")
      .send(body);
    const second = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "intento-2")
      .send(body);

    expect(second.body.order.id).not.toBe(first.body.order.id);
    expect(await Order.count()).toBe(2);
  });

  it("reusar la clave con OTRO carrito → 409 (nunca se devuelve un pedido que no es el suyo)", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });

    await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "clave-reusada")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
      });

    const conflict = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "clave-reusada")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 2 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
      });

    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toMatch(/clave de idempotencia/i);
    expect(await Order.count()).toBe(1);
  });

  it("una clave absurdamente larga → 400", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });

    const res = await request(app)
      .post("/api/orders")
      .set("Idempotency-Key", "x".repeat(201))
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
      });

    expect(res.status).toBe(400);
    expect(await Order.count()).toBe(0);
  });

  it("una clave vacía se ignora y cae a la huella del carrito", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      ...ACCEPTED_TERMS,
    };

    const first = await request(app).post("/api/orders").set("Idempotency-Key", "   ").send(body);
    const second = await request(app).post("/api/orders").send(body);

    expect(first.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await Order.count()).toBe(1);
  });
});
