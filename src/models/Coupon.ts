import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface CouponAttributes {
  id: number;
  /** Alfanumérico en MAYÚSCULAS, con índice único. La normalización la hace
   *  `couponCodeSchema` (`schemas/checkout.ts`) antes de llegar aquí, así que el índice y la
   *  huella de idempotencia del checkout ven siempre el mismo valor. */
  code: string;
  type: "percent" | "fixed";
  /** Porcentaje (1–100) o pesos, según `type`. */
  value: number;
  /** Tope en pesos del descuento. Solo tiene sentido en `percent` (lo exige el schema): es lo
   *  que evita que un 50% sobre un carrito de $20,000 se lleve $10,000. */
  maxDiscount: number | null;
  /** Mínimo de mercancía **neta** (`subtotal − savings`) para que el cupón aplique. Neta y no
   *  `subtotal` a propósito: `subtotal` está a precio original, así que un mínimo comparado
   *  contra él se cumpliría con carritos que valen bastante menos. */
  minSubtotal: number | null;
  /** Tope global de canjes. `null` = ilimitado. Es la barrera DURA de esta fase: acota la
   *  pérdida máxima a `usos × descuento` sin importar quién canjee. */
  maxRedemptions: number | null;
  /** Estado derivado: solo lo mueven el canje atómico y la liberación (`coupon.service.ts`).
   *  No se acepta en ningún schema de entrada — un valor tecleado a mano lo desincroniza para
   *  siempre del decremento de la liberación. */
  redeemedCount: number;
  /** Un solo uso por cliente, identificado por el correo del pedido normalizado. Lo hace
   *  cumplir el índice único parcial de `coupon_redemptions`, no este flag: ver el comentario
   *  de `enforced` en `CouponRedemption.ts` para por qué apagarlo no libera lo ya canjeado. */
  oncePerCustomer: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  /** `false` es "cancelar el cupón": deja de canjearse sin borrar el histórico. */
  active: boolean;
  /** Nota para el dueño ("2x1 de agosto", "influencer tal") — el código solo no le recuerda
   *  qué era `VERANO25` tres meses después. */
  description: string | null;
}

interface CouponCreationAttributes extends Optional<
  CouponAttributes,
  | "id"
  | "maxDiscount"
  | "minSubtotal"
  | "maxRedemptions"
  | "redeemedCount"
  | "oncePerCustomer"
  | "startsAt"
  | "expiresAt"
  | "active"
  | "description"
> {}

export class Coupon
  extends Model<CouponAttributes, CouponCreationAttributes>
  implements CouponAttributes
{
  declare id: number;
  declare code: string;
  declare type: "percent" | "fixed";
  declare value: number;
  declare maxDiscount: number | null;
  declare minSubtotal: number | null;
  declare maxRedemptions: number | null;
  declare redeemedCount: number;
  declare oncePerCustomer: boolean;
  declare startsAt: Date | null;
  declare expiresAt: Date | null;
  declare active: boolean;
  declare description: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Coupon.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("percent", "fixed"),
      allowNull: false,
    },
    value: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("value");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    maxDiscount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
      get() {
        const value = this.getDataValue("maxDiscount");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    minSubtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
      get() {
        const value = this.getDataValue("minSubtotal");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    maxRedemptions: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    redeemedCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    oncePerCustomer: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    startsAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    description: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "coupons",
    timestamps: true,
    // El índice se declara aquí ADEMÁS de en su migración (Fase N.2) porque
    // `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones:
    // sin esto, dos cupones con el mismo código convivirían en la BD de test y el
    // emparejamiento por código dejaría de ser confiable. Mismo motivo que el índice de
    // `orders.publicToken`.
    indexes: [{ unique: true, fields: ["code"], name: "coupons_code_unique" }],
  },
);
