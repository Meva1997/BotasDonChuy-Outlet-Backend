import type { Request, RequestHandler, Response } from "express";
import type { WhereOptions } from "sequelize";
import { Product, type ProductAttributes } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";

const productSizesInclude = {
  model: ProductSize,
  as: "productSizes",
  attributes: ["size", "stock"],
};

export const getProducts: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const categoria = req.query.categoria as string | undefined;
  const talla = req.query.talla ? Number(req.query.talla) : undefined;
  const page = Number(req.query.page) || 1;
  const perPage = Number(req.query.perPage) || 9;
  const where: WhereOptions<ProductAttributes> = { visible: true };
  if (categoria) where.type = categoria;

  const productos = await Product.findAll({
    where,
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
  });

  const availableSizes = [...new Set(productos.flatMap((p) => p.sizes))].sort(
    (a, b) => a - b,
  );

  const filtrados = talla
    ? productos.filter((p) => p.sizes.includes(talla))
    : productos;

  const total = filtrados.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const pageClamped = Math.min(Math.max(page, 1), totalPages); // clamp a [1, totalPages]
  const inicio = (pageClamped - 1) * perPage;
  const products = filtrados.slice(inicio, inicio + perPage);

  res.json({
    products,
    total,
    page: pageClamped,
    perPage,
    totalPages,
    availableSizes,
  });
});

export const getProductById: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const product = await Product.findOne({
    where: { id, visible: true },
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  res.json(product);
});
