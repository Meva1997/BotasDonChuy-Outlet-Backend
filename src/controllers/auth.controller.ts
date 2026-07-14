import type { RequestHandler, Response } from "express";
import jsonwebtoken, { type SignOptions } from "jsonwebtoken";
import { AdminUser } from "../models/AdminUser";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import { AuthRequest, AuthUser } from "../middlewares/requireAuth";
import {
  loginSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
} from "../schemas/auth";
import { comparePassword, hashPassword } from "../utils/password";
import {
  generateResetCode,
  hashResetCode,
  verifyResetCode as matchResetCode,
  RESET_CODE_TTL_MINUTES,
  RESET_CODE_MAX_ATTEMPTS,
} from "../utils/resetCode";
import { sendEmail } from "../services/email.service";
import { passwordResetCodeTemplate } from "../services/email/templates/passwordResetCode";
import { sequelize } from "../config/database";

/**
 * Hash señuelo (sha256 de 64 hex) usado cuando no hay código guardado, para que
 * la comparación en tiempo constante corra igual exista o no el usuario y no se
 * filtre por tiempo si el correo está registrado.
 */
const DUMMY_RESET_HASH = "0".repeat(64);

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
    const { email } = forgotPasswordSchema.parse(req.body);

    const user = await AdminUser.findOne({ where: { email } });

    // Si el correo existe, generamos y enviamos el código; si no, no hacemos
    // nada. En ambos casos respondemos igual para no revelar si el correo está
    // registrado (§6 del ROADMAP).
    if (user) {
      const code = generateResetCode();
      const codeHash = hashResetCode(code);
      const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000);

      await user.update({
        resetPasswordCodeHash: codeHash,
        resetPasswordExpiresAt: expiresAt,
        resetPasswordAttempts: 0,
      });

      // sendEmail loguea pero nunca lanza: un fallo de Resend no debe tumbar
      // este request (siempre responde ok). La idempotencyKey se deriva del hash
      // del código (único por código) y no del tiempo de expiración: dos
      // solicitudes en el mismo milisegundo generan códigos distintos, y keyearlas
      // por tiempo colapsaría ambas en un solo envío dejando al usuario un código
      // que no coincide con el guardado.
      await sendEmail({
        to: user.email,
        subject: "Tu código de recuperación · Botas Don Chuy",
        html: passwordResetCodeTemplate({ code, name: user.name }),
        idempotencyKey: `password-reset/${user.id}/${codeHash}`,
      });
    }

    res.json({ ok: true });
  },
);

/**
 * Valida que el código recibido coincida con el guardado y no haya expirado ni
 * agotado los intentos. Compartido por verifyResetCode y resetPassword. Cada
 * fallo incrementa el contador; al llegar al máximo, quema el código. Los
 * mensajes de error son genéricos e idénticos para no revelar la causa exacta
 * (correo inexistente / código malo / expirado).
 */
async function assertValidResetCode(
  email: string,
  code: string,
): Promise<AdminUser> {
  const invalid = new AppError("Código inválido o expirado", 400);

  // El check + incremento de intentos corre bajo un lock de fila (SELECT ...
  // FOR UPDATE): sin él, dos peticiones concurrentes con códigos errados leen
  // el mismo contador y ambas lo suben a 1, sorteando el límite de intentos.
  // Devolvemos null (nunca lanzamos) DENTRO de la transacción para que el
  // incremento se confirme; un throw haría rollback y perdería el conteo.
  const user = await sequelize.transaction(async (t) => {
    const found = await AdminUser.findOne({
      where: { email },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    // Comparación siempre en tiempo constante (contra un hash señuelo si no hay
    // código guardado) para no revelar por tiempo si el correo existe.
    const storedHash = found?.resetPasswordCodeHash ?? null;
    const matches = matchResetCode(code, storedHash ?? DUMMY_RESET_HASH);

    const expired =
      !found?.resetPasswordExpiresAt ||
      found.resetPasswordExpiresAt.getTime() < Date.now();

    // Un código quemado deja resetPasswordCodeHash en null, así que !storedHash
    // ya cubre el caso de intentos agotados (no hace falta un check aparte).
    if (!found || !storedHash || expired) {
      return null;
    }

    if (!matches) {
      const attempts = found.resetPasswordAttempts + 1;
      if (attempts >= RESET_CODE_MAX_ATTEMPTS) {
        // Demasiados intentos: quema el código para que no se pueda seguir probando.
        await found.update(
          {
            resetPasswordCodeHash: null,
            resetPasswordExpiresAt: null,
            resetPasswordAttempts: 0,
          },
          { transaction: t },
        );
      } else {
        await found.update({ resetPasswordAttempts: attempts }, { transaction: t });
      }
      return null;
    }

    return found;
  });

  if (!user) throw invalid;
  return user;
}

export const verifyResetCode: RequestHandler = asyncHandler(
  async (req, res: Response) => {
    const { email, code } = verifyResetCodeSchema.parse(req.body);

    // Solo valida (desbloquea la página del front). NO consume el código: se
    // revalida al actualizar la contraseña, para no confiar solo en el front.
    await assertValidResetCode(email, code);

    res.json({ ok: true });
  },
);

export const resetPassword: RequestHandler = asyncHandler(
  async (req, res: Response) => {
    const { email, code, newPassword } = resetPasswordSchema.parse(req.body);

    const user = await assertValidResetCode(email, code);

    // Código válido: actualiza la contraseña y quema el código (un solo uso).
    await user.update({
      passwordHash: await hashPassword(newPassword),
      resetPasswordCodeHash: null,
      resetPasswordExpiresAt: null,
      resetPasswordAttempts: 0,
    });

    res.json({ ok: true });
  },
);

export const me: RequestHandler = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    res.json({ user: req.user });
  },
);
