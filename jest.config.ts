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
 */
const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  setupFiles: ["<rootDir>/tests/setup/env.ts"],
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
