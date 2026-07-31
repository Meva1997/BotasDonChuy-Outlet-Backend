import { QueryInterface, DataTypes, Op } from "sequelize";

/**
 * Cupones de descuento (Fase N.2): las dos tablas nuevas.
 *
 * `coupons` es la definición de la promoción y `coupon_redemptions` la bitácora de canjes. Esa
 * segunda tabla no es opcional ni "para reportes": su **índice único parcial** es todo el
 * mecanismo que hace cumplir el "un solo uso por cliente". La alternativa —un `SELECT` +
 * `if` en el servicio— dejaría que dos checkouts simultáneos leyeran "esta persona no ha
 * canjeado" y ambos escribieran; aquí la carrera la decide Postgres.
 *
 * Los tres índices se declaran además en `Model.init()` (`Coupon.ts`/`CouponRedemption.ts`)
 * porque `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones.
 */

/** Un canje cuenta como vigente mientras no se haya liberado, y solo bloquea si se escribió
 *  cuando el cupón tenía `oncePerCustomer` encendido (ver el comentario de `enforced`). */
const ACTIVE_ENFORCED_REDEMPTION = {
  [Op.and]: [{ releasedAt: { [Op.is]: null } }, { enforced: true }],
};

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("coupons", {
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
    },
    maxDiscount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    minSubtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  });

  await queryInterface.addIndex("coupons", ["code"], {
    unique: true,
    name: "coupons_code_unique",
  });

  await queryInterface.createTable("coupon_redemptions", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    couponId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "coupons",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "orders",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  });

  await queryInterface.addIndex("coupon_redemptions", ["couponId", "emailNormalized"], {
    unique: true,
    name: "coupon_redemptions_active_email_unique",
    where: ACTIVE_ENFORCED_REDEMPTION,
  });

  await queryInterface.addIndex("coupon_redemptions", ["orderId"], {
    unique: true,
    name: "coupon_redemptions_order_unique",
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex(
    "coupon_redemptions",
    "coupon_redemptions_order_unique",
  );
  await queryInterface.removeIndex(
    "coupon_redemptions",
    "coupon_redemptions_active_email_unique",
  );
  await queryInterface.dropTable("coupon_redemptions");

  await queryInterface.removeIndex("coupons", "coupons_code_unique");
  await queryInterface.dropTable("coupons");
  // `dropTable` NO borra el tipo ENUM que `DataTypes.ENUM` creó implícitamente
  // (`enum_<tabla>_<columna>`): sin esto, un `migrate` posterior falla con "type already exists".
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_coupons_type";`);
}
