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
  // Tope duro por renglón para evitar abusos. El límite REAL de existencias por
  // talla se valida en el servidor al descontar el stock de forma atómica
  // (orders.service.ts): si solo hay 1 unidad de esa talla, pedir más devuelve
  // 409 porque la talla no tiene ese stock. Este `.max(99)` es solo un techo.
  quantity: z
    .number()
    .int()
    .positive()
    .max(99, "Máximo 99 unidades por artículo"),
});

export const createOrderSchema = z
  .object({
    items: z
      .array(orderItemSchema)
      .min(1, "El pedido debe tener al menos un artículo")
      .max(50, "Demasiados artículos en el pedido"),
    customer: shippingSchema,
    shippingCarrier: z.string().trim().optional(),
    // Cotización de envío en vivo (Fase 8.4). Opcionales: el checkout puede haber
    // caído al fallback de tarifa plana (Skydropx no disponible → sin cotización),
    // en cuyo caso NO se envían y el servidor cobra `computeShipping`. Cuando sí
    // vienen, el servidor RE-CONSULTA la cotización en Skydropx y toma el `total`
    // autoritativo de ese rate (jamás confía en un monto del cliente).
    quotationId: z.string().trim().min(1).optional(),
    rateId: z.string().trim().min(1).optional(),
  })
  // Deben ir juntos o ninguno: un `quotationId` sin `rateId` (o al revés) no
  // identifica una tarifa que el servidor pueda re-consultar.
  .refine((data) => (data.quotationId == null) === (data.rateId == null), {
    message:
      "Envía la cotización y la tarifa de envío juntas, o ninguna de las dos.",
    path: ["rateId"],
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// Cancelación/reembolso manual de una orden desde el panel admin (Fase H.5).
// `reason` es opcional (nota para el registro, p. ej. "el cliente pidió cancelar
// por WhatsApp"); el `:id` del pedido viaja en la URL, no en el body.
export const cancelOrderSchema = z.object({
  reason: z
    .string("El motivo debe ser texto")
    .trim()
    .max(200, "Máximo 200 caracteres")
    .optional(),
});

export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

// Avance manual de estado de envío desde el panel admin (Fase O.1).
// `status` se limita a `shipped`/`delivered` a propósito: `cancelled` sigue siendo
// exclusivo de `POST /api/admin/orders/:id/cancel` (el único camino que reembolsa y
// restockea), y `pending`/`paid` los fija el flujo de pago, no el dueño.
// Los tres campos de guía son opcionales: marcar `delivered` sin guía es válido
// (entrega en mano o local), y una guía capturada a mano puede no traer URL.
export const orderStatusUpdateSchema = z.object({
  status: z.enum(["shipped", "delivered"], {
    message: 'El estado debe ser "shipped" (enviado) o "delivered" (entregado)',
  }),
  trackingNumber: z
    .string("El número de guía debe ser texto")
    .trim()
    .min(1, "El número de guía no puede ir vacío")
    .max(100, "El número de guía es demasiado largo (máximo 100 caracteres)")
    .optional(),
  trackingUrl: z
    .url("El enlace de rastreo debe ser una URL válida (por ejemplo https://...)")
    .max(500, "El enlace de rastreo es demasiado largo (máximo 500 caracteres)")
    .optional(),
  shippingCarrier: z
    .string("La paquetería debe ser texto")
    .trim()
    .min(1, "La paquetería no puede ir vacía")
    .max(80, "El nombre de la paquetería es demasiado largo (máximo 80 caracteres)")
    .optional(),
});

export type OrderStatusUpdateInput = z.infer<typeof orderStatusUpdateSchema>;

// Reintento manual de la guía de Skydropx (Fase O.3). El body es opcional por completo: el caso
// normal no lleva nada. `force` solo desbloquea un escenario —Skydropx no respondió al crear la
// guía, así que pudo haberla creado y cobrado— y significa "ya revisé el panel de Skydropx y no
// existe ninguna guía de este pedido". Nunca fuerza sobre una guía de id conocido: esa existe.
export const retryShipmentSchema = z.object({
  force: z.boolean("La confirmación debe ser verdadero o falso").optional(),
});

export type RetryShipmentInput = z.infer<typeof retryShipmentSchema>;
