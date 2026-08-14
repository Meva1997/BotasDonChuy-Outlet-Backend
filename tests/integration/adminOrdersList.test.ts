import request from "supertest";

/**
 * `GET /api/admin/orders` y `POST /api/admin/orders/:id/cancel` **por HTTP** — Nivel 2.
 *
 * La cancelación/reembolso en sí ya está cubierta a nivel de servicio (`cancelOrder.test.ts`
 * llama a `cancelOrderByAdmin` directo, incluida la concurrencia). Lo que se prueba aquí es la
 * capa que ese test no toca y que el panel sí depende: el sobre paginado del listado, el clamp de
 * `page`, el filtro `date` —el único parámetro que el controlador interpreta por su cuenta— y que
 * las rutas exijan token, porque a diferencia de todo lo público estas devuelven `unitCost`.
 *
 * Stripe se mockea (cancelar un PaymentIntent y reembolsar cuestan dinero real); la BD no.
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

const sendEmailMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import app from "../../src/app";
import { sequelize } from "../../src/config/database";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import {
  createAdminUser,
  createOrder,
  createOrderItem,
  createProduct,
  signToken,
} from "../setup/factories";
import { Order } from "../../src/models/Order";
import { ProductSize } from "../../src/models/ProductSize";

let token: string;

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(async () => {
  sendEmailMock.mockClear();
  stripeMock.paymentIntents.cancel.mockReset().mockResolvedValue({});
  stripeMock.refunds.create.mockReset().mockResolvedValue({ id: "re_1" });
  const { user } = await createAdminUser();
  token = signToken(user);
});

/** Fija `createdAt` con SQL directo: Sequelize lo gestiona solo y un `update()` normal no lo mueve. */
async function setCreatedAt(orderId: number, moment: Date): Promise<void> {
  await sequelize.query(`UPDATE orders SET "createdAt" = :moment WHERE id = :id`, {
    replacements: { moment, id: orderId },
  });
}

async function stockOf(productId: number, size: number): Promise<number> {
  const row = await ProductSize.findOne({ where: { productId, size } });
  return row!.stock;
}

