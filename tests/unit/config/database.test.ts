/**
 * `connectDB` (`src/config/database.ts`) — Nivel 1 con la BD de test real para el camino feliz.
 *
 * Es lo primero que corre el arranque real (`app.ts`, fuera del gate de `NODE_ENV=test`), y su
 * comportamiento ante un fallo es deliberado y fácil de romper sin notarlo: **no relanza, sale del
 * proceso con código 1**. Degradarlo a un `throw` dejaría el servidor escuchando peticiones contra
 * una BD caída —cada una respondiendo 500— en vez de que el deploy falle de inmediato y el
 * orquestador conserve la versión anterior.
 */
import { sequelize, connectDB } from "../../../src/config/database";
import { logger } from "../../../src/config/logger";

let exitSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let infoSpy: jest.SpyInstance;

beforeEach(() => {
  exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined as never);
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await sequelize.close();
});

describe("connectDB", () => {
  it("autentica contra la BD y lo deja anotado en el log", async () => {
    await connectDB();

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("PostgreSQL"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("NO crea ni altera el esquema: solo autentica", async () => {
    // Esto dejó de hacer `sync({ alter: true })` en la Fase H.2 para que dev y prod compartan
    // exactamente el mismo camino de cambio de esquema (las migraciones). Si alguien lo
    // reintrodujera, un arranque en dev podría alterar tablas por su cuenta.
    const syncSpy = jest.spyOn(sequelize, "sync");

    await connectDB();

    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("sale del proceso con código 1 si la conexión falla, en vez de relanzar", async () => {
    jest
      .spyOn(sequelize, "authenticate")
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    // No debe rechazar: quien lo llama (`app.ts`) no tiene un catch, así que un throw se
    // volvería un unhandled rejection en vez de un apagado limpio.
    await expect(connectDB()).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("Error connecting to the database"),
    );
  });
});

describe("instancia compartida de sequelize", () => {
  it("usa el dialecto postgres (el código depende de ENUM, JSONB y literal())", () => {
    expect(sequelize.getDialect()).toBe("postgres");
  });

  it("limita el pool a 5 conexiones", () => {
    // El mismo número por el que `checkReadiness` cachea su resultado: con un pool de 5, un
    // script pegándole al healthcheck dejaría sin conexiones a los checkouts reales.
    expect(sequelize.config.pool?.max).toBe(5);
  });

  it("no loguea SQL fuera de desarrollo", () => {
    // En producción una línea por consulta se come la cuota del proveedor de logs.
    // `options` no está en los tipos públicos de Sequelize 6, pero sí en la instancia.
    const { logging } = (sequelize as unknown as { options: { logging: unknown } }).options;
    expect(logging).toBe(false);
  });
});

describe("logging SQL en NODE_ENV=development", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("loguea cada consulta vía logger.debug", () => {
    process.env.NODE_ENV = "development";
    const debugMock = jest.fn();
    let freshSequelize!: typeof sequelize;

    jest.isolateModules(() => {
      jest.doMock("../../../src/config/logger", () => ({
        logger: { debug: debugMock, info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }));
      freshSequelize = require("../../../src/config/database").sequelize;
    });

    const { logging } = (freshSequelize as unknown as { options: { logging: (sql: string) => void } })
      .options;
    expect(typeof logging).toBe("function");

    (logging as (sql: string) => void)("SELECT 1");
    expect(debugMock).toHaveBeenCalledWith("SELECT 1");
  });
});
