import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { UniqueConstraintError, ValidationError as SequelizeValidationError } from "sequelize";
import { AppError } from "./AppError";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";

interface ErrorDetail {
  path: string;
  message: string;
}

/** Cuántos mensajes de campo caben en `message` antes de resumir el resto. */
const MAX_FIELDS_IN_MESSAGE = 3;

/**
 * Errores que lanza body-parser (el `express.json()` global) al no poder leer el
 * cuerpo. Traen su propio `type`/`status`; sin esta rama caían al 500 genérico,
 * o sea que un JSON mal formado del cliente se reportaba como caída del servidor.
 */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

const BODY_PARSER_MESSAGES: Record<string, string> = {
  "entity.parse.failed": "El cuerpo de la petición no es un JSON válido.",
  "entity.too.large": "El cuerpo de la petición es demasiado grande.",
  "encoding.unsupported": "La codificación del cuerpo de la petición no está soportada.",
};

function bodyParserMessage(err: unknown): { message: string; status: number } | null {
  if (!(err instanceof Error)) return null;
  const { type, status } = err as BodyParserError;
  if (typeof type !== "string") return null;
  const message = BODY_PARSER_MESSAGES[type];
  return message ? { message, status: status ?? 400 } : null;
}

/** Etiquetas en español de las columnas con índice único, para nombrar el 409. */
const UNIQUE_FIELD_LABELS: Record<string, string> = {
  email: "correo",
  code: "código",
};

/**
 * Arma el `message` a partir de los mensajes por campo de una validación.
 * El front solo pinta `message` (ningún componente lee `details`), así que un
 * "Datos inválidos" seco dejaba al usuario sin saber QUÉ corregir pese a que los
 * schemas ya traen mensajes específicos.
 *
 * Se toma un solo mensaje por campo —una contraseña débil dispara 4 issues del
 * mismo path— y se cortan a MAX_FIELDS_IN_MESSAGE para no armar un párrafo.
 */
function messageFromDetails(details: ErrorDetail[]): string {
  const firstByPath = new Map<string, string>();
  for (const detail of details) {
    if (!firstByPath.has(detail.path)) firstByPath.set(detail.path, detail.message);
  }

  const messages = [...firstByPath.values()];
  if (messages.length === 0) return "Revisa los datos enviados.";

  const shown = messages.slice(0, MAX_FIELDS_IN_MESSAGE);
  const rest = messages.length - shown.length;
  if (rest === 0) return shown.join(" · ");

  return `${shown.join(" · ")} (y ${rest} ${rest === 1 ? "campo más" : "campos más"} por corregir)`;
}

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ZodError) {
    const details: ErrorDetail[] = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json({ message: messageFromDetails(details), details });
    return;
  }

  if (err instanceof UniqueConstraintError) {
    // Red de seguridad del TOCTOU: los controllers ya pre-chequean el correo
    // duplicado con su propio mensaje. Si algo llega hasta aquí, al menos se
    // nombra el campo en vez de un "el registro ya existe" que no dice qué tocar.
    const fields = [...new Set(err.errors.map((e) => e.path).filter(Boolean))];
    const label = fields.map((f) => UNIQUE_FIELD_LABELS[f!] ?? f).join(", ");
    res.status(409).json({
      message: label
        ? `Ya existe un registro con ese ${label}. Usa otro.`
        : "Ese registro ya existe.",
    });
    return;
  }

  if (err instanceof SequelizeValidationError) {
    // A diferencia de los de zod, estos mensajes los redacta Sequelize en inglés
    // y nombran columnas ("Product.name cannot be null"), así que NO se promueven
    // a `message`: se responde un texto propio y el detalle queda en `details`.
    // Es una red de seguridad — zod valida el body antes de cualquier escritura,
    // así que una petición bien formada no debería llegar aquí.
    res.status(400).json({
      message: "Revisa los datos enviados: falta un campo requerido o alguno tiene un formato inválido.",
      details: err.errors.map((e) => ({ path: String(e.path ?? ""), message: e.message })),
    });
    return;
  }

  // Errores de multer al parsear multipart/form-data (subida de imágenes): sin
  // esta rama caerían al 500 genérico. Los mapeamos a 400 con mensaje claro.
  if (err instanceof MulterError) {
    // El importador masivo (POST /api/admin/products/import, campo "file") usa un límite y un
    // tipo de archivo (.xlsx) distintos a las imágenes/logo — sin esta rama, un archivo >2MB
    // mostraría el mensaje de "5 MB" pensado para imágenes.
    if (err.field === "file") {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "El archivo es demasiado grande (máximo 2 MB)."
          : 'Error al subir el archivo. Sube un Excel (.xlsx) en el campo "file".';
      res.status(400).json({ message });
      return;
    }
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "La imagen es demasiado grande (máximo 5 MB)."
        : err.code === "LIMIT_FILE_COUNT"
          ? "Demasiadas imágenes (máximo 3 por producto)."
          : // LIMIT_UNEXPECTED_FILE se dispara tanto por exceder el tope como por
            // un nombre de campo equivocado; el `field` lo distingue.
            err.code === "LIMIT_UNEXPECTED_FILE"
            ? `Campo de archivo inesperado${err.field ? ` ("${err.field}")` : ""}: usa "images" (producto) o "logo" (marca), máximo 3 imágenes.`
            : "Error al subir el archivo.";
    res.status(400).json({ message });
    return;
  }

  const bodyParser = bodyParserMessage(err);
  if (bodyParser) {
    res.status(bodyParser.status).json({ message: bodyParser.message });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  // El log estructurado es el rastro siempre-activo; Sentry es el índice consultable/
  // alertable encima de él (no-op seguro si SENTRY_DSN nunca se configuró).
  logger.error({ err }, "Error no manejado llegó al errorHandler");
  Sentry.captureException(err);
  res.status(500).json({ message: "Error interno del servidor" });
};
