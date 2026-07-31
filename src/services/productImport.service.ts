import ExcelJS from "exceljs";
import { Op, UniqueConstraintError, fn, col, where as sqlWhere } from "sequelize";
import { ZodError } from "zod";
import { Product } from "../models/Product";
import { ProductSize } from "../models/ProductSize";
import { sequelize } from "../config/database";
import { AppError } from "../middlewares/AppError";
import { logger } from "../config/logger";
import { formatMoney } from "../utils/formatMoney";
import { productSizesInclude } from "../utils/productSizesInclude";
import { IdempotencyStore, fingerprintOf } from "../utils/idempotency";
import { readCellText, readCellNumber, readCellBoolean } from "../utils/excelCell";
import {
  productImportCreateSchema,
  productImportUpdateSchema,
  sizesSpecSchema,
  sizesSpecOptionalSchema,
  MAX_IMPORT_ROWS,
  type ImportRowInputBody,
} from "../schemas/productImport";

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Una fila tal como se leyó del Excel o como la manda el front al confirmar. */
export interface ImportRowInput extends ImportRowInputBody {
  row?: number;
}

export interface ParsedImportRow {
  row: number;
  input: ImportRowInput;
  /** Celdas con contenido ilegible: la fila no se puede aplicar (ver utils/excelCell.ts). */
  cellErrors: string[];
  /** Interpretaciones que conviene confirmar (coma decimal, celda con formato de fecha). */
  warnings: string[];
}

export interface ParsedWorkbook {
  rows: ParsedImportRow[];
  /** Avisos del archivo completo: columnas que no se reconocieron. */
  warnings: string[];
}

/** Foto de un producto para el diff del preview. Incluye `unitCost`: ruta de admin. */
export interface ProductSnapshot {
  id: number | null;
  code: string | null;
  name: string;
  type: string;
  description: string | null;
  originalPrice: number;
  salePrice: number;
  unitCost: number;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  visible: boolean;
  discontinued: boolean;
  sizes: { size: number; stock: number }[];
  stock: number;
}

export interface FieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface SizeChange {
  size: number;
  before: number;
  added: number;
  after: number;
}

export type ImportAction = "create" | "update" | "unchanged" | "error";

export interface ImportRowPlan {
  row: number;
  action: ImportAction;
  code: string | null;
  name: string | null;
  productId: number | null;
  /** Estado actual del producto que hace match; `null` cuando la fila lo va a crear. */
  before: ProductSnapshot | null;
  /** Cómo quedaría el producto si se confirma la importación. */
  after: ProductSnapshot | null;
  changes: FieldChange[];
  sizeChanges: SizeChange[];
  reactivated: boolean;
  warnings: string[];
  message: string;
  /** La fila que el front debe devolver (ya editada) al confirmar. */
  input: ImportRowInput;
}

export interface ImportRowResult {
  row: number;
  status: "created" | "updated" | "unchanged" | "error";
  code: string | null;
  name: string | null;
  productId?: number;
  message: string;
}

export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

// ── Encabezados ───────────────────────────────────────────────────────────────

type ImportField = keyof Omit<ImportRowInput, "row">;

// Encabezado canónico documentado para el dueño: Código | Nombre | Categoría | Descripción |
// Precio original | Precio oferta | Costo unitario | Tallas | Peso (kg) | Largo (cm) |
// Ancho (cm) | Alto (cm) | Visible. Insensible a acentos/mayúsculas y con alias comunes, para
// que una variación menor del encabezado no tumbe el archivo completo.
const HEADER_ALIASES: Record<string, ImportField> = {
  codigo: "code",
  "codigo de barras": "code",
  clave: "code",
  sku: "code",
  nombre: "name",
  producto: "name",
  descripcion: "description",
  categoria: "type",
  tipo: "type",
  "precio original": "originalPrice",
  "precio de lista": "originalPrice",
  "precio lista": "originalPrice",
  "precio oferta": "salePrice",
  "precio de oferta": "salePrice",
  "precio venta": "salePrice",
  "precio de venta": "salePrice",
  "costo unitario": "unitCost",
  costo: "unitCost",
  tallas: "sizes",
  talla: "sizes",
  "peso (kg)": "weightKg",
  "peso kg": "weightKg",
  peso: "weightKg",
  "largo (cm)": "lengthCm",
  "largo cm": "lengthCm",
  largo: "lengthCm",
  "ancho (cm)": "widthCm",
  "ancho cm": "widthCm",
  ancho: "widthCm",
  "alto (cm)": "heightCm",
  "alto cm": "heightCm",
  alto: "heightCm",
  visible: "visible",
  publicado: "visible",
};

