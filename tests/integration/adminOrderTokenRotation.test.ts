import request from "supertest";

/**
 * Fase O.6 — rotación del código de rastreo público
 * (`POST /api/admin/orders/:id/rotate-token`).
 * Nivel 2 (integración HTTP, ver roadmap-testing.md): ruta → requireAuth → controlador →
 * servicio → Postgres real.
 *
 * Lo que esta suite defiende, y que es el motivo de la fase:
 *  1. El token viejo deja de resolver de inmediato en `GET /api/orders/lookup/:token` — es
 *     literalmente el punto de la fase (invalidar un link expuesto).
 *  2. Funciona sin importar `order.status`, a diferencia de `cancel`/`status`.
 *  3. La `idempotencyKey` del correo varía en cada rotación — con una key fija, Resend
 *     descartaría en silencio el correo de la segunda rotación en adelante.
 *
 * Se mockea `email.service` (nunca mandar un correo real por Resend), igual que
 * `adminOrderStatus.test.ts`.
 */
const sendEmailMock = jest.fn().mockResolvedValue(true);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createOrder, createOrderItem, createProduct, signToken } from "../setup/factories";
import { Order } from "../../src/models/Order";

const LOOKUP_NOT_FOUND_MESSAGE =
  "No encontramos ningún pedido con ese enlace. Revisa que esté completo o busca el correo de confirmación que te enviamos.";

let token: string;

beforeAll(async () => {
  await setupTestDatabase();
});
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(async () => {
  sendEmailMock.mockClear();
  const { user } = await createAdminUser();
  token = signToken(user);
});

/** El correo se dispara fire-and-forget; hay que esperarlo con polling real (I/O a Postgres). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Tiempo agotado esperando la condición del test.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Margen para que un segundo correo (si el guard fallara) alcance a llegar antes de afirmar. */
const EXTRA_EMAIL_WINDOW_MS = 100;

async function orderWithToken(overrides: Partial<Record<string, unknown>> = {}) {
  const product = await createProduct({ sizes: { 25: 3 } });
  const order = await createOrder({ status: "paid", paymentStatus: "paid" });
  await createOrderItem(order.id, product, { size: 25, quantity: 1 });
  await order.update({ publicToken: "3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13", ...overrides });
  return order;
}

function rotateToken(orderId: number) {
  return request(app)
    .post(`/api/admin/orders/${orderId}/rotate-token`)
    .set("Authorization", `Bearer ${token}`)
    .send();
}

function lookup(publicToken: string) {
  return request(app).get(`/api/orders/lookup/${publicToken}`);
}

describe("POST /api/admin/orders/:id/rotate-token — rota el token e invalida el viejo", () => {
  it("devuelve un publicToken distinto al anterior", async () => {
    const order = await orderWithToken();
    const oldToken = order.publicToken!;

    const res = await rotateToken(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.publicToken).toBeTruthy();
    expect(res.body.order.publicToken).not.toBe(oldToken);

    const reloaded = await Order.findByPk(order.id);
    expect(reloaded!.publicToken).toBe(res.body.order.publicToken);
  });

  it("el token viejo deja de resolver en la consulta pública de inmediato", async () => {
    const order = await orderWithToken();
    const oldToken = order.publicToken!;

    await rotateToken(order.id);

    const res = await lookup(oldToken);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(LOOKUP_NOT_FOUND_MESSAGE);
  });

  it("el token nuevo sí resuelve en la consulta pública", async () => {
    const order = await orderWithToken();

    const rotated = await rotateToken(order.id);
    const newToken = rotated.body.order.publicToken as string;

    const res = await lookup(newToken);
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(order.id);
  });
});

describe("POST /api/admin/orders/:id/rotate-token — funciona sin importar el estado", () => {
  it.each(["pending", "paid", "shipped", "delivered", "cancelled"] as const)(
    "rota el token de un pedido %s",
    async (status) => {
      const order = await orderWithToken({ status });

      const res = await rotateToken(order.id);

      expect(res.status).toBe(200);
      expect(res.body.order.publicToken).not.toBe("3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13");
    },
  );

  it("un pedido legado sin publicToken (null) también se puede rotar", async () => {
    const product = await createProduct({ sizes: { 25: 1 } });
    const order = await createOrder({ status: "paid", paymentStatus: "paid" });
    await createOrderItem(order.id, product, { size: 25, quantity: 1 });
    expect(order.publicToken).toBeNull();

    const res = await rotateToken(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.publicToken).toEqual(expect.any(String));
  });
});

describe("POST /api/admin/orders/:id/rotate-token — correo de rotación", () => {
  it("usa un asunto distinto al de confirmación/envío", async () => {
    const order = await orderWithToken();

    await rotateToken(order.id);

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(
      "Actualizamos tu código de rastreo — Botas Don Chuy Outlet",
    );
  });

  it("usa una idempotencyKey distinta entre dos rotaciones consecutivas del mismo pedido", async () => {
    const order = await orderWithToken();

    await rotateToken(order.id);
    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    const firstKey = sendEmailMock.mock.calls[0][0].idempotencyKey;

    sendEmailMock.mockClear();

    await rotateToken(order.id);
    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    const secondKey = sendEmailMock.mock.calls[0][0].idempotencyKey;

    expect(firstKey).toEqual(expect.any(String));
    expect(secondKey).not.toBe(firstKey);
  });

  it("el cuerpo del correo trae el token nuevo y no el viejo", async () => {
    const order = await orderWithToken();
    const oldToken = order.publicToken!;

    const rotated = await rotateToken(order.id);
    const newToken = rotated.body.order.publicToken as string;

    await waitFor(() => sendEmailMock.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, EXTRA_EMAIL_WINDOW_MS));
    const html = sendEmailMock.mock.calls[0][0].html as string;
    expect(html).toContain(newToken);
    expect(html).not.toContain(oldToken);
  });
});

describe("POST /api/admin/orders/:id/rotate-token — validación/auth", () => {
  it("un pedido inexistente responde 404 y un id no numérico 400", async () => {
    expect((await rotateToken(999999)).status).toBe(404);
    const bad = await request(app)
      .post("/api/admin/orders/abc/rotate-token")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(bad.status).toBe(400);
  });

  it("sin token responde 401", async () => {
    const order = await orderWithToken();

    const res = await request(app).post(`/api/admin/orders/${order.id}/rotate-token`).send();

    expect(res.status).toBe(401);
  });
});
