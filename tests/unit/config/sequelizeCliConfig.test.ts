import { databaseSslOptions } from "../../../src/config/databaseSsl";

/**
 * Nivel 1 (sin BD): atrapa la deriva entre los DOS clientes que abren conexión a la misma base —
 * la app (`src/config/database.ts`) y el CLI de migraciones (`src/config/sequelize-cli.js`) —,
 * en el mismo espíritu que `tests/integration/orderIndexes.test.ts` con los índices.
 *
 * El riesgo concreto: alguien arregla el TLS en un archivo y no en el otro, y `pnpm migrate`
 * acaba viajando en claro contra la base de producción mientras la app va cifrada (o al revés).
 * Como el CLI nunca importa `app.ts`, nada más los relaciona.
 */
describe("config de sequelize-cli", () => {
  // `require` y no `import`: es un .js plano fuera de `rootDir`, deliberadamente no compilado.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require("../../../src/config/sequelize-cli.js");

  const ENVIRONMENTS = ["development", "test", "production"] as const;

  it("declara los tres entornos que usa sequelize-cli", () => {
    for (const env of ENVIRONMENTS) {
      expect(config[env]).toBeDefined();
    }
  });

  it.each(ENVIRONMENTS)("en %s resuelve la conexión desde DATABASE_URL", (env) => {
    // La app y el CLI tienen que apuntar a la misma base sin dos formas de configurarla.
    expect(config[env].use_env_variable).toBe("DATABASE_URL");
    expect(config[env].dialect).toBe("postgres");
  });

  it.each(ENVIRONMENTS)("en %s comparte la config de TLS con la app", (env) => {
    // La aserción que importa: no que el valor sea X, sino que salga de `databaseSslOptions()`,
    // la misma función que usa `src/config/database.ts`.
    expect(config[env].dialectOptions).toEqual(databaseSslOptions());
  });

  it("no loguea SQL: el CLI escupiría cada sentencia de cada migración", () => {
    for (const env of ENVIRONMENTS) {
      expect(config[env].logging).toBe(false);
    }
  });
});
