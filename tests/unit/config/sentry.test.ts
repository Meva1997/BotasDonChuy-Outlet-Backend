/**
 * Pure unit — sin BD. Cubre el side effect de import de `src/config/sentry.ts`
 * (Sentry.init condicionado a SENTRY_DSN) reimportando el módulo con
 * `jest.isolateModules` para cada valor de la env var, ya que ese side effect solo
 * corre una vez al cargar el módulo.
 *
 * Los mocks delegan a un jest.fn() cerrado sobre el scope del test (en vez de crear
 * uno nuevo dentro del factory) porque `isolateModules` usa un registro de módulos
 * aparte: si el factory creara el jest.fn() directamente, cada reimport produciría
 * una instancia distinta y las aserciones apuntarían al mock equivocado.
 */
const sentryInitMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.mock("@sentry/node", () => ({
  init: (...args: unknown[]) => sentryInitMock(...args),
  captureException: jest.fn(),
}));

jest.mock("../../../src/config/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("config/sentry", () => {
  const originalDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    process.env.SENTRY_DSN = originalDsn;
  });

  it("con SENTRY_DSN configurado, inicializa Sentry con dsn/environment/tracesSampleRate:0", () => {
    process.env.SENTRY_DSN = "https://test-dsn@o0.ingest.sentry.io/1";

    jest.isolateModules(() => {
      require("../../../src/config/sentry");
    });

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledWith({
      dsn: "https://test-dsn@o0.ingest.sentry.io/1",
      environment: "test",
      tracesSampleRate: 0,
    });
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("sin SENTRY_DSN, no inicializa Sentry y loguea un warning (deshabilitado por defecto)", () => {
    // Cadena vacía, no `delete`: si la key desaparece de process.env, el propio
    // dotenv.config() de sentry.ts la repuebla leyendo el .env real de desarrollo
    // (mismo mecanismo que causaba la fuga hacia Sentry real en corridas de test —
    // ver .env.test). Una cadena vacía es falsy y evita ese repoblado.
    process.env.SENTRY_DSN = "";

    jest.isolateModules(() => {
      require("../../../src/config/sentry");
    });

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it("usa 'development' como fallback de environment cuando NODE_ENV no está definida", () => {
    // A diferencia de los otros dos casos, aquí SÍ hace falta mockear `dotenv`: borrar
    // NODE_ENV de process.env dejaría que el propio `dotenv.config()` de sentry.ts la
    // repueble desde el .env real ("development"), y entonces la rama `?? "development"`
    // nunca se ejecutaría — el valor ya vendría definido antes de llegar a esa línea.
    process.env.SENTRY_DSN = "https://test-dsn@o0.ingest.sentry.io/1";
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      jest.isolateModules(() => {
        jest.doMock("dotenv", () => ({ config: jest.fn() }));
        require("../../../src/config/sentry");
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }

    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "development" }),
    );
  });
});
