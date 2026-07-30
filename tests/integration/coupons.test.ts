import request from "supertest";

/**
 * Nivel 2 (Fase N.2): la superficie pública de los cupones — `POST /api/coupons/validate` y el
 * canje real en `POST /api/orders` — por HTTP contra Postgres de verdad.
 *
 * Se mockea `payment.service` completo, igual que `checkout.test.ts`: crear un PaymentIntent
 * real cuesta dinero, y ningún otro export de ese módulo hace falta aquí.
 */
jest.mock("../../src/services/payment.service", () => ({
  createPaymentIntentForOrder: jest.fn(),
}));

/**
 * `orderRateLimiter` (10 req/min) y `couponRateLimiter` (20/min) comparten su store en memoria
 * por todo el proceso de Jest, no por test, y esta suite hace bastantes más de 10 checkouts. Se
 * mockean igual que en `checkoutIdempotency.test.ts`: el rate limit es la defensa contra el abuso,
 * distinta de lo que se prueba aquí.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct, createCoupon } from "../setup/factories";
import { ProductSize } from "../../src/models/ProductSize";
import { Coupon } from "../../src/models/Coupon";
import { CouponRedemption } from "../../src/models/CouponRedemption";
import { Order } from "../../src/models/Order";
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
  createPaymentIntentForOrderMock.mockReset().mockResolvedValue({
    clientSecret: "secret_test_123",
    paymentIntentId: "pi_test_123",
  });
});

/** Producto de 1000/800: cada pieza aporta 800 de mercancía neta y 160 de envío plano. */
async function bota() {
  return createProduct({
    type: "bota",
    originalPrice: 1000,
    salePrice: 800,
    sizes: { 25: 5 },
  });
}