const FIELD_LABELS: Record<string, string> = {
  code: "Código",
  name: "Nombre",
  type: "Categoría",
  description: "Descripción",
  originalPrice: "Precio original",
  salePrice: "Precio oferta",
  unitCost: "Costo unitario",
  weightKg: "Peso (kg)",
  lengthCm: "Largo (cm)",
  widthCm: "Ancho (cm)",
  heightCm: "Alto (cm)",
  visible: "Visible",
};

const NUMERIC_FIELDS = new Set<ImportField>([
  "originalPrice",
  "salePrice",
  "unitCost",
  "weightKg",
  "lengthCm",
  "widthCm",
  "heightCm",
]);

const DIACRITICS_REGEX = /[̀-ͯ]/g;

function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ── Parseo del workbook ───────────────────────────────────────────────────────

/**
 * Parsea el .xlsx subido a filas crudas, SIN tocar la base de datos.
 *
 * Dos invariantes que no se pueden romper:
 *
 * 1. Una celda VACÍA omite la clave del objeto de fila en vez de escribir `""`/`undefined`.
 *    `description` acepta cadena vacía como valor válido, así que una clave presente con `""`
 *    blanquearía esa columna al hacer `existing.update(fields)`.
 * 2. Una celda ILEGIBLE (fórmula sin resultado, `#REF!`, "Visible: quizá") NO se trata como
 *    vacía: se acumula en `cellErrors` y la fila falla. Descartarla en silencio hacía que el
 *    importador respondiera "producto actualizado" sin haber cambiado nada — el modo de fallo
 *    más caro, porque el dueño no tiene forma de enterarse.
 */
export async function parseImportWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs tipa `load` contra una versión de @types/node distinta a la de este proyecto
    // (mismo Buffer en runtime, tipos incompatibles en compilación) — cast necesario.
    await workbook.xlsx.load(buffer as never);
  } catch (err) {
    // Un archivo corrupto (o un .xls/.csv renombrado a .xlsx, que pasa el filtro de mimetype)
    // hacía reventar `load` hasta el 500 genérico "Error interno del servidor".
    logger.warn({ err }, "No se pudo leer el .xlsx de importación de productos");
    throw new AppError(
      "No se pudo leer el archivo. Verifica que sea un Excel (.xlsx) válido y que no esté dañado.",
      400,
    );
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError("El archivo no tiene hojas de cálculo.", 400);

  const columnMap = new Map<number, ImportField>();
  const unknownHeaders: string[] = [];
  const seenFields = new Map<ImportField, string>();
  const duplicated: string[] = [];

  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const rawHeader = readCellText(cell.value).value ?? "";
    if (rawHeader.length === 0) return;

    const field = HEADER_ALIASES[normalizeHeader(rawHeader)];
    if (!field) {
      unknownHeaders.push(rawHeader);
      return;
    }
    const previous = seenFields.get(field);
    if (previous) {
      duplicated.push(`"${previous}" y "${rawHeader}"`);
      return;
    }
    seenFields.set(field, rawHeader);
    columnMap.set(colNumber, field);
  });

  if (duplicated.length > 0) {
    // Antes ganaba la última columna no vacía, así que con dos columnas de precio el archivo
    // se aplicaba con un valor u otro según qué celda estuviera llena. Mejor rechazar.
    throw new AppError(
      `El archivo tiene columnas repetidas que significan lo mismo (${duplicated.join(", ")}). Deja solo una de cada una.`,
      400,
    );
  }

  if (!seenFields.has("code") && !seenFields.has("name")) {
    throw new AppError(
      'El archivo debe tener una columna "Código" o "Nombre" para identificar los productos.',
      400,
    );
  }

  const rows: ParsedImportRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
    if (rowNumber === 1) return;

    const input: Record<string, unknown> = {};
    const cellErrors: string[] = [];
    const warnings: string[] = [];
    let hasContent = false;

    for (const [colNumber, field] of columnMap) {
      const cellValue = excelRow.getCell(colNumber).value;
      const label = FIELD_LABELS[field] ?? (field === "sizes" ? "Tallas" : field);

      const read =
        field === "visible"
          ? readCellBoolean(cellValue)
          : NUMERIC_FIELDS.has(field)
            ? readCellNumber(cellValue)
            : readCellText(cellValue);

      if (read.problem) {
        cellErrors.push(`${label}: ${read.problem}`);
        hasContent = true;
        continue;
      }
      if (read.warning) warnings.push(`${label}: ${read.warning}`);
      if (read.value === undefined) continue;

      hasContent = true;
      input[field] = field === "type" ? String(read.value).toLowerCase() : read.value;
    }

    if (!hasContent) return; // fila completamente en blanco, se ignora
    rows.push({ row: rowNumber, input: { row: rowNumber, ...input }, cellErrors, warnings });
  });

  if (rows.length > MAX_IMPORT_ROWS) {
    // Sin este tope, un .xlsx de 2 MB con decenas de miles de filas mantiene la petición abierta
    // varios minutos (una transacción por fila, en serie): el cliente hace timeout y nunca se
    // entera de qué filas se aplicaron, aunque la base ya se modificó.
    throw new AppError(
      `El archivo tiene ${rows.length} filas y el máximo por importación es ${MAX_IMPORT_ROWS}. Divídelo en varios archivos.`,
      400,
    );
  }

  const fileWarnings: string[] = [];
  if (unknownHeaders.length > 0) {
    // Antes se descartaban en silencio: un encabezado mal escrito ("Precio de venta" cuando el
    // alias esperado no existía) hacía que la columna no se importara y la fila igual se
    // reportara como actualizada.
    fileWarnings.push(
      `Estas columnas no se reconocieron y NO se van a importar: ${unknownHeaders.map((h) => `"${h}"`).join(", ")}.`,
    );
  }

  return { rows, warnings: fileWarnings };
}

