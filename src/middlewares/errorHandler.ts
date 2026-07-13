import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { UniqueConstraintError, ValidationError as SequelizeValidationError } from "sequelize";
import { AppError } from "./AppError";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ZodError) {
    res.status(400).json({
      message: "Datos inválidos",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof UniqueConstraintError) {
    res.status(409).json({ message: "El registro ya existe" });
    return;
  }

  if (err instanceof SequelizeValidationError) {
    res.status(400).json({
      message: "Datos inválidos",
      details: err.errors.map((e) => ({ path: e.path, message: e.message })),
    });
    return;
  }

  // Errores de multer al parsear multipart/form-data (subida de imágenes): sin
  // esta rama caerían al 500 genérico. Los mapeamos a 400 con mensaje claro.
  if (err instanceof MulterError) {
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

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ message: "Error interno del servidor" });
};
