import { Router } from "express";
import {
  listAdminUsers,
  createAdminUser,
  deleteAdminUser,
} from "../controllers/adminUser.controller";
import { requireAuth } from "../middlewares/requireAuth";

const router: Router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     summary: Lista los usuarios del panel (sin passwordHash)
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array de administradores.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AdminUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/", listAdminUsers);

/**
 * @openapi
 * /api/admin/users:
 *   post:
 *     summary: Crea un nuevo usuario del panel con contraseña temporal
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAdminUserInput'
 *     responses:
 *       201:
 *         description: Usuario creado (sin passwordHash).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminUser'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: El correo ya está en uso.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", createAdminUser);

/**
 * @openapi
 * /api/admin/users/{id}:
 *   delete:
 *     summary: Elimina un usuario del panel
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Usuario eliminado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       400:
 *         description: No se puede eliminar la propia cuenta o al único propietario.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete("/:id", deleteAdminUser);

export default router;
