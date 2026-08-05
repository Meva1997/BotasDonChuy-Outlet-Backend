import type { Request, RequestHandler, Response } from "express";
import { Op } from "sequelize";
import { asyncHandler } from "../middlewares/asyncHandler";
import { shippingRatesSchema } from "../schemas/shipping";
import { Product } from "../models/Product";
import { assertProductAvailable } from "../services/productAvailability";
import { packOrder, MAX_PARCELS_QUOTED, type ParcelLineItem } from "../services/packing";
import { computeShipping, type CartLineItem } from "../services/cart";
import {
  getOriginAddress,
  toSkydropxAddress,
  getShippingRates as getSkydropxRates,
  SkydropxRequestError,
} from "../services/skydropx.service";
import { logger } from "../config/logger";
import { Sentry } from "../config/sentry";

/**
 * POST /api/shipping/rates — cotización de envío en vivo (checkout público).
 *
 * Acomoda el carrito en las cajas reales de la tienda (`buildParcels`, Fase N.6),
 * cotiza esos bultos contra Skydropx y normaliza las tarifas. Si Skydropx falla,
 * hace timeout, o no devuelve ninguna tarifa utilizable a tiempo, responde con
 * la tarifa plana existente (`computeShipping`) marcada con `rateId: null` /
 * `quotationId: null` — la tienda nunca debe dejar de cotizar porque la
 * paquetería esté caída (roadmap-skydropx.md §2/§8). Desde la Fase N.6 el
 * respaldo también cobra por caja, así que caer a él cambia el precio pero
 * nunca el número de bultos.
 */
export const getShippingRates: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const input = shippingRatesSchema.parse(req.body);

    // Agrega cantidades duplicadas del mismo producto (mismo criterio que
    // orders.service.createOrder): la talla no afecta el empaque, solo el stock.
    const quantityByProduct = new Map<number, number>();
    for (const item of input.items) {
      quantityByProduct.set(
        item.productId,
        (quantityByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
    const productIds = Array.from(quantityByProduct.keys());

    const products = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
    });
    const productsById = new Map(products.map((p) => [p.id, p]));

    const parcelItems: ParcelLineItem[] = [];
    const cartItems: CartLineItem[] = [];
    // Un producto con alguna dimensión en 0 (fila anterior a que
    // `productSchema` exigiera `.positive()`, ver schemas/product.ts) haría que
    // `buildParcel` arme una caja válida pero subdimensionada en vez de fallar
    // — Skydropx no tiene por qué rechazarla, así que el try/catch de abajo
    // nunca se dispararía. Se detecta aquí y se salta la cotización en vivo
    // directo al fallback de tarifa plana, en vez de cotizar con datos malos.
    let hasInvalidDimensions = false;
    for (const [productId, quantity] of quantityByProduct) {
      const product = productsById.get(productId);
      assertProductAvailable(product);
      if (
        product.weightKg <= 0 ||
        product.lengthCm <= 0 ||
        product.widthCm <= 0 ||
        product.heightCm <= 0
      ) {
        logger.warn(
          { productId: product.id, productName: product.name },
          "[skydropx] dimensión de envío en 0; se usará la tarifa plana de respaldo",
        );
        hasInvalidDimensions = true;
      }
      parcelItems.push({
        product: {
          type: product.type,
          weightKg: product.weightKg,
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
        },
        quantity,
      });
      cartItems.push({
        product: {
          type: product.type,
          originalPrice: 0,
          salePrice: 0,
          weightKg: product.weightKg,
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
        },
        quantity,
      });
    }

    // Un solo acomodo alimenta las dos ramas: los `parcels` que se cotizan en vivo y el
    // `packageCount` que se reporta con la tarifa plana. Que salgan del mismo `packOrder` es lo
    // que garantiza que caer al respaldo no cambie en cuántas cajas va el pedido.
    const boxes = packOrder(parcelItems);
    const parcels = boxes.map((box) => box.parcel);
    // Un carrito puede traer miles de unidades (50 renglones × 99 piezas): cientos de `parcels`
    // no son una cotización que ninguna paquetería vaya a responder, solo agotan el presupuesto
    // de 8s del poll. Por arriba del tope se va al respaldo, que desde la Fase N.6 también cobra
    // por caja y por lo tanto tampoco subcotiza.
    const tooManyParcels = parcels.length > MAX_PARCELS_QUOTED;
    if (tooManyParcels) {
      logger.warn(
        { parcels: parcels.length, max: MAX_PARCELS_QUOTED },
        "[skydropx] el pedido excede los bultos cotizables en vivo; se usará la tarifa plana de respaldo",
      );
    }

    if (!hasInvalidDimensions && !tooManyParcels) {
      const addressFrom = getOriginAddress();
      const addressTo = toSkydropxAddress(input.customer);

      try {
        const { quotationId, rates } = await getSkydropxRates(
          addressFrom,
          addressTo,
          parcels,
        );
        if (rates.length > 0) {
          res.json({ quotationId, rates });
          return;
        }
        logger.warn(
          "[skydropx] la cotización no devolvió tarifas utilizables a tiempo, usando tarifa plana de respaldo",
        );
      } catch (err) {
        // Un 4xx significa que NOSOTROS armamos mal el request (bug de
        // integración: dirección/parcel inválidos) — no que Skydropx esté
        // caído. Tratarlo igual que una falla de red escondería un bug real
        // detrás de un warning indistinguible de una caída de la paquetería.
        const status = err instanceof SkydropxRequestError ? err.status : undefined;
        const isClientError = status !== undefined && status >= 400 && status < 500;
        const level: "error" | "warn" = isClientError ? "error" : "warn";
        const prefix = isClientError
          ? "[skydropx] cotización rechazada (posible bug de integración, no una caída de Skydropx)"
          : "[skydropx] cotización en vivo falló, usando tarifa plana de respaldo";
        logger[level]({ err, status, event: "skydropx.quotation" }, prefix);
        if (isClientError) {
          Sentry.captureException(err, { extra: { status } });
        }
      }
    }

    const fallbackAmount = computeShipping(cartItems);
    res.json({
      quotationId: null,
      rates: [
        {
          rateId: null,
          carrier: "Estándar",
          service: "Tarifa plana",
          amount: fallbackAmount,
          total: fallbackAmount,
          days: null,
          // Mismo acomodo que habría cotizado Skydropx: el respaldo cambia el precio del bulto,
          // no cuántos bultos son.
          packageCount: boxes.length,
        },
      ],
    });
  },
);
