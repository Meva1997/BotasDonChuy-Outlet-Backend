import type { Request, RequestHandler, Response } from "express";
import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { Product, type ProductAttributes, type ProductImage } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { productSizesInclude } from "../utils/productSizesInclude";
import { OrderItem } from "../models/OrderItem";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import {
  productSchema,
  productUpdateSchema,
  deleteProductImageSchema,
} from "../schemas/product";
import { sequelize } from "../config/database";
import { parseId } from "../utils/parseId";
import { formatMoney } from "../utils/formatMoney";
import { CLOUDINARY_PRODUCTS_FOLDER } from "../config/cloudinary";
import { uploadImageBuffer, destroyImage } from "../services/image.service";

const MAX_IMAGES_PER_PRODUCT = 3;

/**
 * Serializa un producto para las rutas PÚBLICAS: quita el `publicId` de cada
 * imagen (identificador interno de gestión de Cloudinary que solo necesitan las
 * rutas admin para borrar el asset). El storefront solo consume `url`/`imageSrc`.
 */
function toPublicProduct(product: Product): Record<string, unknown> {
  const json = product.toJSON() as Record<string, unknown> & { images?: ProductImage[] };
  if (Array.isArray(json.images)) {
    json.images = json.images.map((img) => ({ url: img.url })) as ProductImage[];
  }
  return json;
}

