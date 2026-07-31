import { QueryInterface, DataTypes } from "sequelize";

/**
 * `orders.shipmentClaimedAt` (Fase O.3): momento en que `createShipmentForOrder` reclamó el
 * centinela `skydropxShipmentId = 'creating'` antes de llamar a Skydropx.
 *
 * Hasta ahora la antigüedad del centinela se medía con `updatedAt`, que Sequelize bumpea en
 * CUALQUIER escritura sobre el pedido (webhook de envío, avance manual de estado, marcado de
 * pago). Un pedido realmente atorado en `"creating"` reiniciaba su reloj cada vez que el dueño lo
 * tocaba desde el panel, así que ni el reintento manual ni el barrido podían liberarlo nunca.
 *
 * Se puebla al reclamar y se limpia al liberar/terminar, así que las filas existentes quedan en
 * `null` sin backfill: una fila con `"creating"` heredada de antes de esta migración se trata como
 * huérfana de inmediato (`shipmentClaimedAt IS NULL`), que es justo lo que se quiere — lleva ahí
 * al menos desde el deploy.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "shipmentClaimedAt", {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("orders", "shipmentClaimedAt");
}
