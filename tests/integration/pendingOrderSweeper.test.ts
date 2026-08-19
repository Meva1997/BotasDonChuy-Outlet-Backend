/**
 * Barrido de órdenes `pending` vencidas (`pendingOrderSweeper.ts`).
 *
 * Nivel 3 (servicio + SDK mockeado, ver roadmap-testing.md): se llama a `sweepOnce`
 * directo contra una BD de test real con Stripe mockeado — lo que se prueba es la
 * decisión de reponer o no el stock, y eso son UPDATEs de verdad sobre `product_sizes`.
 *
 * `startPendingOrderSweeper` no arranca en `NODE_ENV=test` (timer desactivado a
 * propósito), así que la suite ejecuta un ciclo suelto.
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

const sendEmailMock = jest.fn().mockResolvedValue(true);
jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));

import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct, createOrder, createOrderItem } from "../setup/factories";
import { Order } from "../../src/models/Order";
import { ProductSize } from "../../src/models/ProductSize";
import {
  sweepOnce,
  startPendingOrderSweeper,
  stopPendingOrderSweeper,
  resetPendingOrderFailures,
} from "../../src/services/pendingOrderSweeper";

beforeAll(async () => {
  await setupTestDatabase();
  // `sendAlertEmail` no-opea sin destino configurado, y los casos de fallo repetido afirman
  // justo sobre esa alerta.
  process.env.ALERT_EMAIL_TO = "alertas@test.com";
});
afterEach(truncateAll);
afterAll(async () => {
  delete process.env.ALERT_EMAIL_TO;
  await closeTestDatabase();
});

beforeEach(() => {
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.paymentIntents.cancel.mockReset().mockResolvedValue({});
  sendEmailMock.mockClear();
  // El contador de fallos vive en el módulo y sobrevive a `truncateAll`; los SERIAL sí se
  // reinician, así que sin esto un caso heredaría los fallos que otro dejó para el mismo id.
  resetPendingOrderFailures();
});

/** Envejece la orden más allá del TTL para que el barrido la alcance. */
async function ageOrder(order: Order, minutes = 60): Promise<void> {
  await Order.update(
    { createdAt: new Date(Date.now() - minutes * 60_000) } as any,
    { where: { id: order.id }, silent: true },
  );
}

/**
 * Una orden `pending` con stock reservado, tal como la deja `createOrder`: la fila
 * `product_sizes` ya viene descontada (5 − 2 = 3).
 */
async function createStaleOrder(paymentIntentId: string | null) {
  const product = await createProduct({ sizes: { 25: 3 } });
  const order = await createOrder({ paymentIntentId });
  await createOrderItem(order.id, product, { size: 25, quantity: 2 });
  await ageOrder(order);
  return { product, order };
}

async function stockOf(productId: number, size: number): Promise<number> {
  const row = await ProductSize.findOne({ where: { productId, size } });
  return row!.stock;
}

describe("sweepOnce", () => {
  it("repone el stock de una orden pending que nunca llegó a tener PaymentIntent", async () => {
    // El caso que este barrido no alcanzaba antes: Stripe falló después de que la orden
    // ya estaba escrita y con su stock descontado, así que no hay PaymentIntent que
    // conciliar ni webhook que vaya a llegar — sin esto el stock quedaba reservado para
    // siempre.
    const { product, order } = await createStaleOrder(null);

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("cancela el PaymentIntent y repone el stock de una orden vencida sin pagar", async () => {
    const { product, order } = await createStaleOrder("pi_abandonada");
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_abandonada",
      status: "requires_payment_method",
    });

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_abandonada");
  });

  it("NO repone el stock si el PaymentIntent sí está pagado: la marca paid", async () => {
    const { product, order } = await createStaleOrder("pi_pagada");
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_pagada",
      status: "succeeded",
    });

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("paid");
    expect(await stockOf(product.id, 25)).toBe(3); // sigue reservado, se vendió
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("no toca una orden pending que todavía está dentro del TTL", async () => {
    const product = await createProduct({ sizes: { 25: 3 } });
    const order = await createOrder({ paymentIntentId: null });
    await createOrderItem(order.id, product, { size: 25, quantity: 2 });
    // Sin envejecer: el comprador podría estar pagando en este momento.

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("pending");
    expect(await stockOf(product.id, 25)).toBe(3);
  });

  it("repone el stock aunque Stripe rechace cancelar el PaymentIntent", async () => {
    // Un PaymentIntent ya cancelado (o en un estado no cancelable) hace que Stripe lance. Eso
    // NO debe impedir la reposición: el intent ya no va a cobrarse y el stock es lo que urge
    // liberar. Por eso el cancel vive en su propio try.
    const { product, order } = await createStaleOrder("pi_no_cancelable");
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_no_cancelable",
      status: "requires_payment_method",
    });
    stripeMock.paymentIntents.cancel.mockRejectedValue(
      new Error("You cannot cancel this PaymentIntent"),
    );

    await sweepOnce();

    const refreshed = await Order.findByPk(order.id);
    expect(refreshed!.status).toBe("cancelled");
    expect(await stockOf(product.id, 25)).toBe(5);
  });

  it("un fallo con una orden no frena el barrido de las demás", async () => {
    // Se procesan en el orden que devuelve el findAll; la que truena no puede dejar sin barrer
    // a la otra, o una sola orden problemática congelaría el stock de toda la tienda.
    const rota = await createStaleOrder("pi_rota");
    const sana = await createStaleOrder("pi_sana");
    stripeMock.paymentIntents.retrieve.mockImplementation(async (id: string) => {
      if (id === "pi_rota") throw new Error("Stripe API is down");
      return { id, status: "requires_payment_method" };
    });

    await sweepOnce();

    expect((await Order.findByPk(rota.order.id))!.status).toBe("pending"); // sigue esperando
    expect((await Order.findByPk(sana.order.id))!.status).toBe("cancelled");
    expect(await stockOf(sana.product.id, 25)).toBe(5);
  });
});

