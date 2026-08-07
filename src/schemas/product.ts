import { z } from "zod";

/**
 * El front manda `sizes` como string separado por comas (p. ej. "25, 26, 26")
 * porque así lo captura el input del ProductForm; aquí se parsea a `number[]`.
 * La repetición de una talla representa unidades de stock para esa talla.
 * En el backend esto se traduce a filas de `ProductSize` (productId, size, stock)
 * agrupando ocurrencias repetidas; `Product.sizes`/`Product.stock` son derivados
 * (VIRTUAL) de esa tabla, no columnas propias.
 */
export const sizesFromString = z
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
export const productBaseSchema = z.object({
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
  type: z.enum(["bota", "sombrero", "ropa"], {
    message: "Selecciona una categoría válida",
  }),
  // `true` (default) = el producto se vende por talla, vía `sizes` (comportamiento de siempre).
  // `false` = existencia manual sin tallas (un corbatín, una hebilla): la cantidad va en
  // `stockQuantity`. Cuál de los dos es obligatorio se decide en el refine cruzado de abajo, no
  // aquí a nivel de campo, porque depende de este flag.
  hasSizes: z.boolean().default(true),
  sizes: z
    .union(
      [
        sizesFromString,
        z.array(z.number().int().positive()).min(1, "Agrega al menos una talla"),
      ],
      { error: "Agrega al menos una talla (p. ej. \"25, 26, 26\")" },
    )
    .optional(),
  // Cantidad en existencia para un producto SIN tallas (`hasSizes: false`). Se traduce a una
  // única fila `ProductSize` con `size: NO_SIZE_SENTINEL` — ver product.controller.ts.
  stockQuantity: z
    .number("La cantidad en existencia debe ser un número")
    .int("La cantidad en existencia debe ser un número entero")
    .nonnegative("La cantidad en existencia no puede ser negativa")
    .optional(),
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

export function salePriceNotAboveOriginal(data: {
  salePrice?: number;
  originalPrice?: number;
}) {
  return (
    data.salePrice === undefined ||
    data.originalPrice === undefined ||
    data.salePrice <= data.originalPrice
  );
}

/**
 * Reglas cruzadas entre `hasSizes`/`sizes`/`stockQuantity`, compartidas por crear y editar (mismo
 * patrón que `couponRuleIssues` en `src/schemas/coupon.ts`): cada regla solo dispara cuando los
 * campos que compara están presentes, para que sea reusable con el `.partial()` del update. Las
 * contradicciones (el campo del modo contrario llegó igual) se atrapan aquí en los dos; la
 * *obligatoriedad* del campo del modo vigente en un update parcial se valida aparte en el
 * controller, contra el `hasSizes` ya guardado (ver `adminUpdateProduct`).
 */
function productSizeModeIssues(d: {
  hasSizes?: boolean;
  sizes?: number[];
  stockQuantity?: number;
}): Array<{ message: string; path: [string] }> {
  const issues: Array<{ message: string; path: [string] }> = [];

  if (d.hasSizes === false && d.sizes !== undefined) {
    issues.push({
      message: "Este producto no maneja tallas; usa la cantidad en existencia en vez de tallas.",
      path: ["sizes"],
    });
  }
  if (d.hasSizes === true && d.stockQuantity !== undefined) {
    issues.push({
      message: "Este producto maneja tallas; usa el campo de tallas en vez de la cantidad en existencia.",
      path: ["stockQuantity"],
    });
  }

  return issues;
}

export const productSchema = productBaseSchema.superRefine((d, ctx) => {
  if (!salePriceNotAboveOriginal(d)) {
    ctx.addIssue({
      code: "custom",
      message: "El precio de oferta no puede ser mayor al precio original",
      path: ["salePrice"],
    });
  }
  for (const issue of productSizeModeIssues(d)) {
    ctx.addIssue({ code: "custom", ...issue });
  }
  // A diferencia del update parcial, aquí `hasSizes` siempre resuelve (tiene `.default(true)`),
  // así que el campo del modo vigente es completamente obligatorio: un alta sin él no es "no
  // tocar esa columna", es un producto a medio capturar.
  if (d.hasSizes && d.sizes === undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'Agrega al menos una talla (p. ej. "25, 26, 26")',
      path: ["sizes"],
    });
  }
  if (!d.hasSizes && d.stockQuantity === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Indica la cantidad en existencia (este producto no maneja tallas).",
      path: ["stockQuantity"],
    });
  }
});

export type ProductInput = z.infer<typeof productSchema>;

/**
 * Update parcial: solo se tocan las columnas presentes en el body.
 *
 * `.extend()` va DESPUÉS de `.partial()` a propósito. En zod 4 `.partial()` NO quita los
 * `.default()`, así que `productBaseSchema.partial().parse({})` devuelve `{ visible: true,
 * hasSizes: true }`: un PUT que solo cambiaba el nombre reactivaba un producto oculto, o forzaba
 * de vuelta a `hasSizes: true` un producto que el dueño había marcado sin tallas, sin que nadie lo
 * pidiera. Re-declarar ambos campos como opcionales puros los deja fuera del objeto parseado
 * cuando el body no los menciona.
 *
 * A diferencia de `productSchema`, aquí NO se exige la obligatoriedad total de `sizes`/
 * `stockQuantity` según `hasSizes` — un PUT parcial que no toca el modo del producto no debe
 * forzar a resituarlos. Esa obligatoriedad, solo al *cambiar* de modo, se valida en el controller
 * contra el `hasSizes` ya guardado (mismo patrón que el cruce de precios en `adminUpdateProduct`).
 * Las contradicciones explícitas (el campo del modo contrario sí llegó) se atrapan aquí, vía
 * `productSizeModeIssues`, igual que en `productSchema`.
 */
export const productUpdateSchema = productBaseSchema
  .partial()
  .extend({
    visible: z.boolean().optional(),
    hasSizes: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (!salePriceNotAboveOriginal(d)) {
      ctx.addIssue({
        code: "custom",
        message: "El precio de oferta no puede ser mayor al precio original",
        path: ["salePrice"],
      });
    }
    for (const issue of productSizeModeIssues(d)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
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