describe("POST /api/coupons/validate — valida sin canjear", () => {
  it("devuelve el descuento calculado en el servidor y NO mueve el contador de usos", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "VERANO25", type: "percent", value: 15 });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({
        code: "VERANO25",
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    // Neto = subtotal(1000) − savings(200) = 800 → 15% = 120.
    expect(res.body.coupon.discount).toBe(120);
    expect(res.body.coupon.netMerchandise).toBe(800);

    // La aserción central de la fase: consultar no gasta la promoción.
    await coupon.reload();
    expect(coupon.redeemedCount).toBe(0);
    expect(await CouponRedemption.count()).toBe(0);
  });

  it("normaliza el código: minúsculas y espacios encuentran el mismo cupón", async () => {
    const product = await bota();
    await createCoupon({ code: "VERANO25" });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({
        code: "  verano25 ",
        items: [{ productId: product.id, size: 25, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.coupon.code).toBe("VERANO25");
  });

  it("un código inexistente → 404", async () => {
    const product = await bota();

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "NOEXISTE", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no existe/i);
  });

  it("un código mal formado → 400 (nunca se ignora en silencio)", async () => {
    const product = await bota();

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "ab!", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(400);
  });

  it("un cupón desactivado → 409", async () => {
    const product = await bota();
    await createCoupon({ code: "CANCELADO", active: false });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "CANCELADO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/ya no está disponible/i);
  });

  it("un cupón vencido → 409 con la fecha", async () => {
    const product = await bota();
    await createCoupon({ code: "VENCIDO", expiresAt: new Date("2020-01-15T12:00:00Z") });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "VENCIDO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/venció/i);
  });

  it("un cupón que todavía no empieza → 409", async () => {
    const product = await bota();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await createCoupon({ code: "FUTURO", startsAt: future });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "FUTURO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/todavía no empieza/i);
  });

  it("un cupón agotado → 409", async () => {
    const product = await bota();
    await createCoupon({ code: "AGOTADO", maxRedemptions: 2, redeemedCount: 2 });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "AGOTADO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/se agotó/i);
  });

  it("mínimo de compra no alcanzado → 409 diciendo cuánto falta", async () => {
    const product = await bota();
    await createCoupon({ code: "MINIMO", minSubtotal: 2000 });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "MINIMO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    // El mínimo se compara contra el NETO (800), no contra el subtotal a precio original (1000):
    // faltan 1200, no 1000.
    expect(res.body.message).toMatch(/\$1,200\.00/);
  });

  it("sin correo NO se verifica el uso por cliente y lo declara", async () => {
    const product = await bota();
    await createCoupon({ code: "UNICO", oncePerCustomer: true });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "UNICO", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.coupon.perCustomerChecked).toBe(false);
    expect(res.body.coupon.oncePerCustomer).toBe(true);
  });

  it("con el correo de alguien que ya lo canjeó → 409", async () => {
    const product = await bota();
    await createCoupon({ code: "UNICO" });

    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      couponCode: "UNICO",
    };
    expect((await request(app).post("/api/orders").send(body)).status).toBe(201);

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({
        code: "UNICO",
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        email: validCustomer.email,
      });

    expect(res.status).toBe(409);
    expect(res.body.coupon).toBeUndefined();
  });

  it("un producto oculto da el mismo 409 que dará el checkout", async () => {
    const product = await createProduct({ visible: false, sizes: { 25: 5 } });
    await createCoupon({ code: "VERANO25" });

    const res = await request(app)
      .post("/api/coupons/validate")
      .send({ code: "VERANO25", items: [{ productId: product.id, size: 25, quantity: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no está disponible/i);
  });
});

describe("POST /api/orders — canje del cupón", () => {
  it("descuenta sobre la mercancía neta, deja el envío intacto y congela el cupón", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "VERANO25", type: "percent", value: 15 });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "VERANO25",
      });

    expect(res.status).toBe(201);
    const order = res.body.order;
    expect(order.subtotal).toBe(1000);
    // `savings` sigue siendo SOLO el ahorro outlet: el cupón no se suma ahí.
    expect(order.savings).toBe(200);
    expect(order.shipping).toBe(160);
    expect(order.couponCode).toBe("VERANO25");
    expect(order.couponDiscount).toBe(120);
    expect(order.total).toBe(1000 - 200 - 120 + 160);
    // El id interno del cupón no se expone en la respuesta pública.
    expect(order.couponId).toBeUndefined();

    await coupon.reload();
    expect(coupon.redeemedCount).toBe(1);

    const redemption = await CouponRedemption.findOne({ where: { orderId: order.id } });
    expect(redemption).not.toBeNull();
    expect(redemption!.emailNormalized).toBe("cliente@test.com");
    expect(redemption!.discount).toBe(120);
    expect(redemption!.releasedAt).toBeNull();
  });

  it("ignora cualquier monto de descuento que mande el cliente", async () => {
    const product = await bota();
    await createCoupon({ code: "VERANO25", type: "percent", value: 15 });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "VERANO25",
        // Basura inyectada a propósito: el servidor es la autoridad.
        couponDiscount: 99999,
        total: 1,
        savings: 999999,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.couponDiscount).toBe(120);
    expect(res.body.order.total).toBe(840);
  });

  it("un cupón fijo mayor que el carrito deja el total en el puro envío", async () => {
    const product = await bota();
    await createCoupon({ code: "REGALO", type: "fixed", value: 5000 });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "REGALO",
      });

    expect(res.status).toBe(201);
    // El descuento se recorta al neto (800) y el envío se cobra completo.
    expect(res.body.order.couponDiscount).toBe(800);
    expect(res.body.order.total).toBe(160);
  });

  it("un cupón que no existe NO crea el pedido ni descuenta stock", async () => {
    const product = await bota();

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "NOEXISTE",
      });

    expect(res.status).toBe(404);
    expect(await Order.count()).toBe(0);
    const size = await ProductSize.findOne({ where: { productId: product.id, size: 25 } });
    expect(size!.stock).toBe(5);
  });

  it("un cupón desactivado entre la validación y el pago → 409 sin pedido", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "CANCELADO" });
    await coupon.update({ active: false });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "CANCELADO",
      });

    expect(res.status).toBe(409);
    expect(await Order.count()).toBe(0);
  });

  it("sin cupón, `couponDiscount` es 0 y el total no cambia de forma", async () => {
    const product = await bota();

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.couponDiscount).toBe(0);
    expect(res.body.order.couponCode).toBeNull();
    expect(res.body.order.total).toBe(960);
  });
});

describe("POST /api/orders — carreras por el último uso", () => {
  it("mismo correo, dos carritos distintos → una 201 y una 409; un solo canje", async () => {
    // Carritos distintos a propósito: con el mismo body, la idempotencia de la Fase O.2 lo
    // trataría como doble clic y devolvería el original, así que no habría carrera que probar.
    const product = await bota();
    const coupon = await createCoupon({ code: "UNICO", oncePerCustomer: true });

    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/orders")
        .send({
          items: [{ productId: product.id, size: 25, quantity: 1 }],
          customer: validCustomer,
          couponCode: "UNICO",
        }),
      request(app)
        .post("/api/orders")
        .send({
          items: [{ productId: product.id, size: 25, quantity: 2 }],
          customer: validCustomer,
          couponCode: "UNICO",
        }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);

    await coupon.reload();
    expect(coupon.redeemedCount).toBe(1);
    expect(await CouponRedemption.count({ where: { releasedAt: null } })).toBe(1);
  });

  it("maxRedemptions 1 con dos correos distintos → una 201 y una 409 'se agotó'", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "SOLOUNO", maxRedemptions: 1 });

    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/orders")
        .send({
          items: [{ productId: product.id, size: 25, quantity: 1 }],
          customer: validCustomer,
          couponCode: "SOLOUNO",
        }),
      request(app)
        .post("/api/orders")
        .send({
          items: [{ productId: product.id, size: 25, quantity: 1 }],
          customer: { ...validCustomer, email: "otro@test.com", phone: "4619999999" },
          couponCode: "SOLOUNO",
        }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);
    const losing = resA.status === 409 ? resA : resB;
    expect(losing.body.message).toMatch(/agot/i);

    await coupon.reload();
    expect(coupon.redeemedCount).toBe(1);
    expect(await Order.count()).toBe(1);
  });

  it("un segundo pedido del mismo correo, ya fuera de carrera, también se rechaza", async () => {
    const product = await bota();
    await createCoupon({ code: "UNICO" });
    const items = [{ productId: product.id, size: 25, quantity: 1 }];

    const first = await request(app)
      .post("/api/orders")
      .send({ items, customer: validCustomer, couponCode: "UNICO" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 3 }],
        customer: validCustomer,
        couponCode: "UNICO",
      });

    expect(second.status).toBe(409);
    // El primer pedido sigue `pending` (nadie lo pagó), así que el mensaje es el que invita a
    // terminar de pagarlo en vez de acusar al comprador de haber usado ya el cupón.
    expect(second.body.message).toMatch(/sin pagar/i);
  });
});

