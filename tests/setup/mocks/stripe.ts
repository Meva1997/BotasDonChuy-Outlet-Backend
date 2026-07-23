/**
 * Mock reutilizable del cliente Stripe (`src/config/stripe`). Scaffolding para las
 * partes 3 (checkout) y 4 (webhooks): ningún test debe llamar a Stripe de verdad.
 *
 * Uso en un test (el `jest.mock` va en el propio archivo de test, no aquí, por el
 * hoisting de Jest):
 *
 *   import { buildStripeMock } from "../setup/mocks/stripe";
 *   const stripeMock = buildStripeMock();
 *   jest.mock("../../src/config/stripe", () => ({
 *     stripe: stripeMock,
 *     STRIPE_WEBHOOK_SECRET: "whsec_test",
 *     STRIPE_CURRENCY: "mxn",
 *     PENDING_ORDER_TTL_MINUTES: 30,
 *     PENDING_ORDER_SWEEP_INTERVAL_MINUTES: 10,
 *   }));
 */
export function buildStripeMock() {
  return {
    paymentIntents: {
      create: jest.fn(),
      cancel: jest.fn(),
      retrieve: jest.fn(),
    },
    refunds: {
      create: jest.fn(),
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };
}