export const getProducts: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const categoria = req.query.categoria as string | undefined;
  // Talla inválida (no numérica/entera) se ignora en vez de colarse cruda a un
  // literal SQL: antes un valor basura solo dejaba `filtrados` vacío en memoria,
  // ahora rompería la subquery si no se descarta aquí.
  const tallaRaw = req.query.talla !== undefined ? Number(req.query.talla) : undefined;
  const talla = tallaRaw !== undefined && Number.isInteger(tallaRaw) ? tallaRaw : undefined;
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const perPage = Math.max(1, Math.floor(Number(req.query.perPage)) || 9);

  const where: WhereOptions<ProductAttributes> = { visible: true, deletedAt: { [Op.is]: null } };
  if (categoria) where.type = categoria;

  // "¿Tiene talla X con stock?" no es una columna de Product, así que se resuelve
  // como subquery contra product_sizes en vez de traer todo el catálogo a Node
  // para filtrar con `sizes.includes(talla)` (ver CLAUDE.md — paginación en SQL).
  // `talla` ya se validó como entero arriba, así que interpolarla directo en el
  // literal es seguro (Product.count no soporta `replacements`, a diferencia de
  // findAll/sequelize.query).
  if (talla !== undefined) {
    where.id = {
      [Op.in]: sequelize.literal(
        `(SELECT "productId" FROM product_sizes WHERE size = ${talla} AND stock > 0)`,
      ),
    };
  }

  // availableSizes refleja las tallas disponibles para la categoría completa
  // (no la talla ya elegida) para que el selector siga mostrando el resto de
  // opciones — igual que antes, se calcula aparte del filtro por talla.
  const availableSizesRows = await sequelize.query<{ size: number }>(
    `SELECT DISTINCT ps.size AS size
     FROM product_sizes ps
     INNER JOIN products p ON p.id = ps."productId"
     WHERE ps.stock > 0
       AND p.visible = true
       AND p."deletedAt" IS NULL
       ${categoria ? `AND p.type = :categoria` : ""}
     ORDER BY ps.size ASC`,
    {
      type: QueryTypes.SELECT,
      replacements: categoria ? { categoria } : undefined,
    },
  );
  const availableSizes = availableSizesRows.map((r) => r.size);

  const total = await Product.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const pageClamped = Math.min(Math.max(page, 1), totalPages); // clamp a [1, totalPages]
  const offset = (pageClamped - 1) * perPage;

  const productos = await Product.findAll({
    where,
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
    order: [["id", "ASC"]],
    limit: perPage,
    offset,
  });
  const products = productos.map(toPublicProduct);

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
  const id = parseId(req.params.id, "producto");

  const product = await Product.findOne({
    where: { id, visible: true, deletedAt: { [Op.is]: null } },
    attributes: { exclude: ["unitCost"] },
    include: [productSizesInclude],
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  res.json(toPublicProduct(product));
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
  const id = parseId(req.params.id, "producto");
  const product = await Product.findByPk(id, { include: [productSizesInclude] });
  if (!product) throw new AppError("Producto no encontrado", 404);

  const data = productUpdateSchema.parse(req.body);

  // El refine del schema solo compara cuando ambos precios vienen en el body.
  // En un update parcial hay que validar contra los valores ya guardados para
  // que no se pueda dejar salePrice > originalPrice enviando uno solo.
  const effectiveOriginalPrice = data.originalPrice ?? product.originalPrice;
  const effectiveSalePrice = data.salePrice ?? product.salePrice;
  if (effectiveSalePrice > effectiveOriginalPrice) {
    // Se nombran ambos precios: en un update parcial el que choca suele ser el
    // que YA estaba guardado, así que un mensaje sin cifras deja al admin
    // mirando un campo que ni siquiera tocó.
    throw new AppError(
      `El precio de oferta (${formatMoney(effectiveSalePrice)}) no puede ser mayor al precio original (${formatMoney(effectiveOriginalPrice)}).`,
      400,
    );
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
  const id = parseId(req.params.id, "producto");
  const product = await Product.findByPk(id);
  if (!product) throw new AppError("Producto no encontrado", 404);

  // Si el producto está referenciado por algún pedido, se hace soft-delete para
  // preservar el historial; si no, hard-delete (ProductSize cae por CASCADE).
  const referenced = await OrderItem.count({ where: { productId: id } });

  if (referenced > 0) {
    // Soft-delete: la fila (y sus imágenes) siguen en la BD para preservar el
    // historial de pedidos, así que sus assets deben permanecer en Cloudinary.
    await product.update({ deletedAt: new Date(), visible: false });
    res.json({ ok: true, softDeleted: true });
  } else {
    // Hard-delete: la fila desaparece, así que borramos también sus imágenes de
    // Cloudinary para no dejar assets huérfanos. Primero Cloudinary, luego la BD.
    await Promise.all((product.images ?? []).map((img) => destroyImage(img.publicId)));
    await sequelize.transaction(async (t) => {
      await ProductSize.destroy({ where: { productId: id }, transaction: t });
      await product.destroy({ transaction: t });
    });
    res.json({ ok: true, softDeleted: false });
  }
});

// ── Imágenes de producto (Cloudinary) ──────────────────────────────────────────

/**
 * Mensaje del tope de imágenes. Dice cuántas caben todavía (o que hay que
 * borrar alguna) en vez de solo enunciar el límite: así el admin sabe qué hacer
 * sin ponerse a contar las imágenes de la galería.
 */
function tooManyImagesMessage(current: number, incoming: number): string {
  const free = MAX_IMAGES_PER_PRODUCT - current;
  if (free <= 0) {
    return `Este producto ya tiene el máximo de ${MAX_IMAGES_PER_PRODUCT} imágenes. Borra alguna antes de subir otra.`;
  }
  return `Este producto ya tiene ${current} ${current === 1 ? "imagen" : "imágenes"} y estás subiendo ${incoming}: el máximo es ${MAX_IMAGES_PER_PRODUCT}. Puedes agregar ${free} más.`;
}

/**
 * Sube varios buffers a Cloudinary de forma "todo o nada": si alguna subida
 * falla, destruye las que sí se completaron y relanza, para no dejar assets
 * huérfanos cuando la operación no se persiste en la BD.
 */
async function uploadAllOrCleanup(
  files: Express.Multer.File[],
  folder: string,
): Promise<ProductImage[]> {
  const results = await Promise.allSettled(
    files.map((file) => uploadImageBuffer(file.buffer, folder)),
  );

  const uploaded = results
    .filter((r): r is PromiseFulfilledResult<ProductImage> => r.status === "fulfilled")
    .map((r) => r.value);

  if (uploaded.length !== files.length) {
    await Promise.all(uploaded.map((u) => destroyImage(u.publicId).catch(() => {})));
    throw new AppError("No se pudieron subir todas las imágenes. Intenta de nuevo.", 502);
  }

  return uploaded;
}

/**
 * POST /api/admin/products/:id/images
 * Sube de 1 a 3 imágenes (campo multipart `images`) a Cloudinary y las agrega al
 * producto, respetando el tope de 3 en total. `imageSrc` (VIRTUAL) refleja la primera.
 */
export const adminAddProductImages: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "producto");
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      throw new AppError(
        'No se recibió ninguna imagen. Adjunta de 1 a 3 archivos PNG, JPEG o WEBP en el campo "images".',
        400,
      );
    }

    const product = await Product.findByPk(id, { include: [productSizesInclude] });
    if (!product) throw new AppError("Producto no encontrado", 404);

    // Chequeo temprano (mejor UX: evita subir a Cloudinary si obviamente excede),
    // revalidado luego bajo el lock de fila contra concurrencia.
    if ((product.images ?? []).length + files.length > MAX_IMAGES_PER_PRODUCT) {
      throw new AppError(tooManyImagesMessage((product.images ?? []).length, files.length), 400);
    }

    // Sube todas o ninguna: si una falla, destruye las que sí subieron para no
    // dejar assets huérfanos en Cloudinary.
    const uploaded = await uploadAllOrCleanup(files, CLOUDINARY_PRODUCTS_FOLDER);

    // Persistir bajo un lock de fila (SELECT ... FOR UPDATE) serializa dos adds
    // concurrentes: sin él, ambos leen la misma galería y uno pisa al otro
    // (imágenes perdidas en BD → huérfanas en Cloudinary).
    try {
      await sequelize.transaction(async (t) => {
        const locked = await Product.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
        if (!locked) throw new AppError("Producto no encontrado", 404);

        const current = locked.images ?? [];
        if (current.length + uploaded.length > MAX_IMAGES_PER_PRODUCT) {
          throw new AppError(tooManyImagesMessage(current.length, uploaded.length), 400);
        }

        const images = [...current, ...uploaded];
        await locked.update({ images }, { transaction: t });
        // Reutiliza la instancia ya cargada con productSizes (evita un 2º findByPk):
        // imageSrc (VIRTUAL) deriva de images, que acabamos de setear.
        product.setDataValue("images", images);
      });
    } catch (err) {
      // La transacción no escribió nada; limpia los assets recién subidos.
      await Promise.all(uploaded.map((u) => destroyImage(u.publicId).catch(() => {})));
      throw err;
    }

    res.status(201).json(product);
  },
);

