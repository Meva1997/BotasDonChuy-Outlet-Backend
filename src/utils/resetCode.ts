import crypto from "crypto";

/** Minutos de vigencia del código de recuperación antes de expirar. */
export const RESET_CODE_TTL_MINUTES = 15;

/** Intentos fallidos permitidos antes de invalidar el código (anti-fuerza-bruta). */
export const RESET_CODE_MAX_ATTEMPTS = 5;

/**
 * Genera un código de 5 dígitos **solo numéricos** (`"00042"` … `"99999"`).
 * crypto.randomInt es criptográficamente seguro y uniforme en [0, 100000).
 */
export function generateResetCode(): string {
  return crypto.randomInt(0, 100000).toString().padStart(5, "0");
}

/**
 * Hash sha256 del código. No usamos bcrypt: el código es corto, de un solo uso,
 * con expiración de 15 min y límite de intentos, así que no necesita ser lento.
 */
export function hashResetCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Compara en tiempo constante el código recibido contra el hash guardado
 * (timingSafeEqual evita filtrar información por tiempo de respuesta).
 */
export function verifyResetCode(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashResetCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}
