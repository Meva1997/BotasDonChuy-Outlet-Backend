import { Resend } from "resend";
import dotenv from "dotenv";

// Igual que src/config/stripe.ts / cloudinary.ts: los imports de módulo se evalúan
// ANTES del dotenv.config() de src/app.ts, así que cada config carga su propio .env aquí.
dotenv.config({ quiet: true });

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM;

// Llaves exigidas: sin ellas ningún correo transaccional sale, así que fallamos
// rápido al arrancar en vez de descubrirlo al primer forgot-password.
if (!apiKey) {
  throw new Error(
    "RESEND_API_KEY no está configurada. Agrégala al .env (re_… del dashboard de Resend).",
  );
}
if (!from) {
  throw new Error(
    'EMAIL_FROM no está configurada. Agrégala al .env (p. ej. "Botas Don Chuy <onboarding@resend.dev>").',
  );
}

/** Cliente Resend compartido. La llave vive solo en el .env. */
export const resend: Resend = new Resend(apiKey);

/** Remitente de todos los correos. Sin dominio verificado, usar onboarding@resend.dev. */
export const EMAIL_FROM: string = from;

/** URL del frontend, para construir links dentro de los correos. */
export const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
