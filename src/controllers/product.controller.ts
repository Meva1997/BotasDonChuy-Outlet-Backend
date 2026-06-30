import type { Request, RequestHandler, Response } from "express";
import { Op, type WhereOptions } from "sequelize";
import { Product, type ProductAttributes } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { OrderItem } from "../models/OrderItem";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import { productSchema, productUpdateSchema } from "../schemas/product";
import { sequelize } from "../config/database";

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
  const where: WhereOptions<ProductAttributes> = { visible: true, deletedAt: { [Op.is]: null } };
  if (categoria) where.type = categoria;

  const productos = await Product.findAll({
    where,
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
  });

  const availableSizes = [
    ...new Set(
      productos.flatMap(
        (p) => p.productSizes?.filter((ps) => ps.stock > 0).map((ps) => ps.size) ?? [],
      ),
    ),
  ].sort((a, b) => a - b);

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
    where: { id, visible: true, deletedAt: { [Op.is]: null } },
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  res.json(product);
});

// ── Admin handlers ────────────────────────────────────────────────────────────

/** Agrupa un array de tallas repetidas en filas { size, stock }. */
function sizesToRows(sizes: number[]): { size: number; stock: number }[] {
  const map = new Map<number, number>();
  for (const s of sizes) map.set(s, (map.get(s) ?? 0) + 1);
  return Array.from(map.entries()).map(([size, stock]) => ({ size, stock }));
}

export const adminGetProducts: RequestHandler = asyncHandler(async (_req: Request, res: Response) => {
  const products = await Product.findAll({
    include: [productSizesInclude],
  });
  res.json(products);
});

export const adminCreateProduct: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const data = productSchema.parse(req.body);

  const product = await sequelize.transaction(async (t) => {
    const created = await Product.create(
      {
        name: data.name,
        description: data.description ?? undefined,
        originalPrice: data.originalPrice,
        salePrice: data.salePrice,
        unitCost: data.unitCost,
        type: data.type,
        imageSrc: data.imageSrc ?? undefined,
        code: data.code ?? undefined,
        weightKg: data.weightKg,
        lengthCm: data.lengthCm,
        widthCm: data.widthCm,
        heightCm: data.heightCm,
        visible: data.visible,
      },
      { transaction: t },
    );

    const rows = sizesToRows(data.sizes);
    await ProductSize.bulkCreate(
      rows.map((r) => ({ productId: created.id, ...r })),
      { transaction: t },
    );

    return created;
  });

  const full = await Product.findByPk(product.id, { include: [productSizesInclude] });
  res.status(201).json(full);
});

export const adminUpdateProduct: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const product = await Product.findByPk(id, { include: [productSizesInclude] });
  if (!product) throw new AppError("Producto no encontrado", 404);

  const data = productUpdateSchema.parse(req.body);

  // El refine del schema solo compara cuando ambos precios vienen en el body.
  // En un update parcial hay que validar contra los valores ya guardados para
  // que no se pueda dejar salePrice > originalPrice enviando uno solo.
  const effectiveOriginalPrice = data.originalPrice ?? product.originalPrice;
  const effectiveSalePrice = data.salePrice ?? product.salePrice;
  if (effectiveSalePrice > effectiveOriginalPrice) {
    throw new AppError("El precio de oferta no puede ser mayor al precio original", 400);
  }

  await sequelize.transaction(async (t) => {
    const { sizes, ...fields } = data;
    if (Object.keys(fields).length) {
      await product.update(fields, { transaction: t });
    }

    if (sizes !== undefined) {
      await ProductSize.destroy({ where: { productId: id }, transaction: t });
      const rows = sizesToRows(sizes);
      await ProductSize.bulkCreate(
        rows.map((r) => ({ productId: id, ...r })),
        { transaction: t },
      );
    }
  });

  const updated = await Product.findByPk(id, { include: [productSizesInclude] });
  res.json(updated);
});

export const adminDeleteProduct: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const product = await Product.findByPk(id);
  if (!product) throw new AppError("Producto no encontrado", 404);

  // Si el producto está referenciado por algún pedido, se hace soft-delete para
  // preservar el historial; si no, hard-delete (ProductSize cae por CASCADE).
  const referenced = await OrderItem.count({ where: { productId: id } });

  if (referenced > 0) {
    await product.update({ deletedAt: new Date(), visible: false });
    res.json({ ok: true, softDeleted: true });
  } else {
    await sequelize.transaction(async (t) => {
      await ProductSize.destroy({ where: { productId: id }, transaction: t });
      await product.destroy({ transaction: t });
    });
    res.json({ ok: true, softDeleted: false });
  }
});
