import dotenv from "dotenv";

// Igual que src/config/stripe.ts / resend.ts: los imports de módulo se evalúan
// ANTES del dotenv.config() de src/app.ts, así que cada config carga su propio .env aquí.
dotenv.config({ quiet: true });

const clientId = process.env.SKYDROPX_CLIENT_ID;
const clientSecret = process.env.SKYDROPX_CLIENT_SECRET;
const webhookSecret = process.env.SKYDROPX_WEBHOOK_SECRET;

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
// Secreto del webhook de Skydropx (Fase 8.6): con él se verifica la firma HMAC-SHA512 de
// cada evento entrante. Hard-require igual que STRIPE_WEBHOOK_SECRET — un webhook sin
// verificación de firma aceptaría eventos falsos, así que fallamos rápido si falta.
if (!webhookSecret) {
  throw new Error(
    "SKYDROPX_WEBHOOK_SECRET no está configurada. Agrégala al .env (secreto HMAC del webhook de Skydropx — ver roadmap-skydropx.md §7). En el panel de Skydropx configura el webhook con autenticación HMAC y usa ahí el mismo secreto.",
  );
}

/**
 * Credenciales OAuth2 client_credentials. `.env` apunta por defecto a la cuenta
 * SANDBOX (sb-pro.skydropx.com, saldo de prueba) — las de producción (sin sandbox
 * propio) quedan guardadas como *_PROD para el lanzamiento (ver roadmap-skydropx.md §1).
 */
export const SKYDROPX_CLIENT_ID: string = clientId;
export const SKYDROPX_CLIENT_SECRET: string = clientSecret;

/** Secreto HMAC del webhook de Skydropx (Fase 8.6), para verificar la firma de cada evento. */
export const SKYDROPX_WEBHOOK_SECRET: string = webhookSecret;

/** Host activo — sandbox por defecto en desarrollo (ver roadmap-skydropx.md §1). */
export const SKYDROPX_BASE_URL =
  process.env.SKYDROPX_BASE_URL ?? "https://sb-pro.skydropx.com";

/**
 * Paqueterías a cotizar (`requested_carriers` de `POST /api/v1/quotations`).
 * Opcional: si se define `SKYDROPX_CARRIERS` (lista separada por comas, p.ej.
 * `"dhl,paquetexpress,fedex,estafeta,redpack"`), la cotización se restringe a
 * esos carriers — menos proveedores = respuesta más rápida y menos opciones que
 * mostrar. Sin definir, se cotizan TODAS las paqueterías disponibles (y el
 * controlador recorta a las más baratas). Usa los slugs `provider_name` de
 * Skydropx en minúsculas; en la cuenta sandbox se confirmaron `dhl` y
 * `paquetexpress` (ver skydropx.service.ts). Un slug inválido simplemente no
 * devuelve tarifa para esa paquetería.
 */
const rawCarriers = process.env.SKYDROPX_CARRIERS?.split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
export const SKYDROPX_CARRIERS: string[] | undefined =
  rawCarriers && rawCarriers.length > 0 ? rawCarriers : undefined;

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
  // Antes reservados/opcionales para cuando se implementara Fase 8.5 (crear la guía);
  // ahora que `createShipmentForOrder` (payment.service.ts) los usa para armar el
  // `address_from` de `POST /shipments`, pasan a ser hard-require igual que los de arriba.
  SHIP_FROM_STREET: process.env.SHIP_FROM_STREET,
  SHIP_FROM_EXTERNAL_NUMBER: process.env.SHIP_FROM_EXTERNAL_NUMBER,
  SHIP_FROM_NAME: process.env.SHIP_FROM_NAME,
  SHIP_FROM_PHONE: process.env.SHIP_FROM_PHONE,
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
export const SHIP_FROM_STREET: string = shipFromFields.SHIP_FROM_STREET!;
export const SHIP_FROM_EXTERNAL_NUMBER: string = shipFromFields.SHIP_FROM_EXTERNAL_NUMBER!;
export const SHIP_FROM_NAME: string = shipFromFields.SHIP_FROM_NAME!;
export const SHIP_FROM_PHONE: string = shipFromFields.SHIP_FROM_PHONE!;