/**
 * DELETE /api/admin/products/:id/images
 * Borra una imagen (identificada por `publicId` en el body) del producto y de
 * Cloudinary; `imageSrc` (VIRTUAL) pasa a reflejar la nueva primera imagen (o null).
 */
export const adminDeleteProductImage: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "producto");
    const { publicId } = deleteProductImageSchema.parse(req.body);

    const product = await Product.findByPk(id, { include: [productSizesInclude] });
    if (!product) throw new AppError("Producto no encontrado", 404);

    // Bajo lock de fila para no pisar un add/delete concurrente. Se persiste el
    // cambio ANTES de borrar en Cloudinary (igual que uploadBrandLogo): así un
    // fallo del destroy deja un huérfano —no una referencia colgante que rompería
    // la imagen en la tienda—.
    await sequelize.transaction(async (t) => {
      const locked = await Product.findByPk(id, { lock: t.LOCK.UPDATE, transaction: t });
      if (!locked) throw new AppError("Producto no encontrado", 404);

      const current = locked.images ?? [];
      if (!current.some((img) => img.publicId === publicId)) {
        // Suele pasar cuando otra pestaña ya la borró: sin la pista de recargar,
        // el admin reintenta sobre una galería obsoleta y vuelve a fallar.
        throw new AppError(
          "Esa imagen ya no está en el producto. Recarga la página para ver la galería actualizada.",
          404,
        );
      }

      const images = current.filter((img) => img.publicId !== publicId);
      await locked.update({ images }, { transaction: t });
      // Reutiliza la instancia con productSizes ya cargados (evita un 2º findByPk).
      product.setDataValue("images", images);
    });

    // Cambio ya persistido: borrar el asset es best-effort. Si falla, queda un
    // huérfano en Cloudinary (aceptable) pero la BD queda consistente.
    await destroyImage(publicId).catch(() => {});

    res.json(product);
  },
);