// ── Snapshots y diff ──────────────────────────────────────────────────────────

function snapshotOf(product: Product): ProductSnapshot {
  const sizes = (product.productSizes ?? [])
    .map((ps) => ({ size: ps.size, stock: ps.stock }))
    .sort((a, b) => a.size - b.size);

  return {
    id: product.id,
    code: product.code ?? null,
    name: product.name,
    type: product.type,
    description: product.description ?? null,
    originalPrice: product.originalPrice,
    salePrice: product.salePrice,
    unitCost: product.unitCost,
    weightKg: product.weightKg,
    lengthCm: product.lengthCm,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
    visible: product.visible,
    discontinued: product.deletedAt !== null && product.deletedAt !== undefined,
    sizes,
    stock: sizes.reduce((acc, s) => acc + s.stock, 0),
  };
}

function mergeSizes(
  before: { size: number; stock: number }[],
  added: { size: number; stock: number }[],
): { sizes: { size: number; stock: number }[]; changes: SizeChange[] } {
  const merged = new Map(before.map((s) => [s.size, s.stock]));
  const changes: SizeChange[] = [];

  for (const { size, stock } of added) {
    const previous = merged.get(size) ?? 0;
    merged.set(size, previous + stock);
    changes.push({ size, before: previous, added: stock, after: previous + stock });
  }

  const sizes = [...merged.entries()]
    .map(([size, stock]) => ({ size, stock }))
    .sort((a, b) => a.size - b.size);

  return { sizes, changes };
}

function diffFields(before: ProductSnapshot, after: ProductSnapshot): FieldChange[] {
  return Object.keys(FIELD_LABELS)
    .filter((field) => {
      const b = before[field as keyof ProductSnapshot];
      const a = after[field as keyof ProductSnapshot];
      return b !== a;
    })
    .map((field) => ({
      field,
      label: FIELD_LABELS[field],
      before: before[field as keyof ProductSnapshot],
      after: after[field as keyof ProductSnapshot],
    }));
}

// ── Validación compartida (preview y confirmación usan exactamente esta) ───────

interface ValidatedRow {
  /** Columnas a escribir en `products`. Vacío = la fila no cambia ningún campo escalar. */
  fields: Record<string, unknown>;
  /** Tallas a SUMAR. `undefined` = la fila no trae columna Tallas y no toca el stock. */
  sizeRows?: { size: number; stock: number }[];
  reactivate: boolean;
  warnings: string[];
}

