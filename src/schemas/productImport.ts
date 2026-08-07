import { z } from "zod";
import { productBaseSchema, salePriceNotAboveOriginal } from "./product";
import { parseSizesSpec, SizesSpecError } from "../utils/sizesSpec";

// `sizes` se valida aparte (ver sizesSpecSchema abajo) porque su persistencia difiere por
// rama: bulkCreate en fila nueva vs. upsert aditivo (ON CONFLICT) en fila de actualización —
// nunca destroy+recreate como adminUpdateProduct. La importación masiva NO soporta productos sin
// tallas en esta fase (el Excel sigue siendo para reabasto por talla, notación "26x20"): por eso
// `hasSizes`/`stockQuantity` también se excluyen — toda fila importada crea/actualiza un producto
// `hasSizes: true` (el modelo ya default a eso). Un producto sin tallas se da de alta por el CRUD
// normal (POST/PUT /api/admin/products), no por el importador.
const { sizes: _sizes, hasSizes: _hasSizes, stockQuantity: _stockQuantity, ...importFieldsShape } =
  productBaseSchema.shape;
const importFieldsBase = z.object(importFieldsShape);

/** Fila nueva: mismos requisitos que crear por API (POST /api/admin/products). */
export const productImportCreateSchema = importFieldsBase.refine(salePriceNotAboveOriginal, {
  message: "El precio de oferta no puede ser mayor al precio original",
  path: ["salePrice"],
});

export type ProductImportCreateInput = z.infer<typeof productImportCreateSchema>;

/**
 * Fila de actualización: parcial, sin el default de `visible` que `.partial()` conserva.
 *
 * En zod 4, `.partial()` NO quita los `.default()`: `z.object({ visible: z.boolean().default(true) })
 * .partial().parse({})` devuelve `{ visible: true }`. Por eso `.extend()` se aplica DESPUÉS de
 * `.partial()`, para que `visible` quede como opcional puro — una fila que no trae la columna
 * "Visible" nunca debe tocar la visibilidad del producto existente. (`productUpdateSchema` en
 * ./product.ts arrastraba ese mismo default; ahí se corrigió igual.)
 */
export const productImportUpdateSchema = importFieldsBase
  .partial()
  .extend({ visible: z.boolean().optional() })
  .refine(salePriceNotAboveOriginal, {
    message: "El precio de oferta no puede ser mayor al precio original",
    path: ["salePrice"],
  });

export type ProductImportUpdateInput = z.infer<typeof productImportUpdateSchema>;

/**
 * Tallas de una fila → `{ size, stock }[]`. Acepta la notación del ProductForm ("25, 26, 26",
 * una ocurrencia = una unidad), la notación por cantidad ("26x20") y un `number[]` ya expandido.
 * Ver src/utils/sizesSpec.ts para los topes y el porqué de la notación `x`.
 */
export const sizesSpecSchema = z
  .union([z.string(), z.array(z.number())], {
    error: 'Agrega al menos una talla (p. ej. "25, 26, 26" o "26x20")',
  })
  .transform((value, ctx) => {
    try {
      return parseSizesSpec(Array.isArray(value) ? value.join(",") : value);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message:
          err instanceof SizesSpecError
            ? `Tallas: ${err.message}`
            : 'Agrega al menos una talla (p. ej. "25, 26, 26" o "26x20")',
      });
      return z.NEVER;
    }
  });

/** Tallas opcionales en fila de actualización — ausente significa "esta fila no toca stock". */
export const sizesSpecOptionalSchema = sizesSpecSchema.optional();

// ── Cuerpo JSON de POST /api/admin/products/import (paso de confirmación) ────────────────────

/**
 * Fila tal como la manda el front al confirmar. Es exactamente el objeto `input` que devolvió
 * `POST /import/preview` para esa fila, con las ediciones del dueño aplicadas encima.
 *
 * `.strict()` es deliberado: una clave que el backend no conoce (un typo del front, un campo
 * que se renombró) debe fallar en vez de descartarse. El modo silencioso es justo lo que hacía
 * que una columna mal escrita en el Excel se "importara con éxito" sin cambiar nada.
 *
 * Todos los campos son opcionales y SIN default: una clave ausente significa "no toques esa
 * columna del producto". Enviar `null` equivale a omitirla; enviar `""` en `description` sí
 * limpia la descripción (a diferencia del Excel, donde una celda en blanco se omite, aquí es
 * una decisión explícita del front).
 */
export const importRowInputSchema = z
  .object({
    row: z.number().int().positive("El número de fila debe ser positivo").optional(),
    code: z.string().trim().max(40, "El código no puede pasar de 40 caracteres").optional(),
    name: z.string().trim().optional(),
    description: z.string().optional(),
    type: z.string().trim().toLowerCase().optional(),
    originalPrice: z.number("El precio original debe ser un número").optional(),
    salePrice: z.number("El precio de oferta debe ser un número").optional(),
    unitCost: z.number("El costo unitario debe ser un número").optional(),
    sizes: z.union([z.string(), z.array(z.number())]).optional(),
    weightKg: z.number("El peso (kg) debe ser un número").optional(),
    lengthCm: z.number("El largo (cm) debe ser un número").optional(),
    widthCm: z.number("El ancho (cm) debe ser un número").optional(),
    heightCm: z.number("El alto (cm) debe ser un número").optional(),
    visible: z.boolean("Visible debe ser Sí o No").optional(),
  })
  .strict();

export type ImportRowInputBody = z.infer<typeof importRowInputSchema>;

/** Tope de filas por importación. Ver MAX_IMPORT_ROWS en productImport.service.ts. */
export const MAX_IMPORT_ROWS = 500;

/** Quita las claves con `null`/`undefined` para que "ausente" y "null" signifiquen lo mismo. */
const stripNullish = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
};

export const productImportCommitSchema = z.object({
  rows: z
    .array(z.preprocess(stripNullish, importRowInputSchema), {
      error: "Envía las filas a importar en el campo \"rows\".",
    })
    .min(1, "No hay ninguna fila que importar.")
    .max(MAX_IMPORT_ROWS, `No se pueden importar más de ${MAX_IMPORT_ROWS} filas a la vez.`),
});

export type ProductImportCommitInput = z.infer<typeof productImportCommitSchema>;
