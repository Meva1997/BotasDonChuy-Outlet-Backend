import request from "supertest";

/**
 * Nivel 2 (Fase N.2): el CRUD admin de cupones por HTTP contra Postgres real.
 */
jest.mock("../../src/services/payment.service", () => ({
  createPaymentIntentForOrder: jest.fn().mockResolvedValue({
    clientSecret: "secret_test_123",
    paymentIntentId: "pi_test_123",
  }),
}));

jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import {
  ACCEPTED_TERMS,
  createAdminUser,
  createCoupon,
  createProduct,
  signToken,
} from "../setup/factories";
import { Coupon } from "../../src/models/Coupon";
import { resetCheckoutIdempotency } from "../../src/services/orders.service";

let token: string;

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

beforeEach(async () => {
  const { user } = await createAdminUser();
  token = signToken(user);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("/api/admin/coupons — auth", () => {
  it("las cuatro rutas responden 401 sin token", async () => {
    const coupon = await createCoupon();

    const responses = await Promise.all([
      request(app).get("/api/admin/coupons"),
      request(app).post("/api/admin/coupons").send({ code: "X1", type: "percent", value: 10 }),
      request(app).put(`/api/admin/coupons/${coupon.id}`).send({ active: false }),
      request(app).delete(`/api/admin/coupons/${coupon.id}`),
    ]);

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
  });
});

describe("POST /api/admin/coupons", () => {
  it("crea un cupón y aplica los defaults del modelo", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "verano25", type: "percent", value: 15, maxRedemptions: 50 });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe("VERANO25"); // normalizado a mayúsculas
    expect(res.body.redeemedCount).toBe(0);
    expect(res.body.oncePerCustomer).toBe(true);
    expect(res.body.active).toBe(true);
  });

  it("un código duplicado → 409 con el mensaje específico del pre-chequeo", async () => {
    await createCoupon({ code: "VERANO25" });

    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "VERANO25", type: "fixed", value: 100 });

    expect(res.status).toBe(409);
    // No el genérico de `errorHandler` ("Ya existe un registro con ese código"), sino el propio.
    expect(res.body.message).toMatch(/Ya existe un cupón con el código VERANO25/);
  });

  it("un porcentaje mayor a 100 → 400", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "IMPOSIBLE", type: "percent", value: 150 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no puede pasar de 100/i);
  });

  it("un tope en pesos sobre un cupón de monto fijo → 400", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "CONFUSO", type: "fixed", value: 100, maxDiscount: 50 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/solo aplica a los cupones de porcentaje/i);
  });

  it("una fecha de fin anterior a la de inicio → 400", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({
        code: "ALREVES",
        type: "percent",
        value: 10,
        startsAt: "2026-09-01",
        expiresAt: "2026-08-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/posterior a la de inicio/i);
  });

  it("una fecha sin hora se interpreta en la zona de la tienda, no en UTC", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "AGOSTO", type: "percent", value: 10, expiresAt: "2026-08-31" });

    expect(res.status).toBe(201);
    const stored = await Coupon.findOne({ where: { code: "AGOSTO" } });
    // Fin del 31 de agosto en America/Mexico_City (UTC−6) = 1 de septiembre 05:59:59.999 UTC.
    // Si se interpretara como medianoche UTC, el cupón moriría la tarde del 30 en México.
    expect(stored!.expiresAt!.toISOString()).toBe("2026-09-01T05:59:59.999Z");
  });

  it("un código no alfanumérico → 400", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set(auth())
      .send({ code: "20% OFF", type: "percent", value: 20 });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/coupons", () => {
  it("lista con el contador guardado y el conteo vivo de canjes", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    await createCoupon({ code: "VERANO25" });

    await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
        couponCode: "VERANO25",
      });

    const res = await request(app).get("/api/admin/coupons").set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].redeemedCount).toBe(1);
    expect(res.body[0].activeRedemptions).toBe(1);
  });

  it("un cupón sin canjes muestra los dos contadores en 0", async () => {
    await createCoupon({ code: "NUEVO" });

    const res = await request(app).get("/api/admin/coupons").set(auth());

    expect(res.body[0].redeemedCount).toBe(0);
    expect(res.body[0].activeRedemptions).toBe(0);
  });
});