function validateRow(input: ImportRowInput, existing: ProductSnapshot | null): ValidatedRow {
  const warnings: string[] = [];

  if (!existing) {
    const data = productImportCreateSchema.parse(input);
    const sizeRows = sizesSpecSchema.parse(input.sizes);
    return {
      fields: {
        name: data.name,
        description: data.description || undefined,
        originalPrice: data.originalPrice,
        salePrice: data.salePrice,
        unitCost: data.unitCost,
        type: data.type,
        code: data.code || undefined,
        weightKg: data.weightKg,
        lengthCm: data.lengthCm,
        widthCm: data.widthCm,
        heightCm: data.heightCm,
        visible: data.visible,
      },
      sizeRows,
      reactivate: false,
      warnings,
    };
  }

  const data = productImportUpdateSchema.parse(input);
  const sizeRows = sizesSpecOptionalSchema.parse(input.sizes);

  // El refine del schema solo compara cuando ambos precios vienen en la fila; en una
  // actualización parcial hay que validar contra lo ya guardado (mismo criterio que
  // adminUpdateProduct en product.controller.ts).
  const effectiveOriginalPrice = data.originalPrice ?? existing.originalPrice;
  const effectiveSalePrice = data.salePrice ?? existing.salePrice;
  if (effectiveSalePrice > effectiveOriginalPrice) {
    throw new AppError(
      `el precio de oferta (${formatMoney(effectiveSalePrice)}) no puede ser mayor al precio original (${formatMoney(effectiveOriginalPrice)}).`,
      400,
    );
  }

  const fields: Record<string, unknown> = { ...data };
  delete fields.row;

  // El emparejamiento por código es insensible a mayúsculas, así que "bta-1" en la hoja
  // encuentra el producto guardado como "BTA-1". En ese caso NO se reescribe el código con la
  // variante de la hoja: renombraría la clave del catálogo por una diferencia de tecleo.
  if (
    typeof fields.code === "string" &&
    existing.code &&
    fields.code !== existing.code &&
    fields.code.toLowerCase() === existing.code.toLowerCase()
  ) {
    warnings.push(
      `El código del archivo ("${fields.code}") solo difiere en mayúsculas del guardado ("${existing.code}"); se conservó el guardado.`,
    );
    delete fields.code;
  }

  // Solo se conservan los campos que realmente cambian algo, para que el preview no muestre
  // como "modificada" una fila que reescribe los mismos valores.
  for (const key of Object.keys(fields)) {
    if (fields[key] === existing[key as keyof ProductSnapshot]) delete fields[key];
  }

  const reactivate = existing.discontinued;
  if (reactivate) {
    // Restockear un producto descontinuado implica que vuelve a venderse: se reactiva y,
    // salvo que la fila diga explícitamente lo contrario, vuelve a ser visible.
    fields.deletedAt = null;
    if (data.visible === undefined) fields.visible = true;
  }

  return { fields, sizeRows, reactivate, warnings };
}

function projectSnapshot(
  before: ProductSnapshot | null,
  validated: ValidatedRow,
): ProductSnapshot {
  const base: ProductSnapshot = before ?? {
    id: null,
    code: null,
    name: "",
    type: "",
    description: null,
    originalPrice: 0,
    salePrice: 0,
    unitCost: 0,
    weightKg: 0,
    lengthCm: 0,
    widthCm: 0,
    heightCm: 0,
    visible: true,
    discontinued: false,
    sizes: [],
    stock: 0,
  };

  // `deletedAt` es una columna que se escribe, no parte de la foto: el snapshot la expone como
  // `discontinued`. Se saca antes del spread para no filtrarla al front.
  const { deletedAt: _deletedAt, ...writableFields } = validated.fields;

  const { sizes } = mergeSizes(base.sizes, validated.sizeRows ?? []);
  return {
    ...base,
    ...(writableFields as Partial<ProductSnapshot>),
    code: (writableFields.code as string | undefined) ?? base.code ?? null,
    description: (writableFields.description as string | undefined) ?? base.description ?? null,
    discontinued: validated.reactivate ? false : base.discontinued,
    sizes,
    stock: sizes.reduce((acc, s) => acc + s.stock, 0),
  };
}

