/**
 * Pure unit — sin red. Cubre las dos ramas hard-require de `src/config/stripe.ts`
 * (`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` ausentes) reimportando el módulo
 * con `jest.isolateModules` para cada caso.
 *
 * Se asigna `""` y no `delete`, mismo truco que `resend.test.ts`/`sentry.test.ts`:
 * el `dotenv.config()` propio de stripe.ts no sobreescribe una key ya presente en
 * `process.env` (aunque esté vacía), así que no se repuebla desde el `.env` real.
 */
describe("config/stripe", () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = originalSecretKey;
    process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  });

  it("truena al importar si falta STRIPE_SECRET_KEY", () => {
    process.env.STRIPE_SECRET_KEY = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/stripe");
      });
    }).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("truena al importar si falta STRIPE_WEBHOOK_SECRET", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/stripe");
      });
    }).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});

describe("valores por defecto (STRIPE_CURRENCY, PENDING_ORDER_*)", () => {
  const keys = [
    "STRIPE_CURRENCY",
    "PENDING_ORDER_TTL_MINUTES",
    "PENDING_ORDER_SWEEP_INTERVAL_MINUTES",
  ] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;

  afterEach(() => {
    for (const k of keys) process.env[k] = originals[k];
  });

  it("caen a mxn/30/10 cuando no están definidas", () => {
    // `.env` (desarrollo) también define estas tres, así que borrarlas no basta: el
    // propio `dotenv.config()` de stripe.ts las repoblaría desde ahí y las ramas `??`
    // nunca se ejecutarían. Se mockea `dotenv` para que no haga nada.
    for (const k of keys) delete process.env[k];

    let mod: typeof import("../../../src/config/stripe");
    jest.isolateModules(() => {
      jest.doMock("dotenv", () => ({ config: jest.fn() }));
      mod = require("../../../src/config/stripe");
    });

    expect(mod!.STRIPE_CURRENCY).toBe("mxn");
    expect(mod!.PENDING_ORDER_TTL_MINUTES).toBe(30);
    expect(mod!.PENDING_ORDER_SWEEP_INTERVAL_MINUTES).toBe(10);
  });
});
