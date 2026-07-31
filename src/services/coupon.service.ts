import { Op, QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../config/database";
import { Coupon } from "../models/Coupon";
import { CouponRedemption } from "../models/CouponRedemption";
import { Order } from "../models/Order";
import { Product } from "../models/Product";
import { AppError } from "../middlewares/AppError";
import { assertProductAvailable } from "./productAvailability";
import { computeCouponDiscount, computeTotals, type CartLineItem } from "./cart";
import { normalizeEmailIdentity } from "../utils/emailIdentity";
import { formatMoney } from "../utils/formatMoney";
import { positiveNumberEnv } from "../utils/env";
import type {
  CouponInput,
  CouponUpdateInput,
  CouponValidateInput,
} from "../schemas/coupon";

/**
 * Mínimo cobrable en pesos. Stripe rechaza un `amount` por debajo de su mínimo por divisa (≈$10
 * MXN) y también un `0`, y ese rechazo ocurriría **después** de que `createOrder` commiteó: por la
 * regla de `releaseKeyOnFailure` (Fase O.2) la clave de idempotencia se conserva, así que el
 * comprador quedaría con un pedido `pending` que aparta stock y quema su cupón hasta que el
 * barrido lo alcance (30 min), sin poder reintentar. Por eso se valida ANTES, dentro de la
 * transacción, y se responde un 409 accionable.
 *
 * **Vive aquí y NO en `src/config/stripe.ts` a propósito.** Dos suites (`cancelOrder.test.ts`,
 * `pendingOrderSweeper.test.ts`) reemplazan ese módulo con un objeto literal de exports fijos:
 * un import nuevo resolvería a `undefined`, `total < undefined` sería `false`, y el guard quedaría
 * MUERTO en todas las suites que mockean Stripe mientras los tests siguen en verde.
 */
export const MIN_CHARGE_MXN = positiveNumberEnv("MIN_CHARGE_MXN", 10);

/** Lo que un cupón ya validado aporta al checkout. `discount` viene redondeado a 2 decimales. */
export interface ResolvedCoupon {
  coupon: Coupon;
  discount: number;
  /** Identidad de la persona, o `null` cuando se resolvió sin correo (preview del paso 0). */
  emailNormalized: string | null;
}

export interface CouponPreview {
  code: string;
  type: "percent" | "fixed";
  value: number;
  description: string | null;
  /** Descuento en pesos sobre la mercancía neta. Nunca sobre el envío. */
  discount: number;
  netMerchandise: number;
  /** Usos que quedan del tope global, o `null` si es ilimitado. **No es una reserva.** */
  remainingRedemptions: number | null;
  oncePerCustomer: boolean;
  /** `false` cuando no vino correo: el "un uso por cliente" no se pudo verificar todavía. */
  perCustomerChecked: boolean;
  expiresAt: Date | null;
}

export interface CouponListRow {
  coupon: Coupon;
  /** Conteo VIVO de canjes vigentes. Si difiere de `redeemedCount` hubo una intervención manual
   *  en la BD (p. ej. un pedido borrado a mano, que se lleva su fila de canje por cascada sin
   *  pasar por la liberación). Se expone para que la divergencia se vea en vez de esconderse. */
  activeRedemptions: number;
}

/** Fechas para mensajes al comprador: día y hora en la zona de la tienda, no en UTC. */
function formatCouponDate(date: Date): string {
  return date.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Valida un cupón **sin canjearlo**, y es la ÚNICA implementación de esas reglas: la usan tanto
 * `orders.service.createOrder` como `POST /api/coupons/validate`. Si fueran dos, el preview podría
 * prometerle al comprador un descuento distinto al que acaba cobrándose.
 *
 * Cada rechazo lleva su propio mensaje accionable en español (el `message` es la copia de UI que
 * pinta el front tal cual). Eso contradice la regla anti-enumeración del resto del repo —donde
 * login y la consulta pública de pedidos responden lo mismo para todas las causas— y es una
 * inversión deliberada: un cupón existe para que un humano lo teclee, y un "no es válido" opaco
 * volvería la feature inusable. La consecuencia hay que decirla en voz alta: **los códigos no son
 * secretos**, así que un cupón para un solo cliente tiene que ser largo y aleatorio, nunca `VIP`.
 */
export async function resolveCoupon(opts: {
  code: string;
  netMerchandise: number;
  email?: string | null;
  transaction?: Transaction;
}): Promise<ResolvedCoupon> {
  const { code, netMerchandise, email, transaction } = opts;

  const coupon = await Coupon.findOne({ where: { code }, transaction });
  if (!coupon) {
    throw new AppError(
      `El cupón "${code}" no existe. Revisa que esté bien escrito.`,
      404,
    );
  }

  if (!coupon.active) {
    throw new AppError(`El cupón "${code}" ya no está disponible.`, 409);
  }

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) {
    throw new AppError(
      `El cupón "${code}" todavía no empieza: se activa el ${formatCouponDate(coupon.startsAt)}.`,
      409,
    );
  }
  if (coupon.expiresAt && coupon.expiresAt <= now) {
    throw new AppError(
      `El cupón "${code}" venció el ${formatCouponDate(coupon.expiresAt)}.`,
      409,
    );
  }

  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    throw new AppError(
      `El cupón "${code}" ya se agotó: se acabaron los usos disponibles.`,
      409,
    );
  }

  if (coupon.minSubtotal != null && netMerchandise < coupon.minSubtotal) {
    const missing = coupon.minSubtotal - netMerchandise;
    throw new AppError(
      `El cupón "${code}" aplica a partir de ${formatMoney(coupon.minSubtotal)} en producto. ` +
        `Te faltan ${formatMoney(missing)} para poder usarlo.`,
      409,
    );
  }

  const emailNormalized = email ? normalizeEmailIdentity(email) : null;
  if (coupon.oncePerCustomer && emailNormalized) {
    const previous = await CouponRedemption.findOne({
      where: {
        couponId: coupon.id,
        emailNormalized,
        enforced: true,
        releasedAt: { [Op.is]: null },
      },
      transaction,
    });
    if (previous) {
      throw new AppError(
        await alreadyRedeemedMessage(code, previous.orderId, email!, transaction),
        409,
      );
    }
  }

  const discount = computeCouponDiscount(coupon, netMerchandise);
  // Un `fixed` de 0 no puede existir (el schema exige `> 0`), pero un porcentaje mínimo sobre un
  // carrito muy chico sí puede redondear a 0. Aplicarlo "con éxito" y descontar un uso del cupón
  // por nada es peor que decirlo.
  if (discount <= 0) {
    throw new AppError(
      `El cupón "${code}" no aplica a este carrito: el descuento sale en ${formatMoney(0)}.`,
      409,
    );
  }

  return { coupon, discount, emailNormalized };
}

