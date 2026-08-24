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
    // `process.env[k] = undefined` guarda la CADENA "undefined", no borra la variable: sin el
    // `delete`, las suites siguientes cargarían stripe.ts con basura en estos knobs.
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  // `.env` (desarrollo) también define estas tres, así que borrarlas no basta: el propio
  // `dotenv.config()` de stripe.ts las repoblaría desde ahí y las ramas del default nunca se
  // ejecutarían. Se mockea `dotenv` para que no haga nada.
  const loadWithoutDotenv = (): typeof import("../../../src/config/stripe") => {
    let mod: typeof import("../../../src/config/stripe");
    jest.isolateModules(() => {
      jest.doMock("dotenv", () => ({ config: jest.fn() }));
      mod = require("../../../src/config/stripe");
    });
    return mod!;
  };

  it("caen a mxn/30/10 cuando no están definidas", () => {
    for (const k of keys) delete process.env[k];

    const mod = loadWithoutDotenv();

    expect(mod.STRIPE_CURRENCY).toBe("mxn");
    expect(mod.PENDING_ORDER_TTL_MINUTES).toBe(30);
    expect(mod.PENDING_ORDER_SWEEP_INTERVAL_MINUTES).toBe(10);
  });

  /**
   * Estos dos son la razón de que los knobs pasaran a `positiveNumberEnv`: con el
   * `Number(process.env.X ?? N)` de antes, una línea vacía en el `.env` de producción daba `0`
   * y un valor mal tecleado `NaN`. Un `0`/`NaN` de intervalo convierte el `setInterval` del
   * sweeper en un bucle contra la base de datos y contra Stripe; un `0` de TTL hace que toda
   * orden `pending` cuente como vencida en el acto.
   */
  it("una variable vacía cae al default en vez de valer 0", () => {
    for (const k of keys) delete process.env[k];
    process.env.PENDING_ORDER_TTL_MINUTES = "";
    process.env.PENDING_ORDER_SWEEP_INTERVAL_MINUTES = "   ";

    const mod = loadWithoutDotenv();

    expect(mod.PENDING_ORDER_TTL_MINUTES).toBe(30);
    expect(mod.PENDING_ORDER_SWEEP_INTERVAL_MINUTES).toBe(10);
  });

  it.each(["abc", "0", "-5"])(
    'una variable con "%s" cae al default y avisa, en vez de valer NaN/0',
    (value) => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      for (const k of keys) delete process.env[k];
      process.env.PENDING_ORDER_TTL_MINUTES = value;
      process.env.PENDING_ORDER_SWEEP_INTERVAL_MINUTES = value;

      const mod = loadWithoutDotenv();

      expect(mod.PENDING_ORDER_TTL_MINUTES).toBe(30);
      expect(mod.PENDING_ORDER_SWEEP_INTERVAL_MINUTES).toBe(10);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    },
  );
});

/**
 * La versión de la API va FIJADA (punto 14 de docs/PRE-PRODUCCION.md). Hoy coincide con la que
 * el SDK manda por su cuenta, así que este test no vigila el runtime sino el contrato: si un
 * `pnpm update` de `stripe` mueve la versión, `pnpm build` ya falla (el tipo del literal) y este
 * test acompaña con el motivo. Subirla obliga a revisar la forma de los objetos que leen
 * `markOrderPaidFromWebhook` y `applyDisputeFromWebhook`.
 */
describe("versión de la API de Stripe fijada", () => {
  it("el cliente compartido usa STRIPE_API_VERSION y no la que le toque al SDK", () => {
    const {
      stripe,
      STRIPE_API_VERSION,
    } = require("../../../src/config/stripe") as typeof import("../../../src/config/stripe");

    expect(STRIPE_API_VERSION).toBe("2026-06-24.dahlia");
    expect(stripe.getApiField("version")).toBe(STRIPE_API_VERSION);
  });
});
