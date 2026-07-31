import { RateLimitRequestHandler, rateLimit } from "express-rate-limit";

// Todos estos limitadores cuentan por `req.ip`, que detrás de un proxy es la IP del proxy
// mientras Express no tenga `trust proxy`: en ese caso el tope no es por cliente, es uno solo
// para toda la tienda. Se configura con la env `TRUST_PROXY` (ver `trustProxyEnv` en
// `utils/env.ts`, donde está el porqué de que no venga activado por defecto). Si se despliega
// detrás de un proxy sin definirla, estos números dejan de significar lo que dicen.

export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos. Intenta de nuevo más tarde." },
});

// Skydropx limita la cuenta completa a 2 req/s (compartidos por TODOS los
// checkouts en curso vía el throttle de skydropx.service.ts). Sin límite por
// IP, un solo cliente golpeando este endpoint público sin autenticación podría
// acaparar ese presupuesto y degradar la cotización en vivo de compradores
// reales a la tarifa plana de respaldo.
export const shippingRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas cotizaciones de envío. Intenta de nuevo en un momento." },
});

// POST /api/orders es público y cada request exitoso crea un PaymentIntent real
// en Stripe y una fila Order. Sin límite por IP, un flood sostenido puede saturar
// la tabla de órdenes y el rate limit de la cuenta de Stripe, aunque el
// pendingOrderSweeper libere las órdenes pending no pagadas después de un rato.
export const orderRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados pedidos. Intenta de nuevo en un momento." },
});

// GET /api/orders/lookup/:token es público y su token ES la credencial (Fase O.4). Adivinar un
// UUID por fuerza bruta es inviable con o sin límite, así que esto no es la defensa contra eso:
// es para que un script no pueda martillar la ruta gratis y de paso acota el daño de un token
// filtrado. El tope es holgado a propósito — la página de seguimiento la recarga gente real
// esperando su pedido, y un límite apretado castigaría justo al comprador ansioso.
export const orderLookupRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Demasiadas consultas seguidas. Espera un momento y vuelve a intentar.",
  },
});

// POST /api/coupons/validate es público y aquí el límite SÍ es la defensa principal, a diferencia
// del de arriba: los códigos de cupón no son secretos ni son UUIDs, así que un script podría
// recorrer combinaciones cortas hasta encontrar una promoción que el dueño no ha anunciado. De
// paso acota el costo de la ruta, que lee productos y cupones en cada llamada. El tope deja
// margen para que un comprador se equivoque tecleando varias veces sin quedar bloqueado.
export const couponRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Demasiados intentos con cupones. Espera un momento y vuelve a intentar.",
  },
});
