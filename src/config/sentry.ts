import * as Sentry from "@sentry/node";
import dotenv from "dotenv";
import { logger } from "./logger";

// Se importa antes que cualquier otro módulo en app.ts (incluido cloudinary/resend/skydropx,
// cuyo fail-fast podría lanzar durante el arranque) para que Sentry ya esté armado si algo
// truena temprano. Dotenv propio: este módulo se importa antes del dotenv.config() de app.ts.
dotenv.config();

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Solo error tracking, no performance monitoring — fuera de alcance de esta fase.
    tracesSampleRate: 0,
  });
} else {
  // A diferencia de stripe.ts/resend.ts/skydropx.ts, Sentry es monitoreo opt-in, no una
  // dependencia de negocio: no se hace hard-require de SENTRY_DSN, solo se avisa y se sigue
  // (Sentry.captureException es un no-op seguro si Sentry.init nunca corrió).
  logger.warn("SENTRY_DSN no configurado; el error tracking con Sentry está deshabilitado.");
}

export { Sentry };
