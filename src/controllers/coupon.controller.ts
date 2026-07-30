import type { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler";
import { parseId } from "../utils/parseId";
import {
  couponInputSchema,
  couponUpdateSchema,
  couponValidateSchema,
} from "../schemas/coupon";
import * as couponService from "../services/coupon.service";

/**
 * POST /api/coupons/validate — validación pública del cupón antes de pagar (Fase N.2).
 *
 * **No canjea nada**: ni mueve `redeemedCount` ni escribe una fila de canje, así que abrir el
 * checkout diez veces no gasta la promoción. Corre exactamente las mismas reglas y la misma
 * función de descuento que el checkout, para que el monto que se muestra sea el que se cobra.
 *
 * Lo que **no** puede prometer es disponibilidad: el tope global y el "un uso por cliente" se
 * re-deciden atómicamente al crear el pedido. `perCustomerChecked` viene en `false` cuando la
 * llamada no trajo correo (el cupón se captura antes de los datos de envío), y
 * `remainingRedemptions` es informativo — el front tiene que saber pintar el 409 del pago.
 */
export const validateCoupon: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = couponValidateSchema.parse(req.body);

    const coupon = await couponService.previewCoupon(input);

    res.json({ coupon });
  },
);

/** GET /api/admin/coupons — listado con el contador guardado y el conteo vivo de canjes. */
export const adminListCoupons: RequestHandler = asyncHandler(
  async (_req, res: Response) => {
    const rows = await couponService.listCoupons();

    res.json(
      rows.map(({ coupon, activeRedemptions }) => ({
        ...coupon.toJSON(),
        activeRedemptions,
      })),
    );
  },
);

/** POST /api/admin/coupons — crea un cupón. */
export const adminCreateCoupon: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = couponInputSchema.parse(req.body);

    const coupon = await couponService.createCoupon(input);

    res.status(201).json(coupon);
  },
);

/**
 * PUT /api/admin/coupons/:id — edita un cupón.
 *
 * `active: false` es la forma de **cancelar** una promoción; el `code` y el `redeemedCount` no se
 * pueden editar (ver `couponUpdateSchema` para el porqué de cada uno). Editar un cupón con canjes
 * es válido y no altera el histórico: `couponCode`/`couponDiscount` están congelados en el pedido.
 */
export const adminUpdateCoupon: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "cupón");
    const input = couponUpdateSchema.parse(req.body);

    const coupon = await couponService.updateCoupon(id, input);

    res.json(coupon);
  },
);

/**
 * DELETE /api/admin/coupons/:id — desactiva el cupón si ya lo usó algún pedido, lo borra si no.
 * Mismo criterio que `DELETE /api/admin/products/:id`: no se rompe el histórico de una venta.
 */
export const adminDeleteCoupon: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id, "cupón");

    const result = await couponService.deleteCoupon(id);

    res.json(result);
  },
);
