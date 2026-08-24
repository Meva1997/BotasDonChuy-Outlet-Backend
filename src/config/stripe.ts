import Stripe from "stripe";
import dotenv from "dotenv";
import { positiveNumberEnv } from "../utils/env";

// Igual que src/config/database.ts: los imports de módulo se evalúan ANTES del
// dotenv.config() de src/app.ts, así que cada config carga su propio .env aquí.
dotenv.config({ quiet: true });

const secretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Llaves exigidas: sin ellas el cobro y la verificación de firma no funcionan, así
// que fallamos rápido al arrancar en vez de descubrirlo en el primer checkout.
if (!secretKey) {
  throw new Error(
    "STRIPE_SECRET_KEY no está configurada. Agrégala al .env (llave de test/sandbox).",
  );
}
if (!webhookSecret) {
  throw new Error(
    "STRIPE_WEBHOOK_SECRET no está configurada. Agrégala al .env (whsec_… de `stripe listen` o del endpoint del dashboard).",
  );
}

/**
 * Versión de la API de Stripe, **fijada a propósito**.
 *
 * Omitir `apiVersion` no deja al SDK "sin versión": manda igualmente la que trae compilada
 * (`props.apiVersion || DEFAULT_API_VERSION`), así que hoy este literal es un no-op en runtime.
 * Lo que compra es el fail-fast: `StripeConfig.apiVersion` está tipado como el literal exacto
 * de esta versión del SDK, de modo que un `pnpm update` de `stripe` que mueva la versión rompe
 * `pnpm build` en vez de cambiar en silencio la forma de los objetos que leen
 * `markOrderPaidFromWebhook` y `applyDisputeFromWebhook`. Subirla debe ser una decisión, no un
 * efecto colateral: al tocar este valor hay que revisar el changelog del SDK.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;

/** Cliente Stripe compartido. La llave de test/sandbox vive solo en el .env. */
export const stripe: Stripe = new Stripe(secretKey, {
  apiVersion: STRIPE_API_VERSION,
});

/** Secreto de firma del webhook, para `stripe.webhooks.constructEvent`. */
export const STRIPE_WEBHOOK_SECRET: string = webhookSecret;

/** Moneda de cobro. Pesos mexicanos por defecto (la tienda opera en MXN). */
export const STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "mxn";

/**
 * Minutos tras los cuales una orden `pending` sin pagar se considera abandonada.
 *
 * Vía `positiveNumberEnv` y no `Number(process.env.X ?? 30)`: `??` solo cae al default cuando la
 * variable es `undefined`, así que una línea vacía en el `.env` de producción daba
 * `Number("") === 0` y un valor mal tecleado `NaN`. Con `0`, TODA orden `pending` cuenta como
 * vencida en el acto y el barrido le cancela el PaymentIntent al comprador que está pagando.
 */
export const PENDING_ORDER_TTL_MINUTES = positiveNumberEnv(
  "PENDING_ORDER_TTL_MINUTES",
  30,
);

/**
 * Cada cuántos minutos corre el barrido de órdenes `pending` vencidas.
 *
 * Mismo motivo que arriba, y aquí el daño es peor: un `0`/`NaN` convierte el `setInterval` del
 * sweeper en un bucle de ~1 ms contra la base de datos y contra Stripe.
 */
export const PENDING_ORDER_SWEEP_INTERVAL_MINUTES = positiveNumberEnv(
  "PENDING_ORDER_SWEEP_INTERVAL_MINUTES",
  10,
);
