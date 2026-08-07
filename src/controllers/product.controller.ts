import type { Request, RequestHandler, Response } from "express";
import { Op, QueryTypes, type Order, type WhereOptions } from "sequelize";
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
import { escapeLike } from "../utils/escapeLike";
import { formatMoney } from "../utils/formatMoney";
import { CLOUDINARY_PRODUCTS_FOLDER } from "../config/cloudinary";
import { uploadImageBuffer, destroyImage } from "../services/image.service";
import { sizesToRows } from "../utils/sizesToRows";
import { NO_SIZE_SENTINEL } from "../utils/noSizeSentinel";
import { parseImportWorkbook, previewImport, commitImport } from "../services/productImport.service";
import { productImportCommitSchema } from "../schemas/productImport";

const MAX_IMAGES_PER_PRODUCT = 3;

/** Largo máximo de `?q=`. Nadie busca frases más largas y acota el patrón que llega a Postgres. */
const MAX_SEARCH_LENGTH = 100;

/**
 * Órdenes admitidas por `?orden=` en el catálogo público.
 *
 * `precio_asc`/`precio_desc` llevan `id` como desempate: sin él, dos productos al mismo precio
 * pueden salir en distinto orden entre una página y la siguiente (Postgres no garantiza un orden
 * estable) y el cliente vería uno repetido y otro perdido al paginar.
 */