describe("sweepOnce — alerta por fallos repetidos", () => {
  it("alerta UNA sola vez al tercer fallo consecutivo, no en cada ciclo", async () => {
    const { order } = await createStaleOrder("pi_siempre_falla");
    stripeMock.paymentIntents.retrieve.mockRejectedValue(new Error("Stripe API is down"));

    await sweepOnce();
    await sweepOnce();
    expect(sendEmailMock).not.toHaveBeenCalled(); // dos fallos aún no cruzan el umbral

    await sweepOnce();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain(`#${order.id}`);

    // Cuarto y quinto ciclo: sigue fallando, pero el dueño ya fue avisado. Una alerta por ciclo
    // cada 10 min sería spam que se termina ignorando.
    await sweepOnce();
    await sweepOnce();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("olvida el contador de una orden que sale de la ventana de pendientes vencidas", async () => {
    const { order } = await createStaleOrder("pi_intermitente");
    stripeMock.paymentIntents.retrieve.mockRejectedValue(new Error("Stripe API is down"));

    await sweepOnce();
    await sweepOnce(); // 2 fallos acumulados

    // La orden se resuelve por otra vía (el webhook llega tarde y la marca pagada): deja de ser
    // candidata y el barrido debe olvidar su contador para que el Map no crezca sin límite.
    await Order.update({ status: "paid", paymentStatus: "paid" }, { where: { id: order.id } });
    await sweepOnce();

    // Vuelve a quedar pendiente y vencida, y falla una vez más. Si el contador se hubiera
    // conservado, este sería el tercer fallo y dispararía la alerta.
    await Order.update({ status: "pending", paymentStatus: "unpaid" }, { where: { id: order.id } });
    await ageOrder(order);
    await sweepOnce();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("un ciclo exitoso reinicia la cuenta de fallos", async () => {
    const { order } = await createStaleOrder("pi_se_recupera");
    stripeMock.paymentIntents.retrieve.mockRejectedValue(new Error("Stripe API is down"));

    await sweepOnce();
    await sweepOnce(); // 2 fallos

    // Stripe se recupera y la orden se concilia bien.
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_se_recupera",
      status: "requires_payment_method",
    });
    await sweepOnce();
    expect((await Order.findByPk(order.id))!.status).toBe("cancelled");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("startPendingOrderSweeper / stopPendingOrderSweeper", () => {
  /**
   * El timer se salta bajo `NODE_ENV=test` a propósito (una suite no debe arrancar crons), así
   * que para ejercitar el arranque real hay que fingir otro entorno. Se restaura siempre.
   */
  async function withProductionEnv(fn: () => Promise<void> | void): Promise<void> {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await fn();
    } finally {
      process.env.NODE_ENV = original;
      stopPendingOrderSweeper();
    }
  }

  it("no arranca ningún timer bajo NODE_ENV=test", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");

    startPendingOrderSweeper();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("arranca un timer periódico y lo deja sin retener el proceso", async () => {
    await withProductionEnv(() => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");

      startPendingOrderSweeper();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      // 10 min por defecto (PENDING_ORDER_SWEEP_INTERVAL_MINUTES).
      expect(setIntervalSpy.mock.calls[0][1]).toBe(10 * 60_000);
      // `unref()` es lo que evita que el cron por sí solo mantenga vivo el proceso al apagarse.
      const timer = setIntervalSpy.mock.results[0].value as NodeJS.Timeout;
      expect(typeof timer.unref).toBe("function");
      setIntervalSpy.mockRestore();
    });
  });

  it("es idempotente: dos arranques no dejan dos timers corriendo", async () => {
    await withProductionEnv(() => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");

      startPendingOrderSweeper();
      startPendingOrderSweeper();

      // Dos timers barrerían el doble y duplicarían las llamadas a Stripe.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });
  });

  it("stop detiene el timer y puede volver a arrancarse", async () => {
    await withProductionEnv(() => {
      const clearIntervalSpy = jest.spyOn(global, "clearInterval");

      startPendingOrderSweeper();
      stopPendingOrderSweeper();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      // Tras detenerse, el flag queda libre: un arranque posterior vuelve a crear el timer.
      const setIntervalSpy = jest.spyOn(global, "setInterval");
      startPendingOrderSweeper();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });
  });

  it("stop es idempotente: no falla si nunca arrancó o ya se detuvo", () => {
    // Lo llama el apagado ordenado, que puede correr sin que el cron haya arrancado nunca.
    expect(() => {
      stopPendingOrderSweeper();
      stopPendingOrderSweeper();
    }).not.toThrow();
  });
});
