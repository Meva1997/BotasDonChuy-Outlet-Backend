import { z } from "zod";

/**
 * El front manda `sizes` como string separado por comas (p. ej. "25, 26, 26")
 * porque así lo captura el input del ProductForm; aquí se parsea a `number[]`.
 * La repetición de una talla representa unidades de stock para esa talla.
 * En el backend esto se traduce a filas de `ProductSize` (productId, size, stock)
 * agrupando ocurrencias repetidas; `Product.sizes`/`Product.stock` son derivados
 * (VIRTUAL) de esa tabla, no columnas propias.
 */
const sizesFromString = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number),
  )
  .pipe(z.array(z.number().int().positive()).min(1, "Agrega al menos una talla"));

const productBaseSchema = z.object({
  name: z.string().trim().min(2, "El nombre es muy corto").max(120),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  originalPrice: z.number().positive("El precio original debe ser mayor a 0"),
  salePrice: z.number().positive("El precio de oferta debe ser mayor a 0"),
  unitCost: z.number().nonnegative("El costo unitario no puede ser negativo"),
  stock: z.number().int().nonnegative().default(0),
  type: z.enum(["bota", "sombrero", "ropa"], {
    message: "Selecciona una categoría válida",
  }),
  sizes: z.union([
    sizesFromString,
    z.array(z.number().int().positive()).min(1, "Agrega al menos una talla"),
  ]),
  imageSrc: z.string().trim().optional().or(z.literal("")),
  code: z.string().trim().max(40).optional().or(z.literal("")),
  weightKg: z.number().nonnegative(),
  lengthCm: z.number().nonnegative(),
  widthCm: z.number().nonnegative(),
  heightCm: z.number().nonnegative(),
  visible: z.boolean().default(true),
});

function salePriceNotAboveOriginal(data: {
  salePrice?: number;
  originalPrice?: number;
}) {
  return (
    data.salePrice === undefined ||
    data.originalPrice === undefined ||
    data.salePrice <= data.originalPrice
  );
}

export const productSchema = productBaseSchema.refine(salePriceNotAboveOriginal, {
  message: "El precio de oferta no puede ser mayor al precio original",
  path: ["salePrice"],
});

export type ProductInput = z.infer<typeof productSchema>;

export const productUpdateSchema = productBaseSchema
  .partial()
  .refine(salePriceNotAboveOriginal, {
    message: "El precio de oferta no puede ser mayor al precio original",
    path: ["salePrice"],
  });

export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