describe("POST /api/orders — idempotencia con cupón", () => {
  it("el mismo carrito con y sin cupón son DOS pedidos distintos", async () => {
    const product = await bota();
    await createCoupon({ code: "VERANO25" });
    const items = [{ productId: product.id, size: 25, quantity: 1 }];

    const sinCupon = await request(app)
      .post("/api/orders")
      .send({ items, customer: validCustomer });
    const conCupon = await request(app)
      .post("/api/orders")
      .send({ items, customer: validCustomer, couponCode: "VERANO25" });

    expect(sinCupon.status).toBe(201);
    expect(conCupon.status).toBe(201);
    // Si la huella no incluyera el código, el segundo request recibiría el pedido SIN descuento.
    expect(conCupon.body.order.id).not.toBe(sinCupon.body.order.id);
    expect(conCupon.body.order.couponDiscount).toBe(120);
    expect(conCupon.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("dos requests idénticos con cupón → un solo pedido y un solo canje", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "VERANO25" });
    const body = {
      items: [{ productId: product.id, size: 25, quantity: 1 }],
      customer: validCustomer,
      couponCode: "VERANO25",
    };

    const first = await request(app).post("/api/orders").send(body);
    const replay = await request(app).post("/api/orders").send(body);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body.order.id).toBe(first.body.order.id);

    await coupon.reload();
    expect(coupon.redeemedCount).toBe(1);
    expect(await Order.count()).toBe(1);
  });
});

describe("GET /api/orders/lookup/:token — con cupón", () => {
  it("expone el código y el descuento (pero no el id interno del cupón)", async () => {
    const product = await bota();
    await createCoupon({ code: "VERANO25" });

    const created = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "VERANO25",
      });
    const token = created.body.order.publicToken;

    const res = await request(app).get(`/api/orders/lookup/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order.couponCode).toBe("VERANO25");
    expect(res.body.order.couponDiscount).toBe(120);
    expect(res.body.order.couponId).toBeUndefined();
    // Los totales de la página de seguimiento tienen que cuadrar solos.
    const o = res.body.order;
    expect(o.total).toBe(o.subtotal - o.savings - o.couponDiscount + o.shipping);
  });
});

describe("mínimo cobrable con tarifa plana", () => {
  it("un 100% de descuento sigue dejando un total cobrable, porque el envío se cobra completo", async () => {
    // Este es el motivo por el que el guard de mínimo cobrable casi nunca se dispara en
    // producción: el descuento está acotado a la mercancía y la tarifa plana más baja son $100,
    // así que `total >= shipping` siempre. La lógica del guard en sí se prueba a nivel unitario
    // (`tests/unit/services/chargeableTotal.test.ts`), donde sí se puede provocar el caso.
    const product = await createProduct({
      type: "ropa",
      originalPrice: 20,
      salePrice: 20,
      sizes: { 25: 5 },
    });
    const coupon = await createCoupon({ code: "TODO", type: "percent", value: 100 });

    const res = await request(app)
      .post("/api/orders")
      .send({
        items: [{ productId: product.id, size: 25, quantity: 1 }],
        customer: validCustomer,
        couponCode: "TODO",
      });

    expect(res.status).toBe(201);
    expect(res.body.order.couponDiscount).toBe(20);
    expect(res.body.order.total).toBe(100);
    await coupon.reload();
    expect(coupon.redeemedCount).toBe(1);
  });
});

describe("Coupon.redeemedCount", () => {
  it("no lo mueve nada más que el canje: un preview repetido lo deja igual", async () => {
    const product = await bota();
    const coupon = await createCoupon({ code: "VERANO25", maxRedemptions: 5 });
    const body = {
      code: "VERANO25",
      items: [{ productId: product.id, size: 25, quantity: 1 }],
    };

    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post("/api/coupons/validate").send(body)).status).toBe(200);
    }

    const fresh = await Coupon.findByPk(coupon.id);
    expect(fresh!.redeemedCount).toBe(0);
  });
});