describe("GET /api/admin/orders — autenticación", () => {
  it("responde 401 sin token: el listado expone unitCost de cada línea", async () => {
    const res = await request(app).get("/api/admin/orders");

    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/orders — paginación", () => {
  it("devuelve el sobre paginado completo", async () => {
    await createOrder({ status: "paid", paymentStatus: "paid" });

    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        orders: expect.any(Array),
        total: 1,
        page: 1,
        perPage: 20,
        totalPages: 1,
      }),
    );
  });

  it("`total` cuenta pedidos y no filas unidas, aunque el pedido traiga varios items", async () => {
    // El motivo de que `total` salga de un `Order.count()` aparte: `findAndCountAll` con un
    // include `hasMany` contaría 3 aquí (una por item) y el panel pintaría 3 páginas de 1 pedido.
    const product = await createProduct({ sizes: { 25: 9 } });
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    await createOrderItem(order.id, product, { size: 26, quantity: 1 });
    await createOrderItem(order.id, product, { size: 27, quantity: 1 });

    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.totalPages).toBe(1);
    expect(res.body.orders[0].items).toHaveLength(3);
  });

  it("respeta perPage y calcula totalPages", async () => {
    await createOrder();
    await createOrder();
    await createOrder();

    const res = await request(app)
      .get("/api/admin/orders?perPage=2")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.orders).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it("clampa una página por encima del total a la última", async () => {
    await createOrder();
    await createOrder();

    const res = await request(app)
      .get("/api/admin/orders?perPage=1&page=999")
      .set("Authorization", `Bearer ${token}`);

    // Devolver la última página vale más que un arreglo vacío: el panel muestra algo en vez de
    // una tabla en blanco que se lee como "no hay pedidos".
    expect(res.body.page).toBe(2);
    expect(res.body.orders).toHaveLength(1);
  });

  it("clampa una página no positiva o no numérica a la primera", async () => {
    await createOrder();

    for (const query of ["page=0", "page=-5", "page=abc"]) {
      const res = await request(app)
        .get(`/api/admin/orders?${query}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.page).toBe(1);
    }
  });

  it("devuelve una página vacía coherente cuando no hay pedidos", async () => {
    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    // `totalPages` mínimo 1: un 0 haría que el clamp a [1, 0] devolviera page 0.
    expect(res.body).toEqual(
      expect.objectContaining({ orders: [], total: 0, page: 1, totalPages: 1 }),
    );
  });

  it("ordena del más reciente al más viejo", async () => {
    const viejo = await createOrder({ customerName: "Viejo" });
    await setCreatedAt(viejo.id, new Date("2026-01-01T10:00:00.000Z"));
    const nuevo = await createOrder({ customerName: "Nuevo" });
    await setCreatedAt(nuevo.id, new Date("2026-06-01T10:00:00.000Z"));

    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.orders.map((o: { customerName: string }) => o.customerName)).toEqual([
      "Nuevo",
      "Viejo",
    ]);
  });

  it("incluye los items con unitCost (las rutas admin sí exponen el costo)", async () => {
    const product = await createProduct({ unitCost: 400, sizes: { 25: 5 } });
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    const res = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.orders[0].items[0]).toEqual(
      expect.objectContaining({ unitCost: 400, nameSnapshot: product.name, quantity: 2 }),
    );
  });
});

describe("GET /api/admin/orders — filtro por día", () => {
  /** Dos pedidos en días UTC distintos, para poder afirmar que el filtro recorta de verdad. */
  async function twoOrdersOnDifferentDays() {
    const delDia = await createOrder({ customerName: "Del día" });
    await setCreatedAt(delDia.id, new Date("2026-03-15T12:00:00.000Z"));
    const otroDia = await createOrder({ customerName: "Otro día" });
    await setCreatedAt(otroDia.id, new Date("2026-03-16T12:00:00.000Z"));
    return { delDia, otroDia };
  }

  it("acota a los pedidos creados ese día UTC", async () => {
    await twoOrdersOnDifferentDays();

    const res = await request(app)
      .get("/api/admin/orders?date=2026-03-15")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.orders[0].customerName).toBe("Del día");
  });

  it("incluye los bordes del día (00:00:00.000 y 23:59:59.999)", async () => {
    const alFilo = await createOrder({ customerName: "Medianoche" });
    await setCreatedAt(alFilo.id, new Date("2026-03-15T00:00:00.000Z"));
    const alCierre = await createOrder({ customerName: "Último minuto" });
    await setCreatedAt(alCierre.id, new Date("2026-03-15T23:59:59.999Z"));
    const fuera = await createOrder({ customerName: "Día siguiente" });
    await setCreatedAt(fuera.id, new Date("2026-03-16T00:00:00.000Z"));

    const res = await request(app)
      .get("/api/admin/orders?date=2026-03-15")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(2);
    expect(res.body.orders.map((o: { customerName: string }) => o.customerName).sort()).toEqual([
      "Medianoche",
      "Último minuto",
    ]);
  });

  it("un día sin pedidos devuelve la página vacía, no todos los pedidos", async () => {
    await twoOrdersOnDifferentDays();

    const res = await request(app)
      .get("/api/admin/orders?date=2026-03-20")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(0);
    expect(res.body.orders).toEqual([]);
  });

  it("ignora un `date` con formato inválido en vez de romper la consulta", async () => {
    await twoOrdersOnDifferentDays();

    for (const date of ["hoy", "15-03-2026", "2026-3-5", ""]) {
      const res = await request(app)
        .get(`/api/admin/orders?date=${date}`)
        .set("Authorization", `Bearer ${token}`);

      // Sin el chequeo de formato, un `new Date("hoy")` daría `Invalid Date` y Postgres
      // rechazaría el rango con un 500. Se ignora y se devuelve todo, como el catálogo público.
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    }
  });

  it("combina el filtro de día con la paginación", async () => {
    const uno = await createOrder();
    await setCreatedAt(uno.id, new Date("2026-03-15T08:00:00.000Z"));
    const dos = await createOrder();
    await setCreatedAt(dos.id, new Date("2026-03-15T09:00:00.000Z"));
    const fuera = await createOrder();
    await setCreatedAt(fuera.id, new Date("2026-03-16T09:00:00.000Z"));

    const res = await request(app)
      .get("/api/admin/orders?date=2026-03-15&perPage=1")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(2); // el conteo también respeta el filtro
    expect(res.body.totalPages).toBe(2);
    expect(res.body.orders).toHaveLength(1);
  });
});

describe("GET /api/admin/orders — filtro por estado", () => {
  /** Un pedido en cada estado del panel, para poder afirmar que cada pestaña recorta de verdad. */
  async function oneOrderPerStatus() {
    const pendienteEnvio = await createOrder({
      customerName: "Pendiente de enviar",
      status: "paid",
      paymentStatus: "paid",
    });
    const enviado = await createOrder({
      customerName: "Enviado",
      status: "shipped",
      paymentStatus: "paid",
    });
    const entregado = await createOrder({
      customerName: "Entregado",
      status: "delivered",
      paymentStatus: "paid",
    });
    return { pendienteEnvio, enviado, entregado };
  }

  it("`estado=pendientes_envio` acota a los pedidos pagados que aún no avanzan", async () => {
    await oneOrderPerStatus();

    const res = await request(app)
      .get("/api/admin/orders?estado=pendientes_envio")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.orders[0].customerName).toBe("Pendiente de enviar");
  });

  it("`estado=pendientes_envio` ordena del que lleva más tiempo esperando al más reciente", async () => {
    // Al contrario del orden por defecto (más reciente primero): en esta pestaña se prioriza
    // despachar lo más viejo, así que el pedido con más tiempo esperando debe ir primero.
    const nuevo = await createOrder({
      customerName: "Nuevo",
      status: "paid",
      paymentStatus: "paid",
    });
    await setCreatedAt(nuevo.id, new Date("2026-06-01T10:00:00.000Z"));
    const viejo = await createOrder({
      customerName: "Viejo",
      status: "paid",
      paymentStatus: "paid",
    });
    await setCreatedAt(viejo.id, new Date("2026-01-01T10:00:00.000Z"));

    const res = await request(app)
      .get("/api/admin/orders?estado=pendientes_envio")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.orders.map((o: { customerName: string }) => o.customerName)).toEqual([
      "Viejo",
      "Nuevo",
    ]);
  });

  it("`estado=enviados` acota a los pedidos enviados que aún no se marcan entregados", async () => {
    await oneOrderPerStatus();

    const res = await request(app)
      .get("/api/admin/orders?estado=enviados")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.orders[0].customerName).toBe("Enviado");
  });

  it("`estado=entregados` acota a los pedidos entregados", async () => {
    await oneOrderPerStatus();

    const res = await request(app)
      .get("/api/admin/orders?estado=entregados")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.orders[0].customerName).toBe("Entregado");
  });

  it("sin `estado`, o con `estado=todos`, o con un valor no reconocido, no filtra por estado", async () => {
    await oneOrderPerStatus();

    for (const query of ["", "?estado=todos", "?estado=lo-que-sea"]) {
      const res = await request(app)
        .get(`/api/admin/orders${query}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.total).toBe(3);
    }
  });

  it("combina `estado` con `date`", async () => {
    const { enviado } = await oneOrderPerStatus();
    await setCreatedAt(enviado.id, new Date("2026-03-15T12:00:00.000Z"));

    const res = await request(app)
      .get("/api/admin/orders?estado=enviados&date=2026-03-15")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.total).toBe(1);
    expect(res.body.orders[0].customerName).toBe("Enviado");
  });
});

