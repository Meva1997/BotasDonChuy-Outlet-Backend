import type { NextFunction, Request, Response } from "express";
import jsonwebtoken from "jsonwebtoken";
import { JWT_SECRET } from "../config/auth";
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

export const requireAuth = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError("Necesitas iniciar sesión para acceder a esta sección.", 401);
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const decoded = jsonwebtoken.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    throw new AppError("Tu sesión expiró. Vuelve a iniciar sesión para continuar.", 401);
  }
};

export const requireRole =
  (...roles: AuthUser["role"][]) =>
  (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError("Tu cuenta no tiene permisos para realizar esta acción.", 403);
    }

    next();
  };
