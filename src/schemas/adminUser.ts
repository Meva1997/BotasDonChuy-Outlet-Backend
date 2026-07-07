import { z } from "zod";
import { PASSWORD_UPPERCASE_REGEX, PASSWORD_NUMBER_REGEX, PASSWORD_SYMBOL_REGEX } from "./auth";

export const createAdminUserSchema = z.object({
  name: z.string().trim().min(2, "El nombre es muy corto").max(120),
  email: z.email("Ingresa un correo electrónico válido"),
  tempPassword: z
    .string()
    .trim()
    .min(8, "La contraseña temporal debe tener al menos 8 caracteres")
    .regex(PASSWORD_UPPERCASE_REGEX, "La contraseña temporal debe tener al menos una mayúscula")
    .regex(PASSWORD_NUMBER_REGEX, "La contraseña temporal debe tener al menos un número")
    .regex(PASSWORD_SYMBOL_REGEX, "La contraseña temporal debe tener al menos un signo"),
  role: z.enum(["owner", "admin"]).optional().default("admin"),
});

export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;

export const updateAccountSchema = z
  .object({
    currentPassword: z.string().min(1, "La contraseña actual es requerida"),
    email: z.email("Ingresa un correo electrónico válido").optional(),
    newPassword: z
      .string()
      .trim()
      .min(8, "La nueva contraseña debe tener al menos 8 caracteres")
      .regex(PASSWORD_UPPERCASE_REGEX, "La nueva contraseña debe tener al menos una mayúscula")
      .regex(PASSWORD_NUMBER_REGEX, "La nueva contraseña debe tener al menos un número")
      .regex(PASSWORD_SYMBOL_REGEX, "La nueva contraseña debe tener al menos un signo")
      .optional(),
    confirmPassword: z.string().optional(),
  })
  .refine((data) => data.email !== undefined || data.newPassword !== undefined, {
    message: "Debes actualizar el correo o la contraseña",
  })
  .refine((data) => !data.newPassword || data.newPassword === data.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  });

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
