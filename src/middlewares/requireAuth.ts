import type { NextFunction, Request, Response } from "express";
import { AppError } from "./AppError";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin";
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Placeholder: solo valida que venga un Bearer token, sin verificar el JWT
// todavía. La verificación real (jsonwebtoken.verify + adjuntar req.user)
// se implementa en Fase 2.
export const requireAuth = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError("No autenticado", 401);
  }

  next();
};

// Placeholder: la validación de rol real depende de req.user, que aún no
// se llena hasta que requireAuth verifique el JWT en Fase 2.
export const requireRole =
  (...roles: AuthUser["role"][]) =>
  (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError("No autorizado", 403);
    }

    next();
  };
