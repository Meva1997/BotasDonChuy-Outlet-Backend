import type { Config } from "jest";

/**
 * Configuración de Jest para el backend (Fase H.1 — ver roadmap-testing.md).
 *
 * - `ts-jest` transpila los tests TypeScript en memoria; no tocan `dist/` (por eso
 *   los tests viven en `tests/`, fuera de `src/`, y `tsc` los ignora).
 * - `setupFiles` corre ANTES de que se importe cualquier módulo del test, así que
 *   `tests/setup/env.ts` deja `NODE_ENV=test` y las variables de `.env.test` en
 *   `process.env` antes de que los módulos de `src/config/*` hagan su `dotenv.config()`.
 * - NO hay `globalSetup` que conecte a la BD: las pruebas unitarias (servicios puros,
 *   utils) corren sin Postgres. Solo las suites de integración llaman a los helpers de
 *   `tests/setup/db.ts` en su `beforeAll`, así que `pnpm test` de la parte unitaria pasa
 *   aunque no haya una BD de test levantada.
 * - `maxWorkers: 1`: Jest por defecto corre cada archivo de test en un worker separado
 *   en paralelo. Cada suite de integración apunta al MISMO Postgres de test y su
 *   `beforeAll` corre `sync({ force: true })` (dropea y recrea todas las tablas) —
 *   con más de una suite de integración (desde la Parte 3) dos workers paralelos
 *   pisándose ese `sync`/`TRUNCATE` provocan errores de tipo `ENUM ya existe` o
 *   `relation does not exist` intermitentes. Forzar un solo worker serializa todas las
 *   suites (incluidas las unitarias, ya rápidas) y elimina la carrera.
 */
const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  setupFiles: ["<rootDir>/tests/setup/env.ts"],
  maxWorkers: 1,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        // tsconfig.jest.json extiende el base pero mueve rootDir al raíz del repo
        // (los tests viven fuera de src/) y agrega los tipos de jest. Un objeto inline
        // aquí REEMPLAZA la config del base en vez de fusionarla, así que se usa archivo.
        tsconfig: "tsconfig.jest.json",
      },
    ],
  },
  testMatch: ["**/tests/**/*.test.ts"],
  clearMocks: true,
  testTimeout: 20_000,
};

export default config;
