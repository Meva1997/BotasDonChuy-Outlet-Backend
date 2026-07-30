import { DataTypes, Model, Op, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface CouponRedemptionAttributes {
  id: number;
  couponId: number;
  orderId: number;
  /** El correo tal como lo capturó el comprador — bitácora, para que el dueño vea a quién le
   *  aplicó el cupón sin joinear `orders`. */
  email: string;
  /** El mismo correo pasado por `normalizeEmailIdentity`. Es la mitad de la llave del índice
   *  único parcial, o sea la identidad real de "una persona". */
  emailNormalized: string;
  /**
   * `true` cuando el cupón tenía `oncePerCustomer` encendido AL MOMENTO del canje.
   *
   * Existe por un caso que no es obvio: **el índice parcial no puede consultar el flag del
   * cupón**. Si el dueño apaga `oncePerCustomer` en un cupón vivo, las filas ya escritas
   * seguirían bloqueando esos correos para siempre — el flag nuevo no relajaría nada. Con esta
   * columna dentro del predicado del índice, solo los canjes hechos mientras el flag estaba
   * encendido participan en la restricción.
   *
   * Se escribe fila para **todo** canje (encendido o no), por dos razones: es la bitácora
   * (quién, cuándo, cuánto, desde qué IP) y `releaseCouponForOrder` se apoya en su existencia
   * para saber de qué cupón decrementar el contador.
   */
  enforced: boolean;
  /** Descuento realmente otorgado. Deja medir el costo de una promoción sin joinear `orders`. */
  discount: number;
  /** **Forense y nada más.** Ninguna decisión la consulta — ver el porqué largo en
   *  `utils/emailIdentity.ts`. Sirve para que el dueño detecte un patrón raro a mano.
   *  45 caracteres: cabe una IPv6 completa con notación IPv4 embebida. */
  ip: string | null;
  /** Cuándo se devolvió el uso (pedido cancelado o abandonado). Mientras sea `null` la fila
   *  cuenta como canje vigente, y es el otro término del predicado del índice: liberar un uso
   *  permite que la misma persona vuelva a usar el cupón. */
  releasedAt: Date | null;
}

interface CouponRedemptionCreationAttributes extends Optional<
  CouponRedemptionAttributes,
  "id" | "enforced" | "ip" | "releasedAt"
> {}

export class CouponRedemption
  extends Model<CouponRedemptionAttributes, CouponRedemptionCreationAttributes>
  implements CouponRedemptionAttributes
{
  declare id: number;
  declare couponId: number;
  declare orderId: number;
  declare email: string;
  declare emailNormalized: string;
  declare enforced: boolean;
  declare discount: number;
  declare ip: string | null;
  declare releasedAt: Date | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

CouponRedemption.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    couponId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    emailNormalized: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    enforced: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    discount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("discount");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
      defaultValue: null,
    },
    releasedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "coupon_redemptions",
    timestamps: true,
    // Los dos índices se declaran aquí ADEMÁS de en su migración (Fase N.2) porque
    // `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones —
    // y aquí no es un detalle: el primero **es** toda la garantía de "un uso por persona".
    // Sin él en la BD de test, la suite de la carrera concurrente pasaría en verde con dos
    // canjes escritos. Mismo motivo que los índices parciales de `Product`.
    indexes: [
      {
        // El "un uso por cliente": lo decide Postgres, no un `SELECT` + `if` (que dejaría que
        // dos checkouts simultáneos leyeran "no ha canjeado" y ambos escribieran). Parcial en
        // `releasedAt IS NULL` para que devolver un uso lo vuelva a habilitar, y en
        // `enforced` para que un cupón al que se le apagó `oncePerCustomer` deje de bloquear.
        unique: true,
        name: "coupon_redemptions_active_email_unique",
        fields: ["couponId", "emailNormalized"],
        where: {
          [Op.and]: [{ releasedAt: { [Op.is]: null } }, { enforced: true }],
        },
      },
      {
        // Un pedido no puede canjear dos cupones (la regla "uno por compra"), y de paso hace
        // que la liberación encuentre su fila en una sola consulta por `orderId`.
        unique: true,
        name: "coupon_redemptions_order_unique",
        fields: ["orderId"],
      },
    ],
  },
);
