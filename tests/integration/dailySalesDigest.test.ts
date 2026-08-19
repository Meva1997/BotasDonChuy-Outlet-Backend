/**
 * Fase N.4 — resumen diario de ventas. Nivel 2/3: se llama al servicio contra una BD de test real,
 * porque lo que hay que probar es **qué pedidos entran en la ventana**, y eso es un `WHERE` de
 * Postgres sobre `createdAt` con un rango calculado en hora de la tienda (UTC−6). Un mock de
 * Sequelize probaría el mock, no el corte.
 *
 * `email.service` mockeado (nunca mandar un correo real).
 */
const sendEmailMock = jest.fn().mockResolvedValue(true);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createOrder, createProduct, createOrderItem } from "../setup/factories";
import {
  resetDailySalesDigestState,
  runDigestTick,
  sendDailySalesDigest,
} from "../../src/services/dailySalesDigest";

const OWNER_EMAIL = "duenio@botasdonchuy.test";

/** El día que cubren los casos. 2026-07-29 fue miércoles. */
const DAY = "2026-07-29";
/** Mediodía local del día objetivo (18:00 UTC). */
const MIDDAY = new Date("2026-07-29T18:00:00Z");
/** 23:30 locales del día objetivo: dentro por poco. */
const LATE_SAME_DAY = new Date("2026-07-30T05:30:00Z");
/** 00:30 locales del día siguiente: fuera por poco. */
const EARLY_NEXT_DAY = new Date("2026-07-30T06:30:00Z");

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  sendEmailMock.mockClear();
  resetDailySalesDigestState();
  process.env.OWNER_NOTIFICATION_EMAIL = OWNER_EMAIL;
});

afterEach(() => {
  delete process.env.OWNER_NOTIFICATION_EMAIL;
  jest.useRealTimers();
});

/** El único correo mandado, o falla el test. */
function theDigest() {
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  return sendEmailMock.mock.calls[0][0];
}

async function paidOrder(overrides: Parameters<typeof createOrder>[0] = {}) {
  const order = await createOrder({
    status: "paid",
    paymentStatus: "paid",
    createdAt: MIDDAY,
    subtotal: 800,
    shipping: 150,
    ...overrides,
  });
  const product = await createProduct({ sizes: { 25: 5 } });
  await createOrderItem(order.id, product, { size: 25, quantity: 2 });
  return order;
}

