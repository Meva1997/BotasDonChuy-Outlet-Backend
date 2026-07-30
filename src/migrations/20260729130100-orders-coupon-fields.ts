import { QueryInterface, DataTypes } from "sequelize";

/**
 * Congelado del cupón en la orden (Fase N.2), gemela de `20260729130000-create-coupons.ts`.
 *
 * `couponCode` y `couponDiscount` son un **snapshot**, igual que los precios del `OrderItem`: un
 * cupón editado, agotado o desactivado después de la compra no debe alterar el histórico. Por eso
 * se guarda el texto del código y no solo la FK.
 *
 * `couponDiscount` es `NOT NULL DEFAULT 0` y no nullable: así las filas anteriores al deploy
 * quedan en `0` (sin un `UPDATE` masivo aparte) y todo consumidor que hace aritmética
 * —`dashboard.service.ts`, la plantilla del correo, la proyección pública— se ahorra el `?? 0`.
 * El invariante que introduce, y que hay que respetar en front y back:
 *
 *     total = subtotal − savings − couponDiscount + shipping
 *
 * `couponDiscount` va en columna aparte de `savings` a propósito: `savings` es el ahorro outlet
 * (`originalPrice` vs `salePrice`) y sumar el cupón ahí falsearía el margen del dashboard.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "couponId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  });

  await queryInterface.addColumn("orders", "couponCode", {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: null,
  });

  await queryInterface.addColumn("orders", "couponDiscount", {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  });

  // `RESTRICT` y no `SET NULL` ni `CASCADE`: es el cinturón detrás del pre-chequeo de
  // `DELETE /api/admin/coupons/:id` (que desactiva en vez de borrar cuando ya hay pedidos). Con
  // `RESTRICT`, ni un `DELETE` a mano desde psql puede dejar un pedido apuntando a un cupón que
  // ya no existe; `SET NULL` habría borrado en silencio la trazabilidad de una venta con
  // descuento, y `CASCADE` habría borrado el pedido entero.
  await queryInterface.addConstraint("orders", {
    fields: ["couponId"],
    type: "foreign key",
    name: "orders_coupon_id_fkey",
    references: { table: "coupons", field: "id" },
    onDelete: "RESTRICT",
    onUpdate: "CASCADE",
  });

  // Sirve al `Order.count({ where: { couponId } })` con el que el borrado admin decide entre
  // desactivar y borrar, y a cualquier reporte por cupón.
  await queryInterface.addIndex("orders", ["couponId"], { name: "orders_coupon_id" });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("orders", "orders_coupon_id");
  await queryInterface.removeConstraint("orders", "orders_coupon_id_fkey");
  await queryInterface.removeColumn("orders", "couponDiscount");
  await queryInterface.removeColumn("orders", "couponCode");
  await queryInterface.removeColumn("orders", "couponId");
}
