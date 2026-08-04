/**
 * Pure unit — sin red. Cubre las ramas hard-require de `src/config/skydropx.ts`:
 * las tres credenciales OAuth/webhook y el loop de `SHIP_FROM_*` (una sola
 * iteración basta para cubrir la rama `if (!value) throw` del `for`, ya que las
 * ocho llaves comparten el mismo cuerpo).
 *
 * Se asigna `""` y no `delete`, mismo truco que `resend.test.ts`/`stripe.test.ts`:
 * el `dotenv.config()` propio del módulo no sobreescribe una key ya presente en
 * `process.env` (aunque esté vacía), así que no se repuebla desde el `.env` real.
 */
describe("config/skydropx", () => {
  const keys = [
    "SKYDROPX_CLIENT_ID",
    "SKYDROPX_CLIENT_SECRET",
    "SKYDROPX_WEBHOOK_SECRET",
    "SHIP_FROM_NEIGHBORHOOD",
  ] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;

  afterEach(() => {
    for (const k of keys) process.env[k] = originals[k];
  });

  it("truena al importar si falta SKYDROPX_CLIENT_ID", () => {
    process.env.SKYDROPX_CLIENT_ID = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/skydropx");
      });
    }).toThrow(/SKYDROPX_CLIENT_ID/);
  });

  it("truena al importar si falta SKYDROPX_CLIENT_SECRET", () => {
    process.env.SKYDROPX_CLIENT_SECRET = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/skydropx");
      });
    }).toThrow(/SKYDROPX_CLIENT_SECRET/);
  });

  it("truena al importar si falta SKYDROPX_WEBHOOK_SECRET", () => {
    process.env.SKYDROPX_WEBHOOK_SECRET = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/skydropx");
      });
    }).toThrow(/SKYDROPX_WEBHOOK_SECRET/);
  });

  it("truena al importar si falta cualquier SHIP_FROM_* (p. ej. SHIP_FROM_NEIGHBORHOOD)", () => {
    process.env.SHIP_FROM_NEIGHBORHOOD = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/skydropx");
      });
    }).toThrow(/SHIP_FROM_NEIGHBORHOOD/);
  });
});

describe("valores opcionales (SKYDROPX_BASE_URL, SKYDROPX_CARRIERS)", () => {
  const optionalKeys = ["SKYDROPX_BASE_URL", "SKYDROPX_CARRIERS"] as const;
  const originals = Object.fromEntries(optionalKeys.map((k) => [k, process.env[k]])) as Record<
    (typeof optionalKeys)[number],
    string | undefined
  >;

  afterEach(() => {
    for (const k of optionalKeys) process.env[k] = originals[k];
  });

  // `.env` (desarrollo) también define ambas, así que borrarlas no basta: el propio
  // `dotenv.config()` de skydropx.ts las repoblaría desde ahí y las ramas de abajo
  // nunca se ejecutarían. Se mockea `dotenv` para que no haga nada.
  function importFresh(): typeof import("../../../src/config/skydropx") {
    let mod: typeof import("../../../src/config/skydropx");
    jest.isolateModules(() => {
      jest.doMock("dotenv", () => ({ config: jest.fn() }));
      mod = require("../../../src/config/skydropx");
    });
    return mod!;
  }

  it("SKYDROPX_BASE_URL cae al host sandbox cuando no está definida", () => {
    delete process.env.SKYDROPX_BASE_URL;
    delete process.env.SKYDROPX_CARRIERS;

    expect(importFresh().SKYDROPX_BASE_URL).toBe("https://sb-pro.skydropx.com");
  });

  it("SKYDROPX_CARRIERS es undefined cuando no está definida (cotiza todas las paqueterías)", () => {
    delete process.env.SKYDROPX_CARRIERS;

    expect(importFresh().SKYDROPX_CARRIERS).toBeUndefined();
  });

  it("SKYDROPX_CARRIERS es undefined cuando solo trae comas/espacios vacíos", () => {
    process.env.SKYDROPX_CARRIERS = " , , ";

    expect(importFresh().SKYDROPX_CARRIERS).toBeUndefined();
  });
});
