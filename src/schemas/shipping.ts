import { z } from "zod";
import { shippingSchema, orderItemSchema } from "./checkout";

export const shippingRatesSchema = z.object({
  customer: shippingSchema,
  items: z
    .array(orderItemSchema)
    .min(1, "El carrito debe tener al menos un artículo")
    .max(50, "Demasiados artículos en el carrito"),
});

export type ShippingRatesInput = z.infer<typeof shippingRatesSchema>;
