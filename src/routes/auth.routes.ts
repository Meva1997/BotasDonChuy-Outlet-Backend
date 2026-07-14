import { Router } from "express";
import {
  login,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  me,
} from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/requireAuth";
import { authRateLimiter } from "../middlewares/rateLimit";

const router: Router = Router();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Autentica a un administrador y devuelve un JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginInput'
 *     responses:
 *       200:
 *         description: Credenciales válidas.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: Datos inválidos (validación Zod).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Email o contraseña incorrectos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados intentos (rate limit, 10 por 15 min).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/login", authRateLimiter, login);

/**
 * @openapi
 * /api/auth/forgot-password:
 *   post:
 *     summary: Envía un código de 5 dígitos para restablecer la contraseña (siempre responde ok)
 *     description: >
 *       Si el correo existe, genera un código de recuperación de 5 dígitos numéricos,
 *       lo guarda hasheado (expira en 15 min) y lo envía por correo. Responde
 *       `{ ok: true }` exista o no el correo, para no revelar si está registrado.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ForgotPasswordInput'
 *     responses:
 *       200:
 *         description: Solicitud recibida.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Datos inválidos (validación Zod).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados intentos (rate limit, 10 por 15 min).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/forgot-password", authRateLimiter, forgotPassword);

/**
 * @openapi
 * /api/auth/verify-reset-code:
 *   post:
 *     summary: Verifica el código de recuperación (desbloquea la página de reset en el front)
 *     description: >
 *       Valida que el código coincida con el enviado y no haya expirado ni agotado
 *       los intentos. **No consume el código** (se revalida al actualizar la contraseña).
 *       En caso de fallo incrementa el contador de intentos; tras 5 fallos el código
 *       se invalida.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerifyResetCodeInput'
 *     responses:
 *       200:
 *         description: Código válido.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Código inválido o expirado (mensaje genérico).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados intentos (rate limit, 10 por 15 min).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/verify-reset-code", authRateLimiter, verifyResetCode);

/**
 * @openapi
 * /api/auth/reset-password:
 *   post:
 *     summary: Restablece la contraseña usando el código de recuperación
 *     description: >
 *       Revalida el código (nunca confía solo en el paso de verificación del front),
 *       actualiza la contraseña y quema el código (un solo uso). La nueva contraseña
 *       exige la misma complejidad que el login.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ResetPasswordInput'
 *     responses:
 *       200:
 *         description: Contraseña actualizada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Código inválido/expirado o datos inválidos (validación Zod).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Demasiados intentos (rate limit, 10 por 15 min).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/reset-password", authRateLimiter, resetPassword);

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     summary: Devuelve el usuario autenticado a partir del JWT
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Usuario autenticado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/AuthUser'
 *       401:
 *         description: Token ausente, inválido o expirado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/me", requireAuth, me);

export default router;
