/** Dominios que ignoran los puntos del buzón: `j.uan@gmail.com` y `juan@gmail.com` son la
 *  misma cuenta. Solo estos dos — en la mayoría de los proveedores el punto SÍ distingue. */
const DOT_INSENSITIVE_HOSTS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Identidad de "persona" para el límite de un uso por cliente de los cupones (Fase N.2).
 *
 * **Es el correo del pedido, y NO la IP**, que era la opción intuitiva y es la peor:
 *  - Detrás de CGNAT (cualquier plan móvil, Izzi, Totalplay) media colonia sale por una sola
 *    dirección, así que un cupón canjeado bloquearía a vecinos que nunca lo usaron.
 *  - Peor: `req.ip` depende de `TRUST_PROXY` (ver el comentario de `middlewares/rateLimit.ts`).
 *    Desplegado detrás de un proxy sin esa env, **todos** los compradores se ven con la IP del
 *    proxy: el primer canje mataría el cupón para la tienda entera.
 *  - Y se evade apagando el WiFi.
 * La IP igual se guarda en `coupon_redemptions.ip`, pero **solo como dato forense** para que el
 * dueño detecte patrones: ninguna decisión la consulta.
 *
 * **Sobre-fusiona a propósito.** El `+tag` se recorta en TODOS los dominios (no solo en los que
 * lo tratan como alias) y los puntos solo en Gmail/Googlemail. El costo asumido es que alguien
 * cuyo buzón realmente distinto sea `juan+trabajo@dominio.com` quede bloqueado; por eso el
 * mensaje de error del canje nombra el correo, para que entienda por qué y use el otro.
 *
 * No valida nada: el formato ya lo validó zod (`shippingSchema.email`). Lo único que garantiza
 * es que la misma persona produzca siempre la misma cadena, que es lo que el índice único
 * parcial de `coupon_redemptions` necesita para decidir la carrera.
 */
export function normalizeEmailIdentity(email: string): string {
  const trimmed = email.trim().toLowerCase();

  // `lastIndexOf`: la parte local puede llevar `@` entre comillas; el dominio, nunca.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed; // sin `@` (o empezando con él) no hay nada que normalizar

  let local = trimmed.slice(0, at);
  const host = trimmed.slice(at + 1);

  // `> 0` y no `>= 0`: un buzón que EMPIEZA con `+` no debe quedar vacío.
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  if (DOT_INSENSITIVE_HOSTS.has(host)) local = local.replace(/\./g, "");

  return `${local}@${host}`;
}