// ── Emparejamiento ────────────────────────────────────────────────────────────

/**
 * Localiza el producto existente que corresponde a una fila.
 *
 * Por código (insensible a mayúsculas) si la fila lo trae; si no, por nombre exacto insensible
 * a mayúsculas. El match por nombre usa `lower(name) = lower(?)` en vez de `iLike`: `iLike`
 * interpreta `%` y `_` como comodines, así que una fila llamada "Bota%Premium" emparejaba con
 * "Bota Roja Premium" y —al aplicarse el campo `name`— la RENOMBRABA.
 *
 * Un nombre que empareja con más de un producto es ambiguo (la columna `name` no tiene índice
 * único): antes `findOne` devolvía uno arbitrario, ahora la fila falla pidiendo un código.
 */
async function findMatches(
  input: ImportRowInput,
  options: { transaction?: import("sequelize").Transaction; lock?: boolean } = {},
): Promise<Product[]> {
  const code = input.code?.trim();
  const name = input.name?.trim();

  const query = {
    include: [productSizesInclude],
    limit: 2,
    order: [["id", "ASC"]] as [string, string][],
    transaction: options.transaction,
    // `lock` con un include de hasMany rompe en Postgres (FOR UPDATE sobre el lado nullable de
    // un LEFT JOIN), así que el bloqueo se pide solo sobre la tabla de products.
    ...(options.lock ? { lock: { level: "UPDATE", of: Product } as never } : {}),
  };

  if (code) {
    return Product.findAll({
      ...query,
      where: sqlWhere(fn("lower", col("Product.code")), code.toLowerCase()),
    });
  }
  if (name) {
    return Product.findAll({
      ...query,
      where: sqlWhere(fn("lower", col("Product.name")), name.toLowerCase()),
    });
  }
  return [];
}

function assertSingleMatch(matches: Product[], input: ImportRowInput): Product | null {
  if (matches.length <= 1) return matches[0] ?? null;
  const label = input.code?.trim() ? `código "${input.code.trim()}"` : `nombre "${input.name?.trim()}"`;
  throw new AppError(
    `hay ${matches.length} productos con el ${label}. Agrega la columna "Código" con un valor distinto para cada uno y vuelve a subir el archivo.`,
    409,
  );
}

// ── Errores por fila ──────────────────────────────────────────────────────────

/** Cuántos mensajes de campo caben en el mensaje de una fila (igual que errorHandler). */
const MAX_FIELDS_IN_MESSAGE = 3;

function rowErrorMessage(row: number, err: unknown, input: ImportRowInput): string {
  if (err instanceof ZodError) {
    // Un solo mensaje por campo, hasta 3 — mismo criterio que messageFromDetails en
    // errorHandler.ts. Reportar solo `issues[0]` obligaba al dueño a corregir una columna,
    // volver a subir y descubrir la siguiente; y como el restock SUMA, cada reintento del
    // archivo completo volvía a sumar el stock de las filas que sí habían funcionado.
    const firstByPath = new Map<string, string>();
    for (const issue of err.issues) {
      const path = issue.path.join(".");
      if (!firstByPath.has(path)) firstByPath.set(path, issue.message);
    }
    const messages = [...firstByPath.values()];
    const shown = messages.slice(0, MAX_FIELDS_IN_MESSAGE);
    const rest = messages.length - shown.length;
    const body =
      rest === 0
        ? shown.join(" · ")
        : `${shown.join(" · ")} (y ${rest} ${rest === 1 ? "campo más" : "campos más"} por corregir)`;
    return `Fila ${row}: ${body || "revisa los datos de esta fila."}`;
  }

  if (err instanceof UniqueConstraintError) {
    return `Fila ${row}: ya existe un producto con el código "${input.code ?? ""}". Revisa que no esté repetido en el archivo o en el catálogo.`;
  }

  if (err instanceof AppError) {
    return err.message.startsWith(`Fila ${row}`) ? err.message : `Fila ${row}: ${err.message}`;
  }

  logger.error({ err, row }, "Error inesperado procesando fila de importación de productos");
  return `Fila ${row}: ocurrió un error inesperado al procesar esta fila.`;
}

