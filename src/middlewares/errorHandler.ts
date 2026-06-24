import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
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

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ message: "Error interno del servidor" });
};
