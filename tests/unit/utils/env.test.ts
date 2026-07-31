import { positiveNumberEnv, trustProxyEnv } from "../../../src/utils/env";

/**
 * Nivel 1 (sin BD): `Number(process.env.X ?? 15)` deja pasar dos valores que parecen configuración
 * válida y no lo son — `""` → `0` y `"abc"` → `NaN`. En los knobs de la Fase O.3 eso cuesta dinero:
 * un `0` en el margen del centinela hace que una creación reclamada hace milisegundos cuente como
 * huérfana, y un reintento concurrente pagaría una segunda guía.
 */
describe("positiveNumberEnv", () => {
  const VAR = "TEST_POSITIVE_ENV";
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[VAR];
    warnSpy.mockRestore();
  });

  it("usa el valor cuando es un número positivo válido", () => {
    process.env[VAR] = "30";
    expect(positiveNumberEnv(VAR, 15)).toBe(30);

    process.env[VAR] = " 7.5 ";
    expect(positiveNumberEnv(VAR, 15)).toBe(7.5);
  });

  it("cae al default cuando la variable no está definida", () => {
    expect(positiveNumberEnv(VAR, 15)).toBe(15);
    expect(warnSpy).not.toHaveBeenCalled(); // ausente es normal, no hay nada que avisar
  });

  it("cae al default con la variable vacía o solo espacios (antes daba 0)", () => {
    process.env[VAR] = "";
    expect(positiveNumberEnv(VAR, 15)).toBe(15);

    process.env[VAR] = "   ";
    expect(positiveNumberEnv(VAR, 15)).toBe(15);
  });

  it.each(["abc", "NaN", "0", "-5", "Infinity"])(
    'cae al default y avisa con "%s"',
    (value) => {
      process.env[VAR] = value;
      expect(positiveNumberEnv(VAR, 15)).toBe(15);
      expect(warnSpy).toHaveBeenCalled();
    },
  );
});

/**
 * Nivel 1 (sin BD): de `req.ip` cuelgan todos los rate limiters, así que lo que importa aquí es
 * que **ausente signifique ausente** — `undefined`, no `false` ni `0` — para que `app.ts` ni
 * llame a `app.set` y no se active sola una confianza en `X-Forwarded-For` que permitiría saltarse
 * los límites con IPs inventadas.
 */
describe("trustProxyEnv", () => {
  const original = process.env.TRUST_PROXY;

  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = original;
  });

  it("devuelve undefined cuando no está definida o viene vacía", () => {
    delete process.env.TRUST_PROXY;
    expect(trustProxyEnv()).toBeUndefined();

    process.env.TRUST_PROXY = "";
    expect(trustProxyEnv()).toBeUndefined();

    process.env.TRUST_PROXY = "   ";
    expect(trustProxyEnv()).toBeUndefined();
  });

  it("interpreta un entero como número de saltos de proxy", () => {
    process.env.TRUST_PROXY = "1";
    expect(trustProxyEnv()).toBe(1);

    process.env.TRUST_PROXY = " 2 ";
    expect(trustProxyEnv()).toBe(2);
  });

  it("interpreta los booleanos explícitos", () => {
    process.env.TRUST_PROXY = "true";
    expect(trustProxyEnv()).toBe(true);

    process.env.TRUST_PROXY = "false";
    expect(trustProxyEnv()).toBe(false);
  });

  it("pasa presets y listas de direcciones tal cual a Express", () => {
    process.env.TRUST_PROXY = "loopback";
    expect(trustProxyEnv()).toBe("loopback");

    process.env.TRUST_PROXY = "10.0.0.0/8, 192.168.0.1";
    expect(trustProxyEnv()).toBe("10.0.0.0/8, 192.168.0.1");
  });

  it("no trata como conteo de saltos un número que Express no podría usar como tal", () => {
    // Number("1.5")/Number("-1") son finitos: sin el regex de enteros se colarían como saltos.
    process.env.TRUST_PROXY = "1.5";
    expect(trustProxyEnv()).toBe("1.5");

    process.env.TRUST_PROXY = "-1";
    expect(trustProxyEnv()).toBe("-1");
  });
});