describe("sendDailySalesDigest — ventana del día (Fase N.4)", () => {
  it("incluye un pedido de las 23:30 locales y excluye uno de las 00:30 del día siguiente", async () => {
    // EL caso que justifica todo el archivo `storeDay.ts`: en UTC estas dos marcas caen el mismo
    // día (30 de julio), así que una ventana calculada en UTC dejaría fuera la venta de la noche
    // —horario pico— y metería una que ya es del día siguiente.
    const dentro = await paidOrder({ createdAt: LATE_SAME_DAY, customerName: "Venta nocturna" });
    await paidOrder({ createdAt: EARLY_NEXT_DAY, customerName: "Venta del día siguiente" });

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.html).toContain(`#${dentro.id}`);
    expect(digest.html).toContain("Venta nocturna");
    expect(digest.html).not.toContain("Venta del día siguiente");
    expect(digest.subject).toContain("1 venta");
  });

  it("un pedido ya enviado el mismo día sigue contando (regresión del filtro por status)", async () => {
    // Es la razón por la que este resumen filtra `paymentStatus` y no `status`: el `status` avanza
    // a `shipped`/`delivered` en cuanto sale la guía, y con `status: "paid"` le faltarían justo los
    // pedidos que ya se despacharon ese día — lo peor que le puede pasar a un correo cuyo trabajo
    // es cuadrar el día.
    const enviado = await paidOrder({ status: "shipped", customerName: "Ya despachado" });
    const entregado = await paidOrder({ status: "delivered", customerName: "Ya entregado" });

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.html).toContain(`#${enviado.id}`);
    expect(digest.html).toContain(`#${entregado.id}`);
    expect(digest.subject).toContain("2 ventas");
  });

  it("un pedido cancelado/reembolsado no cuenta", async () => {
    await paidOrder({ customerName: "Venta buena" });
    await paidOrder({
      status: "cancelled",
      paymentStatus: "refunded",
      customerName: "Reembolsada",
    });
    await paidOrder({ status: "pending", paymentStatus: "unpaid", customerName: "Sin pagar" });

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.html).toContain("Venta buena");
    expect(digest.html).not.toContain("Reembolsada");
    expect(digest.html).not.toContain("Sin pagar");
    expect(digest.subject).toContain("1 venta");
  });

  it("suma piezas, ingreso, envío y descuentos del día", async () => {
    await paidOrder({ subtotal: 800, shipping: 150, savings: 100 });
    await paidOrder({ subtotal: 600, shipping: 150, couponCode: "VERANO25", couponDiscount: 50 });

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    // 2 pedidos × 2 piezas.
    expect(digest.html).toContain("Piezas vendidas");
    // (800−100+150) + (600−50+150) = 850 + 700 = 1550
    expect(digest.subject).toContain("$1,550.00");
    expect(digest.html).toContain("Descuento por cupón");
  });

  it("un día sin ventas se manda igual, para que no se confunda con un cron caído", async () => {
    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.subject).toContain("sin ventas");
    expect(digest.html).toContain("No hubo ventas");
    expect(digest.idempotencyKey).toBe(`daily-sales/${DAY}`);
  });

  it("señala los pedidos que requieren acción (sin guía o con dropoff)", async () => {
    const sinGuia = await paidOrder({ skydropxShipmentId: null });
    const conDropoff = await paidOrder({
      skydropxShipmentId: "shp_ok",
      shippingRequiresDropoff: true,
    });
    await paidOrder({ skydropxShipmentId: "shp_listo" }); // sin pendientes

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.html).toContain("Requieren acción");
    expect(digest.html).toContain(`Pedido <strong>#${sinGuia.id}</strong>: todavía sin guía`);
    expect(digest.html).toContain(`Pedido <strong>#${conDropoff.id}</strong>`);
    expect(digest.html).toContain("llevarlo a la sucursal");
  });

  it("lista los artículos vendidos, agrupando el mismo modelo/talla/precio en una sola línea", async () => {
    const order = await createOrder({
      status: "paid",
      paymentStatus: "paid",
      createdAt: MIDDAY,
      subtotal: 800,
      shipping: 150,
    });
    const botas = await createProduct({ name: "Bota Alta Café", sizes: { 26: 5 } });
    const sombrero = await createProduct({ name: "Sombrero Tejano", sizes: { 58: 3 } });
    // Dos renglones del mismo modelo/talla: deben colapsar en una sola línea con cantidad 3 (1+2).
    await createOrderItem(order.id, botas, { size: 26, quantity: 1 });
    await createOrderItem(order.id, botas, { size: 26, quantity: 2 });
    // Modelo distinto: aparece como su propia línea.
    await createOrderItem(order.id, sombrero, { size: 58, quantity: 1 });

    await sendDailySalesDigest(DAY);

    const digest = theDigest();
    expect(digest.html).toContain("3 piezas · Bota Alta Café · talla 26");
    expect(digest.html).toContain("1 pieza · Sombrero Tejano · talla 58");
  });

  it("no menciona el día anterior: cada correo reporta solo el día que cubre", async () => {
    await paidOrder({ createdAt: MIDDAY, subtotal: 800, shipping: 150 });
    await paidOrder({
      createdAt: new Date("2026-07-28T18:00:00Z"), // día anterior
      subtotal: 200,
      shipping: 150,
    });

    await sendDailySalesDigest(DAY);

    expect(theDigest().html).not.toContain("Día anterior");
  });

  it("sin destinatario configurado no manda nada", async () => {
    delete process.env.OWNER_NOTIFICATION_EMAIL;
    await paidOrder();

    await sendDailySalesDigest(DAY);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("runDigestTick — programación (Fase N.4)", () => {
  it("no manda nada antes de la hora configurada", async () => {
    // 07:00 locales del 30 = 13:00 UTC, todavía antes de las 8.
    await runDigestTick(new Date("2026-07-30T13:00:00Z"));

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("pasada la hora manda el resumen del día ANTERIOR, ya cerrado y completo", async () => {
    const ayer = await paidOrder({ createdAt: MIDDAY, customerName: "Venta de ayer" });
    // Una venta de hoy no debe aparecer: el resumen cubre el día que ya cerró.
    await paidOrder({ createdAt: new Date("2026-07-30T15:00:00Z"), customerName: "Venta de hoy" });

    // 08:30 locales del 30 = 14:30 UTC.
    await runDigestTick(new Date("2026-07-30T14:30:00Z"));

    const digest = theDigest();
    expect(digest.idempotencyKey).toBe(`daily-sales/${DAY}`);
    expect(digest.html).toContain(`#${ayer.id}`);
    expect(digest.html).not.toContain("Venta de hoy");
  });

  it("dos ticks el mismo día mandan un solo resumen", async () => {
    await runDigestTick(new Date("2026-07-30T14:30:00Z"));
    await runDigestTick(new Date("2026-07-30T14:45:00Z"));
    await runDigestTick(new Date("2026-07-30T20:00:00Z"));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("al día siguiente vuelve a mandar, con el día nuevo", async () => {
    await runDigestTick(new Date("2026-07-30T14:30:00Z"));
    await runDigestTick(new Date("2026-07-31T14:30:00Z"));

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[0][0].idempotencyKey).toBe("daily-sales/2026-07-29");
    expect(sendEmailMock.mock.calls[1][0].idempotencyKey).toBe("daily-sales/2026-07-30");
  });

  it("tras una caída de varios días manda solo el más reciente, no un backfill", async () => {
    // Simplificación deliberada: el histórico completo vive en el dashboard, y una ráfaga de
    // resúmenes viejos al volver de una caída no le sirve a nadie.
    await runDigestTick(new Date("2026-08-05T14:30:00Z"));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(theDigest().idempotencyKey).toBe("daily-sales/2026-08-04");
  });
});
