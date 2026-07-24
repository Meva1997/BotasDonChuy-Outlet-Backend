import Stripe from "stripe";
import dotenv from "dotenv";

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

/** Cliente Stripe compartido. La llave de test/sandbox vive solo en el .env. */
export const stripe: Stripe = new Stripe(secretKey);

/** Secreto de firma del webhook, para `stripe.webhooks.constructEvent`. */
export const STRIPE_WEBHOOK_SECRET: string = webhookSecret;

/** Moneda de cobro. Pesos mexicanos por defecto (la tienda opera en MXN). */
export const STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "mxn";

/** Minutos tras los cuales una orden `pending` sin pagar se considera abandonada. */
export const PENDING_ORDER_TTL_MINUTES = Number(
  process.env.PENDING_ORDER_TTL_MINUTES ?? 30,
);

/** Cada cuántos minutos corre el barrido de órdenes `pending` vencidas. */
export const PENDING_ORDER_SWEEP_INTERVAL_MINUTES = Number(
  process.env.PENDING_ORDER_SWEEP_INTERVAL_MINUTES ?? 10,
);
