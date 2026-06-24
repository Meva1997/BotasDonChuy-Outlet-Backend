import { z } from "zod";

export const loginSchema = z.object({
  email: z.email("Ingresa un correo electrónico válido"),
  password: z
    .string()
    .trim()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .regex(/[A-Z]/, "La contraseña debe tener al menos una mayúscula")
    .regex(/[!@#$%^&*(),.?":{}|<>_\-+=]/, "La contraseña debe tener al menos un signo"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.email("Ingresa un correo electrónico válido"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
