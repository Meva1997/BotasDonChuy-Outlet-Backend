import { z } from "zod";

/**
 * Estados de la República Mexicana.
 * Los envíos solo se permiten al interior de México, por lo que el campo
 * `state` se valida contra esta lista cerrada.
 */
export const MEXICAN_STATES = [
  "Aguascalientes",
  "Baja California",
  "Baja California Sur",
  "Campeche",
  "Chiapas",
  "Chihuahua",
  "Ciudad de México",
  "Coahuila",
  "Colima",
  "Durango",
  "Estado de México",
  "Guanajuato",
  "Guerrero",
  "Hidalgo",
  "Jalisco",
  "Michoacán",
  "Morelos",
  "Nayarit",
  "Nuevo León",
  "Oaxaca",
  "Puebla",
  "Querétaro",
  "Quintana Roo",
  "San Luis Potosí",
  "Sinaloa",
  "Sonora",
  "Tabasco",
  "Tamaulipas",
  "Tlaxcala",
  "Veracruz",
  "Yucatán",
  "Zacatecas",
] as const;

export const shippingSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3, "Ingresa tu nombre completo")
    .max(80, "Nombre demasiado largo"),
  email: z.email("Ingresa un correo electrónico válido"),
  phone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "El teléfono debe tener 10 dígitos"),
  street: z.string().trim().min(3, "Ingresa tu calle y número"),
  neighborhood: z.string().trim().min(2, "Ingresa tu colonia"),
  city: z.string().trim().min(2, "Ingresa tu ciudad"),
  state: z.enum(MEXICAN_STATES, {
    message: "Selecciona un estado de la República",
  }),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, "El código postal debe tener 5 dígitos"),
  references: z
    .string()
    .trim()
    .max(200, "Máximo 200 caracteres")
    .optional()
    .or(z.literal("")),
});

export type ShippingInput = z.infer<typeof shippingSchema>;

export const orderItemSchema = z.object({
  productId: z.number().int().positive(),
  size: z.number().int().positive(),
  quantity: z.number().int().positive(),
});

export const createOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1, "El pedido debe tener al menos un artículo"),
  customer: shippingSchema,
  shippingCarrier: z.string().trim().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