/**
 * Mensaje del 409 por "ya usaste este cupón", en dos variantes según el pedido que bloquea.
 *
 * La primera existe por una composición de decisiones previas que hay que resolverle al
 * comprador: si Stripe falla **después** de que `createOrder` commiteó, la Fase O.2 conserva la
 * clave de idempotencia y el pedido queda `pending` con el cupón apartado hasta que
 * `pendingOrderSweeper` lo alcance (`PENDING_ORDER_TTL_MINUTES`, 30). Su reintento inmediato
 * choca contra el índice por correo: sin distinguir el caso, la tienda le diría "ya lo usaste"
 * por un pedido que nunca pagó.
 */
async function alreadyRedeemedMessage(
  code: string,
  blockingOrderId: number,
  email: string,
  transaction?: Transaction,
): Promise<string> {
  const blocking = await Order.findByPk(blockingOrderId, {
    attributes: ["id", "status"],
    transaction,
  });

  if (blocking?.status === "pending") {
    return (
      `Ya tienes un pedido sin pagar que usa el cupón "${code}". Termina de pagarlo, ` +
      `o espera unos minutos y vuelve a intentar.`
    );
  }

  return (
    `El cupón "${code}" es de un solo uso por cliente y ya lo usaste con el correo ${email}. ` +
    `Quítalo del checkout para continuar con tu compra.`
  );
}

/**
 * Canje atómico. Va **dentro** de la transacción del checkout, después de `Order.create`.
 *
 * Dos candados, ninguno con `SELECT` + `if`: dos compradores simultáneos leerían los dos "sí se
 * puede" y ambos escribirían. La forma es la misma que ya usa el descuento de stock de
 * `createOrder` — un `UPDATE`/`INSERT` condicional donde el número de filas afectadas ES la
 * decisión.
 */