const ORDENES = {
  precio_asc: [
    ["salePrice", "ASC"],
    ["id", "ASC"],
  ],
  // El desempate va en la MISMA dirección que el precio a propósito: así el índice parcial
  // ("salePrice", "id") resuelve también este orden con un recorrido hacia atrás, sin sort.
  precio_desc: [
    ["salePrice", "DESC"],
    ["id", "DESC"],
  ],
  novedad: [["id", "DESC"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

const ORDEN_DEFAULT = [["id", "ASC"]] as const;

/**
 * Lee un precio de la query string. Devuelve `undefined` si no es un número finito y no negativo,
 * para que un valor basura se ignore en vez de romper la consulta — misma regla permisiva que
 * `talla` con `Number.isInteger`.
 */
function parsePrecio(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const precio = Number(raw);
  return Number.isFinite(precio) && precio >= 0 ? precio : undefined;
}

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
  // El `.trim()` y el `> 0` no son cosméticos: `?talla=` (vacío) daba `Number("") === 0`, que
  // `Number.isInteger` acepta, así que filtraba por `size = 0` y devolvía el catálogo VACÍO.
  const tallaRaw = typeof req.query.talla === "string" ? req.query.talla.trim() : "";
  const tallaNum = tallaRaw !== "" ? Number(tallaRaw) : NaN;
  const talla = Number.isInteger(tallaNum) && tallaNum > 0 ? tallaNum : undefined;
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const perPage = Math.max(1, Math.floor(Number(req.query.perPage)) || 9);

  // Búsqueda por texto. Un `q` en blanco o de puros espacios no es un filtro, es un input vacío:
  // se ignora en vez de buscar la cadena "" (que emparejaría con todo).
  const qRaw =
    typeof req.query.q === "string" ? req.query.q.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  // `escapeLike` es obligatorio aquí: Sequelize parametriza el valor pero no escapa `%`/`_`,
  // así que sin él `?q=100%` devolvería el catálogo completo (ver src/utils/escapeLike.ts).
  const patron = qRaw.length > 0 ? `%${escapeLike(qRaw)}%` : undefined;

  // Rango de precio sobre salePrice. Si min > max no se corrige ni se intercambian: la consulta
  // devuelve vacío, que es la respuesta honesta a lo que el cliente pidió.
  const precioMin = parsePrecio(req.query.precioMin);
  const precioMax = parsePrecio(req.query.precioMax);
  const precioRange =
    precioMin !== undefined || precioMax !== undefined
      ? {
          ...(precioMin !== undefined ? { [Op.gte]: precioMin } : {}),
          ...(precioMax !== undefined ? { [Op.lte]: precioMax } : {}),
        }
      : undefined;

  // Un `orden` no reconocido cae al orden por defecto en vez de dar 400, igual que una talla
  // inválida: son filtros de un listado público, no datos que el cliente esté escribiendo.
  const ordenKey = req.query.orden as keyof typeof ORDENES | undefined;
  const orden = ordenKey && ordenKey in ORDENES ? ORDENES[ordenKey] : ORDEN_DEFAULT;

  // El `where` se arma como un solo literal (en vez de mutarlo campo por campo) porque `Op.or`
  // es una clave `symbol` y asignarla por mutación sobre un `WhereOptions` obliga a un cast.
  // Lo que importa es que sea EL MISMO objeto para `count` y `findAll`, o `total`/`totalPages`
  // mentirían respecto de la página devuelta.
  const where: WhereOptions<ProductAttributes> = {
    visible: true,
    deletedAt: { [Op.is]: null },
    ...(categoria ? { type: categoria } : {}),
    // "¿Tiene talla X con stock?" no es una columna de Product, así que se resuelve
    // como subquery contra product_sizes en vez de traer todo el catálogo a Node
    // para filtrar con `sizes.includes(talla)` (ver CLAUDE.md — paginación en SQL).
    // `talla` ya se validó como entero arriba, así que interpolarla directo en el
    // literal es seguro (Product.count no soporta `replacements`, a diferencia de
    // findAll/sequelize.query).
    ...(talla !== undefined
      ? {
          id: {
            [Op.in]: sequelize.literal(
              `(SELECT "productId" FROM product_sizes WHERE size = ${talla} AND stock > 0)`,
            ),
          },
        }
      : {}),
    // `Op.iLike` es un operador, no un literal crudo, así que `Product.count` lo soporta igual
    // que `findAll` — no repite la limitación que obliga a interpolar `talla` a mano.
    // `code` es nullable: en esas filas `code ILIKE ...` da NULL, y `NULL OR true` sigue siendo
    // true, así que el OR se comporta bien sin un COALESCE.
    ...(patron
      ? { [Op.or]: [{ name: { [Op.iLike]: patron } }, { code: { [Op.iLike]: patron } }] }
      : {}),
    ...(precioRange ? { salePrice: precioRange } : {}),
  };

  // availableSizes alimenta el selector de tallas, así que se acota por los MISMOS filtros que
  // la lista (categoría, búsqueda y precio) pero NO por la `talla` ya elegida: si se acotara por
  // ella, elegir una talla vaciaría el propio selector y no habría forma de cambiarla. Al
  // acotarlo por `q`/precio se evita el callejón contrario: ofrecer una talla que no existe
  // dentro de la búsqueda actual y devolver cero resultados al elegirla.
  const availableSizesRows = await sequelize.query<{ size: number }>(
    `SELECT DISTINCT ps.size AS size
     FROM product_sizes ps
     INNER JOIN products p ON p.id = ps."productId"
     WHERE ps.stock > 0
       AND p.visible = true
       AND p."deletedAt" IS NULL
       -- Sin este filtro, la fila centinela (size: NO_SIZE_SENTINEL) de un producto sin tallas
       -- se colaría como "talla 0" en el selector de tallas del catálogo.
       AND p."hasSizes" = true
       ${categoria ? `AND p.type = :categoria` : ""}
       ${patron ? `AND (p.name ILIKE :patron OR p.code ILIKE :patron)` : ""}
       ${precioMin !== undefined ? `AND p."salePrice" >= :precioMin` : ""}
       ${precioMax !== undefined ? `AND p."salePrice" <= :precioMax` : ""}
     ORDER BY ps.size ASC`,
    {
      type: QueryTypes.SELECT,
      // Todo por `replacements`, nunca interpolado: a diferencia de `talla` (un entero ya
      // validado), `q` es una cadena arbitraria que manda el cliente.
      replacements: {
        ...(categoria ? { categoria } : {}),
        ...(patron ? { patron } : {}),
        ...(precioMin !== undefined ? { precioMin } : {}),
        ...(precioMax !== undefined ? { precioMax } : {}),
      },
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
    order: orden as unknown as Order,
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
        hasSizes: data.hasSizes,
      },
      { transaction: t },
    );

    // El schema ya garantizó que el campo del modo vigente llegó (sizes si hasSizes, stockQuantity
    // si no), así que las aserciones `!` son seguras: ver productSchema en src/schemas/product.ts.
    const rows = data.hasSizes
      ? sizesToRows(data.sizes!)
      : [{ size: NO_SIZE_SENTINEL, stock: data.stockQuantity! }];
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

  // Mismo patrón que el cruce de precios de arriba: el refine del schema solo atrapa
  // contradicciones cuando AMBOS campos comparados vienen en el body (`hasSizes` incluido). Un
  // PUT parcial puede traer `sizes`/`stockQuantity` sin repetir `hasSizes`, así que hay que
  // resolver el modo efectivo contra lo ya guardado antes de decidir qué es obligatorio.
  const effectiveHasSizes = data.hasSizes ?? product.hasSizes;
  if (effectiveHasSizes && data.stockQuantity !== undefined) {
    throw new AppError(
      `"${product.name}" maneja tallas; usa el campo de tallas en vez de la cantidad en existencia.`,
      400,
    );
  }
  if (!effectiveHasSizes && data.sizes !== undefined) {
    throw new AppError(
      `"${product.name}" no maneja tallas; usa la cantidad en existencia en vez de tallas.`,
      400,
    );
  }
  if (effectiveHasSizes !== product.hasSizes) {
    // Cambio de modo: el campo del modo nuevo es obligatorio, no hay "cantidad anterior" que
    // reutilizar (una repartición por talla no se puede convertir en una cantidad única, ni al
    // revés).
    if (effectiveHasSizes && data.sizes === undefined) {
      throw new AppError(`Agrega las tallas de "${product.name}" al activarle tallas.`, 400);
    }
    if (!effectiveHasSizes && data.stockQuantity === undefined) {
      throw new AppError(
        `Indica la cantidad en existencia de "${product.name}" al quitarle las tallas.`,
        400,
      );
    }
  }

  await sequelize.transaction(async (t) => {
    const { sizes, stockQuantity, ...fields } = data;
    if (Object.keys(fields).length) {
      await product.update(fields, { transaction: t });
    }

    if (sizes !== undefined || stockQuantity !== undefined) {
      await ProductSize.destroy({ where: { productId: id }, transaction: t });
      const rows = effectiveHasSizes
        ? sizesToRows(sizes!)
        : [{ size: NO_SIZE_SENTINEL, stock: stockQuantity! }];
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

/**
 * Paso 1 de la importación masiva: POST /api/admin/products/import/preview (campo `file`).
 *
 * Lee el .xlsx y devuelve, fila por fila, con qué producto empareja, qué campos cambian
 * (`before`/`after`/`changes`) y cómo queda el stock por talla — SIN escribir nada. El panel
 * pinta ese diff, el dueño corrige lo que haga falta y confirma con `POST /import` mandando de
 * vuelta los `input` ya editados.
 *
 * El paso de revisión no es cosmético: el restock SUMA stock y no hay forma de deshacerlo desde
 * la app, así que aplicar un archivo a ciegas (con una fórmula que no se leyó, una columna mal
 * escrita o un nombre que empareja con el producto equivocado) sale caro.
 */
export const adminPreviewProductImport: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw new AppError('No se recibió ningún archivo. Adjunta un .xlsx en el campo "file".', 400);
    }

    const parsed = await parseImportWorkbook(req.file.buffer);
    const { summary, rows } = await previewImport(parsed.rows);
    res.status(200).json({ summary, warnings: parsed.warnings, rows });
  },
);

/**
 * Paso 2 de la importación masiva: POST /api/admin/products/import (JSON).
 *
 * Recibe `{ rows: [...] }` — los `input` que devolvió el preview, con las ediciones del dueño
 * aplicadas — y los aplica. Es JSON y no el .xlsx original precisamente para que lo que se
 * escribe sea lo que el dueño revisó y corrigió en pantalla, no lo que traía el archivo.
 */
export const adminImportProducts: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const { rows } = productImportCommitSchema.parse(req.body);
  const result = await commitImport(rows);
  res.status(200).json(result);
});
