import { QueryInterface, DataTypes } from "sequelize";

/**
 * `orders.packageCount` (Fase N.6): cuántos bultos ampara el envío que se cotizó y cobró.
 *
 * Hasta esta fase el pedido entero se cotizaba como un solo bulto apilado y la guía declaraba
 * siempre `packages: [1]`, así que no había nada que guardar. Ahora `packOrder` acomoda el
 * carrito en cajas reales y el número de cajas es un dato del **momento del checkout** que hay
 * que congelar: `createShipmentForOrder` corre minutos después, en otro proceso, y para entonces
 * el acomodo ya no se puede reconstruir — las dimensiones del catálogo pudieron cambiar y
 * `GET /quotations/{id}` no devuelve los `parcels` con los que se cotizó.
 *
 * Nullable y sin backfill: `null` significa "pedido con tarifa plana de respaldo (sin cotización
 * de Skydropx) o anterior a esta columna", y `createShipmentForOrder` lo lee como 1 — que es
 * exactamente lo que esos pedidos declararon cuando se crearon.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "packageCount", {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("orders", "packageCount");
}
