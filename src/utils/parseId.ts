import { AppError } from "../middlewares/AppError";

/**
 * Convierte el `:id` de la URL a entero positivo.
 *
 * Sin esta validación un id no numérico llega como `NaN` a Sequelize, Postgres
 * rechaza la consulta y el errorHandler lo degrada a un 500 "Error interno del
 * servidor" — un error del cliente disfrazado de caída del servidor.
 */
export function parseId(raw: string | string[] | undefined, label: string): number {
  // Express 5 tipa los params como `string | string[]`. Un array nunca es un id
  // válido, y hay que descartarlo explícitamente porque `Number(["7"])` es 7.
  const id = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(`El identificador de ${label} no es válido.`, 400);
  }
  return id;
}