function errorPlan(parsed: ParsedImportRow, message: string): ImportRowPlan {
  return {
    row: parsed.row,
    action: "error",
    code: parsed.input.code ?? null,
    name: parsed.input.name ?? null,
    productId: null,
    before: null,
    after: null,
    changes: [],
    sizeChanges: [],
    reactivated: false,
    warnings: parsed.warnings,
    message,
    input: parsed.input,
  };
}

// ── Preview (no toca la base de datos) ────────────────────────────────────────

/**
 * Calcula, sin escribir nada, cómo quedaría cada fila: qué producto empareja, qué campos
 * cambian y cómo queda el stock por talla.
 *
 * Las filas se resuelven contra un catálogo VIRTUAL: el estado real de la base más los cambios
 * que las filas anteriores del mismo archivo ya proyectaron. Sin ese overlay, un archivo donde
 * la fila 2 crea "BTA-9" y la fila 5 lo restockea mostraría dos altas del mismo producto,
 * mientras que al confirmar (que sí es secuencial y transaccional) la fila 5 haría un update.
 */
export async function previewImport(
  parsedRows: ParsedImportRow[],
): Promise<{ summary: ImportSummary; rows: ImportRowPlan[] }> {
  // Dos consultas para todo el archivo en vez de una por fila.
  const codes = [...new Set(parsedRows.map((r) => r.input.code?.trim().toLowerCase()).filter(Boolean))] as string[];
  const names = [...new Set(parsedRows.map((r) => r.input.name?.trim().toLowerCase()).filter(Boolean))] as string[];

  const [byCodeRows, byNameRows] = await Promise.all([
    codes.length
      ? Product.findAll({
          where: sqlWhere(fn("lower", col("Product.code")), { [Op.in]: codes }),
          include: [productSizesInclude],
          order: [["id", "ASC"]],
        })
      : Promise.resolve([] as Product[]),
    names.length
      ? Product.findAll({
          where: sqlWhere(fn("lower", col("Product.name")), { [Op.in]: names }),
          include: [productSizesInclude],
          order: [["id", "ASC"]],
        })
      : Promise.resolve([] as Product[]),
  ]);

  const groupBy = (rows: Product[], key: (p: Product) => string | null | undefined) => {
    const map = new Map<string, ProductSnapshot[]>();
    for (const product of rows) {
      const raw = key(product);
      if (!raw) continue;
      const k = raw.toLowerCase();
      map.set(k, [...(map.get(k) ?? []), snapshotOf(product)]);
    }
    return map;
  };

  const byCode = groupBy(byCodeRows, (p) => p.code);
  const byName = groupBy(byNameRows, (p) => p.name);

  /** Productos ya creados/modificados por filas anteriores de ESTE mismo archivo. */
  const pendingByCode = new Map<string, ProductSnapshot>();
  const pendingByName = new Map<string, ProductSnapshot>();
  /** Ids de productos existentes ya proyectados, para encadenar varias filas sobre el mismo. */
  const projectedById = new Map<number, ProductSnapshot>();

  const plans: ImportRowPlan[] = [];

  for (const parsed of parsedRows) {
    const { input, row } = parsed;

    if (parsed.cellErrors.length > 0) {
      plans.push(errorPlan(parsed, `Fila ${row}: ${parsed.cellErrors.join(" · ")}`));
      continue;
    }

    try {
      const code = input.code?.trim();
      const name = input.name?.trim();
      if (!code && !name) {
        throw new AppError('falta "Código" o "Nombre" para identificar el producto.', 400);
      }

      let before: ProductSnapshot | null = null;
      if (code) {
        const key = code.toLowerCase();
        const pending = pendingByCode.get(key);
        const stored = byCode.get(key) ?? [];
        if (pending) {
          before = pending;
        } else {
          if (stored.length > 1) {
            throw new AppError(
              `hay ${stored.length} productos con el código "${code}". Agrega la columna "Código" con un valor distinto para cada uno y vuelve a subir el archivo.`,
              409,
            );
          }
          before = stored[0] ?? null;
        }
      } else if (name) {
        const key = name.toLowerCase();
        const pending = pendingByName.get(key);
        const stored = byName.get(key) ?? [];
        if (pending) {
          before = pending;
        } else {
          if (stored.length > 1) {
            throw new AppError(
              `hay ${stored.length} productos con el nombre "${name}". Agrega la columna "Código" con un valor distinto para cada uno y vuelve a subir el archivo.`,
              409,
            );
          }
          before = stored[0] ?? null;
        }
      }

      // Si otra fila anterior ya proyectó cambios sobre este mismo producto, se parte de esa
      // proyección y no del estado guardado.
      if (before?.id && projectedById.has(before.id)) before = projectedById.get(before.id)!;

      const validated = validateRow(input, before);
      const after = projectSnapshot(before, validated);
      const { changes: sizeChanges } = mergeSizes(before?.sizes ?? [], validated.sizeRows ?? []);
      const changes = before ? diffFields(before, after) : [];

      const touchesSizes = sizeChanges.some((c) => c.added > 0);
      const action: ImportAction = !before
        ? "create"
        : changes.length > 0 || touchesSizes || validated.reactivate
          ? "update"
          : "unchanged";

      const warnings = [...parsed.warnings, ...validated.warnings];
      if (action === "unchanged") {
        // Este es exactamente el síntoma que antes se reportaba como "actualizado": la fila
        // se leyó bien pero no cambia nada.
        warnings.push("Esta fila no cambia nada del producto: los valores del archivo ya son los guardados.");
      }

      const message =
        action === "create"
          ? `Fila ${row}: se creará el producto "${after.name}".`
          : action === "unchanged"
            ? `Fila ${row}: "${after.name}" queda igual, no hay nada que aplicar.`
            : validated.reactivate
              ? `Fila ${row}: se reactivará y actualizará "${after.name}".`
              : `Fila ${row}: se actualizará "${after.name}".`;

      const plan: ImportRowPlan = {
        row,
        action,
        code: after.code,
        name: after.name,
        productId: before?.id ?? null,
        before,
        after,
        changes,
        sizeChanges,
        reactivated: validated.reactivate,
        warnings,
        message,
        input,
      };
      plans.push(plan);

      // Overlay para las filas siguientes del mismo archivo.
      if (after.code) pendingByCode.set(after.code.toLowerCase(), after);
      pendingByName.set(after.name.toLowerCase(), after);
      if (before?.id) projectedById.set(before.id, after);
    } catch (err) {
      plans.push(errorPlan(parsed, rowErrorMessage(row, err, input)));
    }
  }

  return { summary: summarize(plans.map((p) => p.action)), rows: plans };
}

