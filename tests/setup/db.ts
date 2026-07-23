/**
 * Helpers de base de datos para las suites de INTEGRACIÓN (partes 2 en adelante).
 *
 * Las pruebas unitarias (servicios puros, utils) NO importan este módulo: corren sin
 * Postgres. Solo las suites que tocan la BD llaman a estos helpers, así:
 *
 *   import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
 *   beforeAll(setupTestDatabase);
 *   afterEach(truncateAll);
 *   afterAll(closeTestDatabase);
 *
 * `setupTestDatabase` recrea el esquema desde cero (`sync({ force: true })`) contra la
 * BD apuntada por `DATABASE_URL` de `.env.test` — que DEBE ser una BD dedicada de
 * pruebas, porque esto BORRA todas las tablas. `truncateAll` limpia entre tests para que
 * cada uno arranque de un estado conocido sin pagar un `sync` completo cada vez.
 *
 * Importante: importamos `src/models/associations` (efecto de lado) para registrar todos
 * los modelos y sus relaciones antes del `sync`, igual que hace `src/app.ts`.
 */
import { sequelize } from "../../src/config/database";
import "../../src/models/associations";

/** Recrea el esquema completo. Llamar en `beforeAll` de cada suite de integración. */
export async function setupTestDatabase(): Promise<void> {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });
}

/**
 * Vacía todas las tablas conservando el esquema. `TRUNCATE ... RESTART IDENTITY CASCADE`
 * reinicia también los SERIAL, para que los ids sean predecibles entre tests.
 */
export async function truncateAll(): Promise<void> {
  const tableNames = Object.values(sequelize.models)
    .map((model) => `"${model.getTableName()}"`)
    .join(", ");
  if (!tableNames) return;
  await sequelize.query(`TRUNCATE ${tableNames} RESTART IDENTITY CASCADE;`);
}

/** Cierra el pool. Llamar en `afterAll` para que Jest no quede colgado. */
export async function closeTestDatabase(): Promise<void> {
  await sequelize.close();
}