describe("PUT /api/admin/coupons/:id", () => {
  it("`active: false` es cancelar: el checkout deja de aceptarlo", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const coupon = await createCoupon({ code: "VERANO25" });

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    const checkout = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
        couponCode: "VERANO25",
      });
    expect(checkout.status).toBe(409);
  });

  it("bajar maxRedemptions por debajo de redeemedCount es válido y detiene la promoción", async () => {
    // Es el edit que hace un dueño en pánico; validarlo en contra le quitaría la única forma de
    // frenar una promoción sin desactivarla del todo.
    const product = await createProduct({ sizes: { 25: 5 } });
    const coupon = await createCoupon({ code: "PARAR", redeemedCount: 40, maxRedemptions: 100 });

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({ maxRedemptions: 10 });
    expect(res.status).toBe(200);

    const checkout = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
        couponCode: "PARAR",
      });
    expect(checkout.status).toBe(409);
    expect(checkout.body.message).toMatch(/agot/i);
  });

  it("`redeemedCount` en el body se ignora: el contador guardado no se mueve", async () => {
    const coupon = await createCoupon({ code: "VERANO25", redeemedCount: 7 });

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({ redeemedCount: 0, description: "editado" });

    expect(res.status).toBe(200);
    await coupon.reload();
    expect(coupon.redeemedCount).toBe(7);
    expect(coupon.description).toBe("editado");
  });

  it("`code` en el body se ignora: el código no se puede renombrar", async () => {
    const coupon = await createCoupon({ code: "VERANO25" });

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({ code: "OTRO", description: "editado" });

    expect(res.status).toBe(200);
    await coupon.reload();
    expect(coupon.code).toBe("VERANO25");
  });

  it("un body vacío → 400 (no hay nada que actualizar)", async () => {
    const coupon = await createCoupon();

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({});

    expect(res.status).toBe(400);
  });

  it("valida contra el estado guardado, no solo contra el body", async () => {
    // El body trae UN campo, así que el refine del schema no tiene con qué comparar: la
    // combinación inválida solo se ve juntando lo guardado con lo que cambia.
    const coupon = await createCoupon({ code: "FIJO", type: "fixed", value: 100 });

    const res = await request(app)
      .put(`/api/admin/coupons/${coupon.id}`)
      .set(auth())
      .send({ maxDiscount: 50 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/solo aplica a los cupones de porcentaje/i);
  });

  it("un id inexistente → 404, y un id no numérico → 400", async () => {
    const notFound = await request(app)
      .put("/api/admin/coupons/9999")
      .set(auth())
      .send({ active: false });
    expect(notFound.status).toBe(404);

    const badId = await request(app)
      .put("/api/admin/coupons/abc")
      .set(auth())
      .send({ active: false });
    expect(badId.status).toBe(400);
  });
});

describe("DELETE /api/admin/coupons/:id", () => {
  it("sin pedidos que lo usen, se borra de verdad", async () => {
    const coupon = await createCoupon({ code: "SINUSO" });

    const res = await request(app).delete(`/api/admin/coupons/${coupon.id}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deactivated: false });
    expect(await Coupon.findByPk(coupon.id)).toBeNull();
  });

  it("con un pedido que lo usó, se desactiva y el histórico queda intacto", async () => {
    const product = await createProduct({ sizes: { 25: 5 } });
    const coupon = await createCoupon({ code: "VERANO25" });

    const created = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        ...ACCEPTED_TERMS,
        couponCode: "VERANO25",
      });
    expect(created.status).toBe(201);

    const res = await request(app).delete(`/api/admin/coupons/${coupon.id}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deactivated: true });

    await coupon.reload();
    expect(coupon.active).toBe(false);

    // El pedido conserva su cupón congelado: es lo que hace legible una venta pasada.
    const lookup = await request(app).get(
      `/api/orders/lookup/${created.body.order.publicToken}`,
    );
    expect(lookup.body.order.couponCode).toBe("VERANO25");
    expect(lookup.body.order.couponDiscount).toBeGreaterThan(0);
  });

  it("un id inexistente → 404", async () => {
    const res = await request(app).delete("/api/admin/coupons/9999").set(auth());
    expect(res.status).toBe(404);
  });
});