function summarize(actions: ImportAction[] | ImportRowResult["status"][]): ImportSummary {
  const count = (value: string) => actions.filter((a) => a === value).length;
  return {
    total: actions.length,
    created: count("created") + count("create"),
    updated: count("updated") + count("update"),
    unchanged: count("unchanged"),
    failed: count("error"),
  };
}

// ── Confirmación (escribe) ────────────────────────────────────────────────────

/**
 * Guard de doble envío. El paso de confirmación es sin estado (el front manda las filas ya
 * editadas), así que no hay token que consumir: un doble clic o un reintento del navegador
 * mandaría el mismo lote dos veces y, como el restock SUMA, duplicaría el stock.
 *
 * Es un Map en memoria, deliberadamente NO persistido: se reinicia con el proceso y no cubre
 * varias instancias — misma decisión (y misma limitación asumida) que el contador de fallos
 * consecutivos de pendingOrderSweeper.ts. Protege del accidente, no del abuso; la barrera dura
 * contra duplicados de catálogo sigue siendo el índice único de `code`.
 *
 * El mapa con TTL y la huella son los de `utils/idempotency.ts`, compartidos con el guard del
 * checkout (Fase O.2). Lo que NO se comparte es la política: aquí un reenvío se rechaza, allá
 * se le devuelve la respuesta del original (ver el módulo para el porqué de cada una).
 */
const DUPLICATE_COMMIT_WINDOW_MS = 60_000;
const recentCommits = new IdempotencyStore<true>(DUPLICATE_COMMIT_WINDOW_MS);

function assertNotDuplicateCommit(rows: ImportRowInput[]): string {
  const fingerprint = fingerprintOf(rows.map((r) => ({ ...r, row: undefined })));

  if (recentCommits.has(fingerprint)) {
    throw new AppError(
      "Esta misma importación se acaba de aplicar hace unos segundos. Revisa el catálogo antes de volver a intentarlo: el stock de un restock se SUMA, así que aplicarla dos veces duplicaría las piezas.",
      409,
    );
  }
  recentCommits.set(fingerprint, true);
  return fingerprint;
}

