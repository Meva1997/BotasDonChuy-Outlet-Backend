import { z } from "zod";

/**
 * Compartidos con src/schemas/adminUser.ts: tempPassword/newPassword deben
 * cumplir la misma complejidad que loginSchema, o el usuario nunca podrá
 * pasar POST /api/auth/login con la contraseña que se le asignó.
 */
export const PASSWORD_UPPERCASE_REGEX = /[A-Z]/;
export const PASSWORD_NUMBER_REGEX = /[0-9]/;
export const PASSWORD_SYMBOL_REGEX = /[!@#$%^&*(),.?":{}|<>_\-+=]/;

export const loginSchema = z.object({
  email: z.email("Ingresa un correo electrónico válido"),
  password: z
    .string()
    .trim()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .regex(PASSWORD_UPPERCASE_REGEX, "La contraseña debe tener al menos una mayúscula")
    .regex(PASSWORD_NUMBER_REGEX, "La contraseña debe tener al menos un número")
    .regex(PASSWORD_SYMBOL_REGEX, "La contraseña debe tener al menos un signo"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.email("Ingresa un correo electrónico válido"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** Código de recuperación: 5 dígitos, solo numéricos. */
export const resetCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}$/, "El código debe ser de 5 dígitos");

export const verifyResetCodeSchema = z.object({
  email: z.email("Ingresa un correo electrónico válido"),
  code: resetCodeSchema,
});

export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>;

/**
 * Misma complejidad de contraseña que loginSchema/tempPassword: si fuera más
 * débil, el usuario podría quedar bloqueado del login tras el reset.
 */
export const resetPasswordSchema = z
  .object({
    email: z.email("Ingresa un correo electrónico válido"),
    code: resetCodeSchema,
    newPassword: z
      .string()
      .trim()
      .min(8, "La nueva contraseña debe tener al menos 8 caracteres")
      .regex(PASSWORD_UPPERCASE_REGEX, "La nueva contraseña debe tener al menos una mayúscula")
      .regex(PASSWORD_NUMBER_REGEX, "La nueva contraseña debe tener al menos un número")
      .regex(PASSWORD_SYMBOL_REGEX, "La nueva contraseña debe tener al menos un signo"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
