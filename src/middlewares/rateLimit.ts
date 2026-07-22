import { RateLimitRequestHandler, rateLimit } from "express-rate-limit";

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
