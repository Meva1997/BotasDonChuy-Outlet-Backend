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

// Los defaults de zod ("se esperaba número, recibido indefinido") llegan tal cual
// al usuario, porque errorHandler promueve el mensaje del campo a la respuesta y
// el front lo pinta. Cada campo del ProductForm lleva su propio texto para que un
// campo vacío diga qué falta en vez de describir el tipo que se esperaba.
const productBaseSchema = z.object({
  name: z
    .string("El nombre es requerido")
    .trim()
    .min(2, "El nombre es muy corto")
    .max(120, "El nombre no puede pasar de 120 caracteres"),
  description: z
    .string()
    .trim()
    .max(2000, "La descripción no puede pasar de 2000 caracteres")
    .optional()
    .or(z.literal("")),
  originalPrice: z
    .number("El precio original es requerido")
    .positive("El precio original debe ser mayor a 0"),
  salePrice: z
    .number("El precio de oferta es requerido")
    .positive("El precio de oferta debe ser mayor a 0"),
  unitCost: z
    .number("El costo unitario es requerido")
    .nonnegative("El costo unitario no puede ser negativo"),
  stock: z
    .number()
    .int("El stock debe ser un número entero")
    .nonnegative("El stock no puede ser negativo")
    .default(0),
  type: z.enum(["bota", "sombrero", "ropa"], {
    message: "Selecciona una categoría válida",
  }),
  sizes: z.union(
    [
      sizesFromString,
      z.array(z.number().int().positive()).min(1, "Agrega al menos una talla"),
    ],
    { error: "Agrega al menos una talla (p. ej. \"25, 26, 26\")" },
  ),
  // Las imágenes NO se setean por POST/PUT: se gestionan solo por los endpoints
  // dedicados (POST/DELETE /api/admin/products/:id/images), que mantienen la BD
  // sincronizada con Cloudinary. `imageSrc` ya no se acepta aquí.
  code: z
    .string()
    .trim()
    .max(40, "El código no puede pasar de 40 caracteres")
    .optional()
    .or(z.literal("")),
  // Medidas de envío: van a la paquetería para cotizar en vivo con Skydropx, así
  // que deben ser mayores a 0 (un valor en 0 no solo generaría una guía mala —
  // tumbaría el checkout completo al fallar la cotización, ver roadmap-skydropx.md §2).
  weightKg: z.number("El peso (kg) es requerido").positive("El peso debe ser mayor a 0"),
  lengthCm: z.number("El largo (cm) es requerido").positive("El largo debe ser mayor a 0"),
  widthCm: z.number("El ancho (cm) es requerido").positive("El ancho debe ser mayor a 0"),
  heightCm: z.number("El alto (cm) es requerido").positive("El alto debe ser mayor a 0"),
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

/** Body de DELETE /api/admin/products/:id/images — identifica la imagen a borrar. */
export const deleteProductImageSchema = z.object({
  publicId: z
    .string("Se requiere el publicId de la imagen")
    .trim()
    .min(1, "Se requiere el publicId de la imagen"),
});

export type DeleteProductImageInput = z.infer<typeof deleteProductImageSchema>;
