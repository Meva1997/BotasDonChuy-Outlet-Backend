import { QueryInterface, DataTypes } from "sequelize";

/**
 * Cancelación/reembolso manual de órdenes (Fase H.5). Agrega:
 *  - el valor `refunded` al enum `paymentStatus` (un pago exitoso que luego se
 *    reembolsa NO es lo mismo que uno fallido), y
 *  - las columnas de auditoría `refundId`/`refundedAt` (rastro del reembolso Stripe).
 * Ver `POST /api/admin/orders/:id/cancel` en `orders.service.ts`.
 */
export async function up(queryInterface: QueryInterface) {
  // `ALTER TYPE ... ADD VALUE` no puede correr dentro de una transacción; se ejecuta
  // como query suelto (sequelize-cli no envuelve las migraciones en una por defecto).
  await queryInterface.sequelize.query(
    `ALTER TYPE "enum_orders_paymentStatus" ADD VALUE IF NOT EXISTS 'refunded';`,
  );

  await queryInterface.addColumn("orders", "refundId", {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "refundedAt", {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("orders", "refundedAt");
  await queryInterface.removeColumn("orders", "refundId");

  // Postgres no tiene `DROP VALUE`: para quitar `refunded` del enum hay que recrear
  // el tipo sin él y re-apuntar la columna. (Cualquier fila en `refunded` bloquearía
  // el cast — al revertir en dev no debería existir ninguna.) El `DEFAULT 'unpaid'` de
  // la columna se apoya en el tipo viejo, así que hay que quitarlo antes del swap y
  // volver a ponerlo después, o el `ALTER COLUMN TYPE` falla ("default ... cannot be
  // cast automatically").
  await queryInterface.sequelize.query(
    `ALTER TABLE "orders" ALTER COLUMN "paymentStatus" DROP DEFAULT;`,
  );
  await queryInterface.sequelize.query(
    `ALTER TYPE "enum_orders_paymentStatus" RENAME TO "enum_orders_paymentStatus_old";`,
  );
  await queryInterface.sequelize.query(
    `CREATE TYPE "enum_orders_paymentStatus" AS ENUM('unpaid', 'processing', 'paid', 'failed');`,
  );
  await queryInterface.sequelize.query(
    `ALTER TABLE "orders" ALTER COLUMN "paymentStatus" TYPE "enum_orders_paymentStatus" USING "paymentStatus"::text::"enum_orders_paymentStatus";`,
  );
  await queryInterface.sequelize.query(
    `ALTER TABLE "orders" ALTER COLUMN "paymentStatus" SET DEFAULT 'unpaid';`,
  );
  await queryInterface.sequelize.query(
    `DROP TYPE "enum_orders_paymentStatus_old";`,
  );
}