describe("POST /api/admin/orders/:id/cancel", () => {
  it("responde 401 sin token", async () => {
    const order = await createOrder();

    const res = await request(app).post(`/api/admin/orders/${order.id}/cancel`);

    expect(res.status).toBe(401);
  });

  it("responde 400 con un id no numérico (no un 500 de Postgres)", async () => {
    const res = await request(app)
      .post("/api/admin/orders/abc/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("responde 404 con un pedido inexistente", async () => {
    const res = await request(app)
      .post("/api/admin/orders/99999/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("cancela un pedido pending, repone su stock y cancela el PaymentIntent", async () => {
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({ paymentIntentId: "pi_pendiente" });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "El cliente lo pidió por WhatsApp" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_pendiente");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("acepta el body vacío (el motivo es opcional)", async () => {
    const order = await createOrder({ paymentIntentId: "pi_sin_motivo" });

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("cancelled");
  });

  it("reembolsa de verdad un pedido pagado antes de reponer el stock", async () => {
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      paymentIntentId: "pi_pagada",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.order.paymentStatus).toBe("refunded");
    // La clave de idempotencia es lo que evita el doble reembolso con dos cancelaciones a la vez.
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_pagada" }),
      expect.objectContaining({ idempotencyKey: `refund-order-${order.id}` }),
    );
    expect(await stockOf(product.id, 25)).toBe(5);
  });

  it("responde 409 con un pedido ya enviado (no se repone lo que ya salió)", async () => {
    const order = await createOrder({ status: "shipped", paymentStatus: "paid" });

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it("responde 409 con un pedido ya cancelado", async () => {
    const order = await createOrder({ status: "cancelled" });

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it("un reembolso fallido responde 502 y NO repone el stock ni cierra el pedido", async () => {
    // El dinero no volvió: reponer aquí dejaría el inventario mintiendo y el pedido cerrado
    // sin haber devuelto nada.
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      paymentIntentId: "pi_reembolso_falla",
    });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    stripeMock.refunds.create.mockRejectedValue(new Error("insufficient funds"));

    const res = await request(app)
      .post(`/api/admin/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("paid");
    expect(await stockOf(product.id, 25)).toBe(3);
  });
});
