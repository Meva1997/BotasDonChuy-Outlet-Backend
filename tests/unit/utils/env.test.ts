import { positiveNumberEnv } from "../../../src/utils/env";

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
