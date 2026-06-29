import { Router } from "express";
import { getProductById, getProducts } from "../controllers/product.controller";

const router: Router = Router();

/**
 * @openapi
 * /api/products:
 *   get:
 *     summary: Lista productos visibles con filtros y paginación
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: categoria
 *         schema:
 *           type: string
 *           enum: [bota, sombrero, ropa]
 *         description: Filtra por tipo de producto.
 *       - in: query
 *         name: talla
 *         schema:
 *           type: integer
 *         description: Filtra productos que tengan stock en esta talla.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Página (se ajusta al rango [1, totalPages]).
 *       - in: query
 *         name: perPage
 *         schema:
 *           type: integer
 *           default: 9
 *         description: Cantidad de productos por página.
 *     responses:
 *       200:
 *         description: Página de productos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProductListResponse'
 */
router.get("/", getProducts);

/**
 * @openapi
 * /api/products/{id}:
 *   get:
 *     summary: Obtiene un producto visible por su ID
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del producto.
 *     responses:
 *       200:
 *         description: Producto encontrado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         description: Producto no encontrado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/:id", getProductById);

export default router;
