/**
 * Pure unit — sin red ni BD. Cubre la rama hard-require de `src/config/auth.ts`
 * (`JWT_SECRET` ausente/vacía) y el default explícito de `JWT_EXPIRES_IN`,
 * reimportando el módulo con `jest.isolateModules` para cada caso.
 *
 * Se asigna `""` y no `delete`, mismo truco que `stripe.test.ts`/`resend.test.ts`:
 * el `dotenv.config()` propio de auth.ts no sobreescribe una key ya presente en
 * `process.env` (aunque esté vacía), así que no se repuebla desde el `.env` real.
 */
describe("config/auth — hard-require de JWT_SECRET", () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    // `process.env[k] = undefined` guarda la CADENA "undefined", no borra la variable.
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it("truena al importar si falta JWT_SECRET", () => {
    process.env.JWT_SECRET = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/auth");
      });
    }).toThrow(/JWT_SECRET/);
  });

  it("truena si JWT_SECRET es solo espacios (no firma con un secreto vacío)", () => {
    process.env.JWT_SECRET = "   ";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/auth");
      });
    }).toThrow(/JWT_SECRET/);
  });

  it("exporta el secreto recortado cuando está bien configurada", () => {
    process.env.JWT_SECRET = "  un-secreto-de-prueba  ";

    jest.isolateModules(() => {
      const { JWT_SECRET } = require("../../../src/config/auth");
      expect(JWT_SECRET).toBe("un-secreto-de-prueba");
    });
  });
});

describe("config/auth — default de JWT_EXPIRES_IN", () => {
  const keys = ["JWT_SECRET", "JWT_EXPIRES_IN"] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;

  beforeEach(() => {
    process.env.JWT_SECRET = "secreto-para-estas-pruebas";
  });

  afterEach(() => {
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k]!;
    }
  });

  it("cae a 7d cuando JWT_EXPIRES_IN está vacía — un token sin expiración no se puede revocar", () => {
    process.env.JWT_EXPIRES_IN = "";

    jest.isolateModules(() => {
      const { JWT_EXPIRES_IN } = require("../../../src/config/auth");
      expect(JWT_EXPIRES_IN).toBe("7d");
    });
  });

  it("cae a 7d cuando JWT_EXPIRES_IN es solo espacios", () => {
    process.env.JWT_EXPIRES_IN = "   ";

    jest.isolateModules(() => {
      const { JWT_EXPIRES_IN } = require("../../../src/config/auth");
      expect(JWT_EXPIRES_IN).toBe("7d");
    });
  });

  it("respeta el valor configurado", () => {
    process.env.JWT_EXPIRES_IN = "2h";

    jest.isolateModules(() => {
      const { JWT_EXPIRES_IN } = require("../../../src/config/auth");
      expect(JWT_EXPIRES_IN).toBe("2h");
    });
  });
});
