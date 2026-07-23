/**
 * `setupFiles` de Jest — corre UNA vez por archivo de test, ANTES de que se importe
 * cualquier módulo del test (incluido `src/app.ts` y los `src/config/*`).
 *
 * Fija `NODE_ENV=test` (así `app.ts` no abre puerto/BD/cron y el sweeper se auto-omite)
 * y carga `.env.test` con `override: true`. Como esto corre primero, cuando después un
 * `src/config/*.ts` hace su propio `dotenv.config()` (que por defecto NO sobreescribe
 * variables ya presentes), gana `.env.test`.
 */
import path from "path";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

dotenv.config({
  path: path.resolve(__dirname, "../../.env.test"),
  override: true,
  quiet: true,
});