export async function claimCoupon(opts: {
  resolved: ResolvedCoupon;
  orderId: number;
  email: string;
  ip?: string | null;
  transaction: Transaction;
}): Promise<void> {
  const { resolved, orderId, email, ip, transaction } = opts;
  const { coupon } = resolved;

  // 1. Tope GLOBAL. Se re-evalúan también `active` y la ventana de vigencia: `resolveCoupon`
  //    corrió hace unos milisegundos, pero el dueño pudo desactivar el cupón en medio y el
  //    momento de la verdad es este.
  //
  //    Ojo con las comillas: `"redeemedCount"` va entrecomillado dentro del `literal`. Postgres
  //    pliega a minúsculas los identificadores sin comillas, así que `literal('redeemedCount + 1')`
  //    buscaría una columna `redeemedcount` que no existe → 500. El literal de `stock` no lo
  //    necesita porque esa columna ya es minúscula.
  const [affected] = await Coupon.update(
    { redeemedCount: sequelize.literal('"redeemedCount" + 1') },
    {
      where: {
        id: coupon.id,
        active: true,
        [Op.and]: [
          sequelize.literal(
            '("maxRedemptions" IS NULL OR "redeemedCount" < "maxRedemptions")',
          ),
          sequelize.literal('("startsAt" IS NULL OR "startsAt" <= NOW())'),
          sequelize.literal('("expiresAt" IS NULL OR "expiresAt" > NOW())'),
        ],
      },
      transaction,
    },
  );
  if (affected === 0) {
    throw new AppError(
      `El cupón "${coupon.code}" se agotó justo antes de que confirmaras. ` +
        `Quítalo del checkout para continuar con tu compra.`,
      409,
    );
  }

  // 2. Un uso por persona. Lo decide el índice único parcial de `coupon_redemptions`.
  //
  //    `ON CONFLICT DO NOTHING` y **no** un `try/catch` del `UniqueConstraintError`, que era la
  //    opción obvia: un error `23505` deja la transacción de Postgres ABORTADA, y como Sequelize
  //    no envuelve un `Model.create` en un savepoint, cualquier consulta posterior dentro de la
  //    misma transacción falla con "current transaction is aborted". O sea que el `catch` natural
  //    —releer la fila que bloquea para armar un mensaje decente, tal como hace el camino de
  //    stock— produciría un 500 en vez del 409. Con `ON CONFLICT` no se levanta excepción, la
  //    transacción sigue viva y el conteo de filas es la señal.
  const inserted = await sequelize.query<{ id: number }>(
    `INSERT INTO coupon_redemptions
       ("couponId", "orderId", "email", "emailNormalized", "enforced", "discount", "ip",
        "releasedAt", "createdAt", "updatedAt")
     VALUES (:couponId, :orderId, :email, :emailNormalized, :enforced, :discount, :ip,
             NULL, NOW(), NOW())
     ON CONFLICT ("couponId", "emailNormalized") WHERE "releasedAt" IS NULL AND "enforced"
     DO NOTHING
     RETURNING "id"`,
    {
      replacements: {
        couponId: coupon.id,
        orderId,
        email,
        emailNormalized: resolved.emailNormalized ?? normalizeEmailIdentity(email),
        enforced: coupon.oncePerCustomer,
        discount: resolved.discount,
        ip: ip ?? null,
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );

  if (inserted.length === 0) {
    const blocking = await CouponRedemption.findOne({
      where: {
        couponId: coupon.id,
        emailNormalized: resolved.emailNormalized ?? normalizeEmailIdentity(email),
        enforced: true,
        releasedAt: { [Op.is]: null },
      },
      transaction,
    });
    throw new AppError(
      blocking
        ? await alreadyRedeemedMessage(coupon.code, blocking.orderId, email, transaction)
        : `El cupón "${coupon.code}" es de un solo uso por cliente y ya lo usaste. ` +
            `Quítalo del checkout para continuar con tu compra.`,
      409,
    );
  }
}

/**
 * Inverso exacto del canje: devuelve el uso cuando el pedido no se pagó (abandonado, cancelado o
 * reembolsado). Va **dentro** de la transacción que libera el stock, porque es el mismo tipo de
 * reserva: sin esto, un cupón de 50 usos se agota con carritos abandonados que nunca se pagaron y
 * el dueño ve morir la promoción sin una sola venta.
 *
 * Auto-idempotente por el `UPDATE` condicional (`releasedAt IS NULL`): una segunda liberación
 * afecta 0 filas y no vuelve a decrementar, sin depender del guard de estado del llamador.
 */
export async function releaseCouponForOrder(
  orderId: number,
  transaction: Transaction,
): Promise<void> {
  const redemption = await CouponRedemption.findOne({
    where: { orderId, releasedAt: { [Op.is]: null } },
    transaction,
  });
  if (!redemption) return; // el pedido no llevaba cupón, o ya se liberó

  const [released] = await CouponRedemption.update(
    { releasedAt: new Date() },
    { where: { id: redemption.id, releasedAt: { [Op.is]: null } }, transaction },
  );
  if (released !== 1) return; // otra liberación concurrente ganó

  await Coupon.update(
    { redeemedCount: sequelize.literal('"redeemedCount" - 1') },
    {
      // `> 0` por si algo desincronizó el contador (p. ej. un pedido borrado a mano, que se lleva
      // su fila de canje por cascada): un contador en 0 nunca debe quedar negativo.
      where: { id: redemption.couponId, redeemedCount: { [Op.gt]: 0 } },
      transaction,
    },
  );
}

/**
 * Guard de mínimo cobrable, dentro de la transacción del checkout. Ver `MIN_CHARGE_MXN`.
 */
export function assertChargeableTotal(total: number, couponDiscount: number): void {
  if (total >= MIN_CHARGE_MXN) return;

  throw new AppError(
    couponDiscount > 0
      ? `Este cupón deja el total en ${formatMoney(total)}, por debajo del mínimo de ` +
          `${formatMoney(MIN_CHARGE_MXN)} que acepta el pago en línea. Agrega otro artículo ` +
          `o quita el cupón para continuar.`
      : `El total del pedido (${formatMoney(total)}) está por debajo del mínimo de ` +
          `${formatMoney(MIN_CHARGE_MXN)} que acepta el pago en línea.`,
    409,
  );
}

/**
 * Preview público del cupón para el checkout (`POST /api/coupons/validate`): **valida sin
 * canjear**. Ni toca `redeemedCount` ni escribe una fila de canje, así que abrir el checkout diez
 * veces no gasta la promoción.
 *
 * Reusa `assertProductAvailable` para que un producto oculto dé aquí el mismo 409 que va a dar el
 * checkout, y `computeTotals` + `computeCouponDiscount` para que el monto sea exactamente el que
 * se cobrará. Lo que **no** puede prometer es que el cupón siga disponible al pagar: el tope
 * global y el uso por persona se re-deciden atómicamente en `createOrder`.
 */
export async function previewCoupon(
  input: CouponValidateInput,
): Promise<CouponPreview> {
  // Se agregan los renglones repetidos igual que en `createOrder`, para que el neto sea el mismo.
  const quantities = new Map<number, number>();
  for (const item of input.items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }

  const products = await Product.findAll({
    where: { id: { [Op.in]: Array.from(quantities.keys()) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const cartItems: CartLineItem[] = [];
  for (const [productId, quantity] of quantities) {
    const product = byId.get(productId);
    assertProductAvailable(product);
    cartItems.push({
      product: {
        type: product.type,
        originalPrice: product.originalPrice,
        salePrice: product.salePrice,
      },
      quantity,
    });
  }

  const totals = computeTotals(cartItems);
  const netMerchandise = totals.subtotal - totals.savings;

  const { coupon, discount } = await resolveCoupon({
    code: input.code,
    netMerchandise,
    email: input.email ?? null,
  });

  return {
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    description: coupon.description,
    discount,
    netMerchandise,
    remainingRedemptions:
      coupon.maxRedemptions == null
        ? null
        : Math.max(0, coupon.maxRedemptions - coupon.redeemedCount),
    oncePerCustomer: coupon.oncePerCustomer,
    perCustomerChecked: Boolean(coupon.oncePerCustomer && input.email),
    expiresAt: coupon.expiresAt,
  };
}

/**
 * Listado admin. Trae el conteo vivo de canjes vigentes junto al contador guardado, en una sola
 * consulta agrupada, para que una divergencia (ver `CouponListRow.activeRedemptions`) sea visible
 * en el panel en lugar de quedarse escondida en la BD.
 */
export async function listCoupons(): Promise<CouponListRow[]> {
  const coupons = await Coupon.findAll({ order: [["id", "DESC"]] });
  if (coupons.length === 0) return [];

  const counts = await sequelize.query<{ couponId: number; count: string }>(
    `SELECT "couponId", COUNT(*)::text AS "count"
       FROM coupon_redemptions
      WHERE "releasedAt" IS NULL AND "enforced"
      GROUP BY "couponId"`,
    { type: QueryTypes.SELECT },
  );
  const byCoupon = new Map(counts.map((r) => [Number(r.couponId), Number(r.count)]));

  return coupons.map((coupon) => ({
    coupon,
    activeRedemptions: byCoupon.get(coupon.id) ?? 0,
  }));
}

export async function createCoupon(input: CouponInput): Promise<Coupon> {
  // Pre-chequeo con mensaje propio; el `UniqueConstraintError` del índice sigue siendo la red
  // del TOCTOU (mismo patrón que `createAdminUser`).
  const existing = await Coupon.findOne({ where: { code: input.code } });
  if (existing) {
    throw new AppError(
      `Ya existe un cupón con el código ${input.code}. Usa otro código.`,
      409,
    );
  }

  return Coupon.create(input);
}

export async function updateCoupon(
  id: number,
  input: CouponUpdateInput,
): Promise<Coupon> {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(
      "Ese cupón ya no existe. Recarga la página para ver la lista actualizada.",
      404,
    );
  }

  // Los refines cruzados de `couponUpdateSchema` solo pueden comparar lo que viene en el body, así
  // que un `PUT` que manda solo `maxDiscount` sobre un cupón `fixed` pasaría el schema. Aquí se
  // valida contra el estado combinado (lo guardado + lo que cambia), que es el real.
  const merged = {
    type: input.type ?? coupon.type,
    value: input.value ?? coupon.value,
    maxDiscount: input.maxDiscount ?? coupon.maxDiscount,
    startsAt: input.startsAt ?? coupon.startsAt,
    expiresAt: input.expiresAt ?? coupon.expiresAt,
  };
  if (merged.type === "percent" && merged.value > 100) {
    throw new AppError("Un cupón de porcentaje no puede pasar de 100.", 400);
  }
  if (merged.type === "fixed" && merged.maxDiscount != null) {
    throw new AppError("El tope en pesos solo aplica a los cupones de porcentaje.", 400);
  }
  if (merged.startsAt && merged.expiresAt && merged.startsAt >= merged.expiresAt) {
    throw new AppError("La fecha de fin debe ser posterior a la de inicio.", 400);
  }

  // Bajar `maxRedemptions` por debajo de `redeemedCount` se permite a propósito y NO se valida:
  // es justo el edit que hace un dueño para detener una promoción en caliente. El tope del canje
  // (`redeemedCount < maxRedemptions`) simplemente deja de cumplirse y nada queda negativo.
  await coupon.update(input);
  return coupon;
}

/**
 * Borrado admin, con el criterio de `adminDeleteProduct`: si el cupón ya tiene historia se
 * **desactiva** (queda para consultar el pedido viejo), y solo se borra de verdad si nunca se usó.
 *
 * Se cuentan **pedidos y no canjes**: un canje liberado sigue siendo historia, y una fila de canje
 * puede desaparecer por cascada mientras el pedido no. El pedido es la verdad histórica.
 */
export async function deleteCoupon(
  id: number,
): Promise<{ ok: true; deactivated: boolean }> {
  const coupon = await Coupon.findByPk(id);
  if (!coupon) {
    throw new AppError(
      "Ese cupón ya no existe. Recarga la página para ver la lista actualizada.",
      404,
    );
  }

  const referenced = await Order.count({ where: { couponId: id } });
  if (referenced > 0) {
    await coupon.update({ active: false });
    return { ok: true, deactivated: true };
  }

  await sequelize.transaction(async (t) => {
    await CouponRedemption.destroy({ where: { couponId: id }, transaction: t });
    await coupon.destroy({ transaction: t });
  });
  return { ok: true, deactivated: false };
}
