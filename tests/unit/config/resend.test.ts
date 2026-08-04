/**
 * Pure unit — sin red. Cubre las dos ramas hard-require de `src/config/resend.ts`
 * (`RESEND_API_KEY` / `EMAIL_FROM` ausentes) reimportando el módulo con
 * `jest.isolateModules` para cada caso.
 *
 * Se asigna `""` y no `delete`: el `dotenv.config()` propio de resend.ts (sin
 * `override`) no sobreescribe una key ya presente en `process.env` aunque esté
 * vacía, así que no se repuebla desde el `.env` real de desarrollo (mismo truco que
 * `sentry.test.ts` usa para `SENTRY_DSN`) — y `""` sigue siendo falsy para el `if (!x)`.
 */
describe("config/resend", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;

  afterEach(() => {
    process.env.RESEND_API_KEY = originalApiKey;
    process.env.EMAIL_FROM = originalFrom;
  });

  it("truena al importar si falta RESEND_API_KEY", () => {
    process.env.RESEND_API_KEY = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/resend");
      });
    }).toThrow(/RESEND_API_KEY/);
  });

  it("truena al importar si falta EMAIL_FROM", () => {
    process.env.EMAIL_FROM = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/resend");
      });
    }).toThrow(/EMAIL_FROM/);
  });
});

describe("FRONTEND_URL", () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it("cae a http://localhost:3000 cuando no está definida", () => {
    // `.env` (desarrollo) también define FRONTEND_URL, así que solo borrar la variable
    // no basta: el propio `dotenv.config()` de resend.ts la repoblaría desde ahí y la
    // rama `?? "..."` nunca se ejecutaría. Se mockea `dotenv` para que no haga nada.
    delete process.env.FRONTEND_URL;

    let mod: typeof import("../../../src/config/resend");
    jest.isolateModules(() => {
      jest.doMock("dotenv", () => ({ config: jest.fn() }));
      mod = require("../../../src/config/resend");
    });

    expect(mod!.FRONTEND_URL).toBe("http://localhost:3000");
  });
});
