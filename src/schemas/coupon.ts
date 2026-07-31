import { z } from "zod";
import { couponCodeSchema, orderItemSchema } from "./checkout";
// Zona horaria de la tienda (Celaya, GTO), offset fijo. Vivía declarada aquí; desde la Fase N.4 la
// comparte con el resumen diario de ventas, que necesita exactamente el mismo criterio de "qué día
// es" — separarlas solo permitía que se contradijeran.
import { MEXICO_CITY_OFFSET } from "../utils/storeDay";

/** Una fecha sin hora, tal como la escribe un `<input type="date">` del panel. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fecha de la ventana de vigencia del cupón.
 *
 * El detalle que muerde: `new Date("2026-08-01")` es medianoche **UTC**, o sea **31 de julio a
 * las 18:00 en México**. Un dueño que escribe "vence el 1 de agosto" perdería la última tarde de
 * su promoción sin entender por qué. Así que una fecha sin hora se interpreta en la zona de la
 * tienda: `startsAt` al inicio del día y `expiresAt` al final (`23:59:59.999`), que es lo que la
 * persona quiso decir. Un instante ISO completo (lo que manda un `datetime-local` convertido) se
 * respeta tal cual.
 *
 * Es una desviación deliberada del UTC que usa el resto del repo para agregar: ahí el UTC existe
 * para que los reportes no dependan del host, mientras que esto es la intención local de un
 * humano, igual que la fecha del correo de confirmación.
 */
function couponDateSchema(edge: "start" | "end") {
  return z.preprocess((raw) => {
    if (typeof raw === "string" && DATE_ONLY_PATTERN.test(raw.trim())) {
      const day = raw.trim();
      return edge === "start"
        ? `${day}T00:00:00.000${MEXICO_CITY_OFFSET}`
        : `${day}T23:59:59.999${MEXICO_CITY_OFFSET}`;
    }
    return raw;
  }, z.coerce.date("Usa una fecha válida (por ejemplo 2026-08-01)"));
}

const couponFields = {
  code: couponCodeSchema,
  type: z.enum(["percent", "fixed"], {
    message: 'El tipo debe ser "percent" (porcentaje) o "fixed" (monto fijo en pesos)',
  }),
  value: z
    .number("El valor del descuento es requerido")
    .positive("El valor del descuento debe ser mayor a 0"),
  maxDiscount: z
    .number("El tope del descuento debe ser numérico")
    .positive("El tope del descuento debe ser mayor a 0")
    .optional(),
  minSubtotal: z
    .number("El mínimo de compra debe ser numérico")
    .nonnegative("El mínimo de compra no puede ser negativo")
    .optional(),
  maxRedemptions: z
    .number("El límite de usos debe ser numérico")
    .int("El límite de usos debe ser un número entero")
    .positive("El límite de usos debe ser al menos 1")
    .optional(),
  oncePerCustomer: z
    .boolean("El límite por cliente debe ser verdadero o falso")
    .optional(),
  startsAt: couponDateSchema("start").optional(),
  expiresAt: couponDateSchema("end").optional(),
  active: z.boolean("El estado del cupón debe ser verdadero o falso").optional(),
  description: z
    .string("La descripción debe ser texto")
    .trim()
    .max(200, "La descripción es demasiado larga (máximo 200 caracteres)")
    .optional(),
};

/**
 * Reglas cruzadas, compartidas por crear y editar (una divergencia entre las dos dejaría que un
 * `PUT` metiera una combinación que el `POST` rechaza). Cada regla solo aplica cuando los campos
 * que compara están presentes, que es lo que la hace reusable con el schema `partial` de la
 * edición; el caso "el body solo trae uno de los dos" lo cubre `updateCoupon` contra el estado
 * guardado, porque aquí no hay forma de verlo.
 */
interface CouponRuleFields {
  type?: "percent" | "fixed";
  value?: number;
  maxDiscount?: number | null;
  startsAt?: Date;
  expiresAt?: Date;
}

function couponRuleIssues(
  d: CouponRuleFields,
): Array<{ message: string; path: [string] }> {
  const issues: Array<{ message: string; path: [string] }> = [];

  if (d.type === "percent" && d.value != null && d.value > 100) {
    issues.push({
      message: "Un cupón de porcentaje no puede pasar de 100.",
      path: ["value"],
    });
  }
  // El tope en pesos solo tiene sentido sobre un porcentaje: en un cupón de monto fijo, el tope
  // ES el valor. Aceptarlo dejaría dos campos que se contradicen entre sí.
  if (d.type === "fixed" && d.maxDiscount != null) {
    issues.push({
      message: "El tope en pesos solo aplica a los cupones de porcentaje.",
      path: ["maxDiscount"],
    });
  }
  if (d.startsAt && d.expiresAt && d.startsAt >= d.expiresAt) {
    issues.push({
      message: "La fecha de fin debe ser posterior a la de inicio.",
      path: ["expiresAt"],
    });
  }

  return issues;
}

export const couponInputSchema = z
  .object(couponFields)
  .superRefine((d, ctx) => {
    for (const issue of couponRuleIssues(d)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });

export type CouponInput = z.infer<typeof couponInputSchema>;

/**
 * Edición de un cupón. Dos campos quedan fuera a propósito:
 *
 *  - **`code`**: un código ya impreso en un flyer o dictado por WhatsApp no se renombra, y el
 *    `couponCode` congelado en los pedidos pasados dejaría de empatar con cualquier fila. Si está
 *    mal, se desactiva y se crea otro.
 *  - **`redeemedCount`**: es estado derivado que solo mueven el canje atómico y la liberación
 *    (`coupon.service.ts`). Un valor tecleado a mano lo desincroniza para siempre del decremento.
 *
 * Nota de zod 4: `.partial()` **no** quita los `.default()`, así que ningún campo de
 * `couponFields` los usa — los defaults viven en el modelo (`active`, `oncePerCustomer`,
 * `redeemedCount`). Si algún día se agrega uno aquí, hay que re-declararlo como opcional puro
 * después del `.partial()`, igual que hacen `productUpdateSchema` y `productImportUpdateSchema`.
 */
export const couponUpdateSchema = z
  .object(couponFields)
  .omit({ code: true })
  .partial()
  .superRefine((d, ctx) => {
    for (const issue of couponRuleIssues(d)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
    if (Object.keys(d).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "No hay nada que actualizar: manda al menos un campo.",
      });
    }
  });

export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;

/**
 * Validación pública del cupón antes de pagar (`POST /api/coupons/validate`).
 *
 * Lleva el carrito porque sin subtotal no hay descuento que calcular ni `minSubtotal` que
 * comparar. El `email` es **opcional** por dónde vive el campo en el checkout: el comprador
 * captura el cupón en el paso del resumen, antes de dar sus datos. Sin correo no se puede
 * verificar el "un uso por cliente", y la respuesta lo dice con `perCustomerChecked: false` para
 * que el front no trate el visto bueno como una garantía.
 */
export const couponValidateSchema = z.object({
  code: couponCodeSchema,
  items: z
    .array(orderItemSchema)
    .min(1, "Agrega al menos un artículo al carrito para aplicar un cupón")
    .max(50, "Demasiados artículos en el carrito"),
  email: z.email("Ingresa un correo electrónico válido").optional(),
});

export type CouponValidateInput = z.infer<typeof couponValidateSchema>;
