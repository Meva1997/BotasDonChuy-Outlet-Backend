import type { RequestHandler, Response } from "express";
import jsonwebtoken, { type SignOptions } from "jsonwebtoken";
import { AdminUser } from "../models/AdminUser";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import { AuthRequest, AuthUser } from "../middlewares/requireAuth";
import { loginSchema, forgotPasswordSchema } from "../schemas/auth";
import { comparePassword } from "../utils/password";

export const login: RequestHandler = asyncHandler(
  async (req, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await AdminUser.findOne({ where: { email } });
    if (!user) {
      throw new AppError("Email incorrecto", 401);
    }

    const passwordMatches = await comparePassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw new AppError("Contraseña incorrecta", 401);
    }

    const payload: AuthUser = {
      id: String(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
    };

    const token = jsonwebtoken.sign(payload, process.env.JWT_SECRET!, {
      expiresIn: process.env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
    });

    res.json({ token, user: payload });
  },
);

export const forgotPassword: RequestHandler = asyncHandler(
  async (req, res: Response) => {
    forgotPasswordSchema.parse(req.body);

    res.json({ ok: true });
  },
);

export const me: RequestHandler = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    res.json({ user: req.user });
  },
);
