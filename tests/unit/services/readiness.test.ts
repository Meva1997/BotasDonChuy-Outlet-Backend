/**
 * Fase O.5 — readiness. Nivel 1 (sin BD real, ver roadmap-testing.md): `sequelize.authenticate`
 * se espía, así que se puede simular lo que en producción no se puede provocar a voluntad —
 * Postgres caído y, sobre todo, Postgres **colgado sin responder**, que es el caso que motiva
 * el timeout: `config/database.ts` no fija `connectTimeout` ni `statement_timeout`, así que sin
 * él un sondeo se quedaría esperando muchísimo más de lo que el orquestador tolera.
 *
 * El logger se mockea porque este módulo escribe una línea en cada transición de estado y esta
 * suite provoca varias a propósito.
 */
jest.mock("../../../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sequelize } from "../../../src/config/database";
import { checkReadiness, markDraining, resetReadinessCache } from "../../../src/services/readiness";

describe("checkReadiness (Fase O.5)", () => {
  let authenticate: jest.SpyInstance;

  beforeEach(() => {
    resetReadinessCache();
    authenticate = jest.spyOn(sequelize, "authenticate");
  });

  afterEach(() => {
    authenticate.mockRestore();
  });

  it("responde listo cuando la base de datos contesta", async () => {
    authenticate.mockResolvedValue(undefined);

    await expect(checkReadiness()).resolves.toEqual({ ready: true });
  });

  it("responde no-listo cuando la base de datos falla, sin lanzar", async () => {
    authenticate.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));

    // Que NO lance es parte del contrato: el handler no debe pasar por `errorHandler`, que
    // mandaría un 500 a Sentry en cada sondeo.
    await expect(checkReadiness()).resolves.toEqual({ ready: false, reason: "database" });
  });

  it("corta en el timeout cuando la base de datos se cuelga sin responder", async () => {
    // Nunca resuelve: es el caso real de Postgres inalcanzable a nivel TCP, donde el
    // `authenticate()` puede tardar más que `pool.acquire` (30 s).
    authenticate.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    const result = await checkReadiness(20);

    expect(result).toEqual({ ready: false, reason: "database" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("cachea el resultado: dos chequeos seguidos consultan la BD una sola vez", async () => {
    authenticate.mockResolvedValue(undefined);

    await checkReadiness();
    await checkReadiness();
    await checkReadiness();

    // El contador ES la prueba: la caché existe para que un script que martille la ruta pública
    // no se coma las 5 conexiones del pool y deje a los checkouts esperando.
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("comparte la consulta en vuelo entre chequeos concurrentes", async () => {
    let resolveProbe: () => void = () => {};
    authenticate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProbe = resolve;
      }),
    );

    const inFlight = Promise.all([checkReadiness(), checkReadiness(), checkReadiness()]);
    resolveProbe();

    await expect(inFlight).resolves.toEqual([{ ready: true }, { ready: true }, { ready: true }]);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("vuelve a consultar la BD una vez vencida la ventana de caché", async () => {
    authenticate.mockResolvedValue(undefined);

    await checkReadiness();
    expect(authenticate).toHaveBeenCalledTimes(1);

    // La ventana es de 1 s; se adelanta el reloj en vez de esperarlo.
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 2_000);
    try {
      await checkReadiness();
    } finally {
      (Date.now as unknown as jest.SpyInstance).mockRestore();
    }

    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("durante el apagado responde no-listo sin tocar la base de datos", async () => {
    authenticate.mockResolvedValue(undefined);
    markDraining();

    await expect(checkReadiness()).resolves.toEqual({ ready: false, reason: "draining" });
    // Sin consultar: el balanceador tiene que sacar la instancia de rotación de inmediato,
    // aunque Postgres siga perfectamente sano.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("el drenado gana sobre un resultado listo ya cacheado", async () => {
    authenticate.mockResolvedValue(undefined);
    await expect(checkReadiness()).resolves.toEqual({ ready: true });

    markDraining();

    await expect(checkReadiness()).resolves.toEqual({ ready: false, reason: "draining" });
  });
});
