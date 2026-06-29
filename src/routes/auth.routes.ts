import { Router } from "express";
import { login, forgotPassword, me } from "../controllers/auth.controller";
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
 *     summary: Solicita restablecer la contraseña (siempre responde ok)
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
