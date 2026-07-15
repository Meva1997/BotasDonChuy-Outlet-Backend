/**
 * Formatea un monto en pesos con el estilo es-MX, p. ej. `$1,920.50`.
 * Compartido por el dashboard, el correo de confirmación y los mensajes de
 * error de producto, para que la misma cifra se lea igual en todos lados.
 */
export function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
