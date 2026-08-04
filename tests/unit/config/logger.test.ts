/**
 * Pure unit — sin transporte real. Cubre las ramas de `src/config/logger.ts`
 * (`LOG_LEVEL` explícito vs. derivado de `NODE_ENV`; `transport` de pino-pretty
 * solo fuera de producción) mockeando `pino` para capturar con qué opciones se
 * construye, en vez de escribir de verdad a stdout.
 */
describe("config/logger", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  function captureOptions(): Record<string, unknown> {
    let captured: Record<string, unknown> | undefined;

    jest.isolateModules(() => {
      jest.doMock("pino", () => ({
        __esModule: true,
        default: (options: Record<string, unknown>) => {
          captured = options;
          return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        },
      }));
      require("../../../src/config/logger");
    });

    return captured!;
  }

  it("usa LOG_LEVEL cuando está configurada, sin importar NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "warn";

    expect(captureOptions().level).toBe("warn");
  });

  it("sin LOG_LEVEL y NODE_ENV=production, cae a 'info' y omite pino-pretty", () => {
    process.env.NODE_ENV = "production";
    delete process.env.LOG_LEVEL;

    const options = captureOptions();

    expect(options.level).toBe("info");
    expect(options.transport).toBeUndefined();
  });

  it("sin LOG_LEVEL fuera de producción, cae a 'debug' y usa pino-pretty", () => {
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;

    const options = captureOptions();

    expect(options.level).toBe("debug");
    expect(options.transport).toEqual(
      expect.objectContaining({
        target: "pino-pretty",
        options: expect.objectContaining({ colorize: true }),
      }),
    );
  });
});