async function commitRow(input: ImportRowInput, row: number): Promise<ImportRowResult> {
  try {
    const code = input.code?.trim();
    const name = input.name?.trim();
    if (!code && !name) {
      throw new AppError('falta "Código" o "Nombre" para identificar el producto.', 400);
    }

    return await sequelize.transaction(async (t) => {
      // El match se hace DENTRO de la transacción y con FOR UPDATE: cargarlo fuera dejaba una
      // ventana en la que otra petición (o el propio panel) modificaba el producto entre la
      // lectura y el update.
      const existing = assertSingleMatch(await findMatches(input, { transaction: t, lock: true }), input);
      const before = existing ? snapshotOf(existing) : null;
      const validated = validateRow(input, before);

      if (!existing) {
        const created = await Product.create(validated.fields as never, { transaction: t });
        await ProductSize.bulkCreate(
          (validated.sizeRows ?? []).map((r) => ({ productId: created.id, ...r })),
          { transaction: t },
        );
        return {
          row,
          status: "created" as const,
          code: created.code ?? null,
          name: created.name,
          productId: created.id,
          message: `Fila ${row}: producto "${created.name}" creado.`,
        };
      }

      const touchesSizes = (validated.sizeRows ?? []).length > 0;
      if (Object.keys(validated.fields).length === 0 && !touchesSizes) {
        return {
          row,
          status: "unchanged" as const,
          code: existing.code ?? null,
          name: existing.name,
          productId: existing.id,
          message: `Fila ${row}: "${existing.name}" ya estaba así, no se cambió nada.`,
        };
      }

      if (Object.keys(validated.fields).length > 0) {
        await existing.update(validated.fields, { transaction: t });
      }

      if (validated.sizeRows) {
        // Upsert aditivo sobre el índice único (productId, size) ya existente: nunca reemplaza
        // el stock guardado, solo lo incrementa — a diferencia del destroy+recreate que usa
        // adminUpdateProduct para una edición manual de tallas.
        for (const r of validated.sizeRows) {
          await sequelize.query(
            `INSERT INTO product_sizes ("productId", "size", "stock", "createdAt", "updatedAt")
             VALUES (:productId, :size, :stock, NOW(), NOW())
             ON CONFLICT ("productId", "size")
             DO UPDATE SET "stock" = product_sizes."stock" + EXCLUDED."stock", "updatedAt" = NOW()`,
            {
              replacements: { productId: existing.id, size: r.size, stock: r.stock },
              transaction: t,
            },
          );
        }
      }

      return {
        row,
        status: "updated" as const,
        code: existing.code ?? null,
        name: existing.name,
        productId: existing.id,
        message: validated.reactivate
          ? `Fila ${row}: producto "${existing.name}" reactivado y actualizado.`
          : `Fila ${row}: producto "${existing.name}" actualizado.`,
      };
    });
  } catch (err) {
    return {
      row,
      status: "error",
      code: input.code ?? null,
      name: input.name ?? null,
      message: rowErrorMessage(row, err, input),
    };
  }
}

/**
 * Aplica las filas confirmadas por el dueño, SECUENCIALMENTE (no Promise.all): una fila puede
 * crear un producto que una fila posterior del mismo lote restockea por ese mismo código, y cada
 * transacción debe confirmarse antes de que la siguiente busque su match. Cada fila corre en su
 * propio try/catch para que un error no aborte las demás — éxito parcial es lo esperado.
 */
export async function commitImport(
  rows: ImportRowInput[],
): Promise<{ summary: ImportSummary; rows: ImportRowResult[] }> {
  const fingerprint = assertNotDuplicateCommit(rows);

  try {
    const results: ImportRowResult[] = [];
    for (const [index, input] of rows.entries()) {
      results.push(await commitRow(input, input.row ?? index + 1));
    }
    return { summary: summarize(results.map((r) => r.status)), rows: results };
  } catch (err) {
    // Si el lote entero revienta no se aplicó nada útil: se libera la huella para que el dueño
    // pueda reintentar sin esperar la ventana.
    recentCommits.delete(fingerprint);
    throw err;
  }
}
