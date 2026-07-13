import { z } from "zod";

/**
 * Todos los campos son opcionales porque `MarcaSection` autoguarda campo por
 * campo (PUT parcial). Los strings son NOT NULL en el modelo, así que si vienen
 * no se permite string vacío (evita "borrar sin querer" un campo requerido).
 * El `logoUrl` NO se acepta aquí: el logo se sube/borra por los endpoints
 * dedicados (POST/DELETE /api/admin/brand/logo), que mantienen la BD
 * sincronizada con Cloudinary.
 */
export const brandSettingsUpdateSchema = z
  .object({
    brandName: z.string().trim().min(1, "El nombre de marca no puede quedar vacío").max(120).optional(),
    heroText: z.string().trim().min(1, "El texto del hero no puede quedar vacío").max(200).optional(),
    tagline: z.string().trim().min(1, "El tagline no puede quedar vacío").max(500).optional(),
    cartNotice: z.string().trim().min(1, "El aviso del carrito no puede quedar vacío").max(300).optional(),
    footerNote: z.string().trim().min(1, "La nota del pie no puede quedar vacía").max(300).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debes enviar al menos un campo para actualizar",
  });

export type BrandSettingsUpdateInput = z.infer<typeof brandSettingsUpdateSchema>;
