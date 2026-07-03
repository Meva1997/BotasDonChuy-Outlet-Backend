import type { RequestHandler, Response } from "express";
import { AdminUser, type AdminUserAttributes } from "../models/AdminUser";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import type { AuthRequest } from "../middlewares/requireAuth";
import { createAdminUserSchema, updateAccountSchema } from "../schemas/adminUser";
import { hashPassword, comparePassword } from "../utils/password";
import { sequelize } from "../config/database";

export const listAdminUsers: RequestHandler = asyncHandler(
  async (_req, res: Response) => {
    const users = await AdminUser.findAll({
      attributes: { exclude: ["passwordHash"] },
      order: [["id", "ASC"]],
    });
    res.json(users);
  },
);

export const createAdminUser: RequestHandler = asyncHandler(
  async (req, res: Response) => {
    const data = createAdminUserSchema.parse(req.body);

    const existing = await AdminUser.findOne({ where: { email: data.email } });
    if (existing) throw new AppError("Ese correo ya está en uso", 409);

    const passwordHash = await hashPassword(data.tempPassword);
    const user = await AdminUser.create({
      name: data.name,
      email: data.email,
      passwordHash,
      role: data.role,
    });

    const { passwordHash: _omit, ...safeUser } = user.toJSON() as AdminUserAttributes;
    res.status(201).json(safeUser);
  },
);

export const deleteAdminUser: RequestHandler = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError("Id inválido", 400);

    if (String(id) === req.user!.id) {
      throw new AppError("No puedes eliminar tu propia cuenta", 400);
    }

    await sequelize.transaction(async (t) => {
      const user = await AdminUser.findByPk(id, { transaction: t });
      if (!user) throw new AppError("Usuario no encontrado", 404);

      if (user.role === "owner") {
        // SELECT ... FOR UPDATE sobre las filas "owner": serializa este check
        // contra cualquier otro DELETE concurrente de un owner distinto, para
        // que dos borrados a la vez no lean el mismo conteo pre-borrado y
        // dejen el panel en 0 owners.
        const owners = await AdminUser.findAll({
          where: { role: "owner" },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (owners.length <= 1) {
          throw new AppError("No puedes eliminar al único propietario", 400);
        }
      }

      await user.destroy({ transaction: t });
    });

    res.json({ ok: true });
  },
);

export const updateOwnAccount: RequestHandler = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const data = updateAccountSchema.parse(req.body);

    const user = await AdminUser.findByPk(Number(req.user!.id));
    if (!user) throw new AppError("Usuario no encontrado", 404);

    const passwordMatches = await comparePassword(data.currentPassword, user.passwordHash);
    if (!passwordMatches) throw new AppError("Contraseña actual incorrecta", 401);

    const updates: Partial<Pick<AdminUserAttributes, "email" | "passwordHash">> = {};

    if (data.email && data.email !== user.email) {
      const existing = await AdminUser.findOne({ where: { email: data.email } });
      if (existing) throw new AppError("Ese correo ya está en uso", 409);
      updates.email = data.email;
    }

    if (data.newPassword) {
      updates.passwordHash = await hashPassword(data.newPassword);
    }

    await user.update(updates);
    res.json({ ok: true });
  },
);
