import dotenv from "dotenv";

// Igual que src/config/stripe.ts / resend.ts: los imports de módulo se evalúan
// ANTES del dotenv.config() de src/app.ts, así que cada config carga su propio .env aquí.
dotenv.config();

const clientId = process.env.SKYDROPX_CLIENT_ID;
const clientSecret = process.env.SKYDROPX_CLIENT_SECRET;

// Llaves exigidas: sin ellas ninguna cotización ni guía puede generarse, así que
// fallamos rápido al arrancar en vez de descubrirlo en el primer checkout.
if (!clientId) {
  throw new Error(
    "SKYDROPX_CLIENT_ID no está configurada. Agrégala al .env (ver roadmap-skydropx.md §1 — usa la cuenta sandbox para desarrollo, las credenciales de producción quedan como SKYDROPX_CLIENT_ID_PROD).",
  );
}
if (!clientSecret) {
  throw new Error(
    "SKYDROPX_CLIENT_SECRET no está configurada. Agrégala al .env (ver roadmap-skydropx.md §1 — usa la cuenta sandbox para desarrollo, las credenciales de producción quedan como SKYDROPX_CLIENT_SECRET_PROD).",
  );
}

/**
 * Credenciales OAuth2 client_credentials. `.env` apunta por defecto a la cuenta
 * SANDBOX (sb-pro.skydropx.com, saldo de prueba) — las de producción (sin sandbox
 * propio) quedan guardadas como *_PROD para el lanzamiento (ver roadmap-skydropx.md §1).
 */
export const SKYDROPX_CLIENT_ID: string = clientId;
export const SKYDROPX_CLIENT_SECRET: string = clientSecret;

/** Host activo — sandbox por defecto en desarrollo (ver roadmap-skydropx.md §1). */
export const SKYDROPX_BASE_URL =
  process.env.SKYDROPX_BASE_URL ?? "https://sb-pro.skydropx.com";

/**
 * Dirección de origen (tienda física en Celaya, GTO) para cada cotización
 * (Fase 8.3). Hard-require igual que las credenciales, pero SOLO para los
 * campos que `getOriginAddress()` (skydropx.service.ts) realmente usa hoy:
 * `country_code`/`postal_code`/`area_level1-3` bastan para cotizar. Sin esto
 * ninguna cotización puede armar su `address_from`.
 */
const shipFromFields = {
  SHIP_FROM_NEIGHBORHOOD: process.env.SHIP_FROM_NEIGHBORHOOD,
  SHIP_FROM_CITY: process.env.SHIP_FROM_CITY,
  SHIP_FROM_STATE: process.env.SHIP_FROM_STATE,
  SHIP_FROM_POSTAL_CODE: process.env.SHIP_FROM_POSTAL_CODE,
} as const;

for (const [key, value] of Object.entries(shipFromFields)) {
  if (!value) {
    throw new Error(
      `${key} no está configurada. Agrégala al .env (dirección de origen para Skydropx — ver roadmap-skydropx.md §7).`,
    );
  }
}

export const SHIP_FROM_NEIGHBORHOOD: string = shipFromFields.SHIP_FROM_NEIGHBORHOOD!;
export const SHIP_FROM_CITY: string = shipFromFields.SHIP_FROM_CITY!;
export const SHIP_FROM_STATE: string = shipFromFields.SHIP_FROM_STATE!;
export const SHIP_FROM_POSTAL_CODE: string = shipFromFields.SHIP_FROM_POSTAL_CODE!;

/**
 * Reservados para crear la guía (Fase 8.5, todavía no implementada) —
 * `POST /shipments` sí los necesita, cotizar no. Deliberadamente NO son
 * hard-require: exigirlos hoy tumbaría el arranque del server por config que
 * ninguna ruta activa lee. Quedan `string | undefined`; cuando Fase 8.5 los
 * consuma, hacerlos hard-require ahí (mismo patrón de arriba).
 */
export const SHIP_FROM_STREET: string | undefined = process.env.SHIP_FROM_STREET;
export const SHIP_FROM_EXTERNAL_NUMBER: string | undefined =
  process.env.SHIP_FROM_EXTERNAL_NUMBER;
export const SHIP_FROM_NAME: string | undefined = process.env.SHIP_FROM_NAME;
export const SHIP_FROM_PHONE: string | undefined = process.env.SHIP_FROM_PHONE;
