import { QueryInterface, DataTypes } from "sequelize";

/**
 * Registro de disputas / contracargos (Fase 28): `orders.disputeStatus`,
 * `orders.disputeReason`, `orders.disputedAt` y `orders.disputeAmount`.
 *
 * Hasta esta fase el webhook de Stripe solo manejaba tres eventos de `payment_intent`, así que un
 * `charge.dispute.created` caía en el `default: break` del switch y **nadie se enteraba**. El
 * pedido seguía diciendo `paid`, seguía en la pestaña "Pendientes de enviar" y salía impreso en la
 * hoja de empaque como cualquier otro — o sea, la mercancía se podía mandar con el dinero ya
 * retirado del saldo (Stripe se lleva el importe más la comisión de disputa, que no se devuelve ni
 * ganando el caso).
 *
 * **Columnas propias y NO un valor nuevo en el enum `paymentStatus`.** Una disputa no reemplaza al
 * pago: el cargo *fue* cobrado, y si la disputa se gana el dinero vuelve. Meter `"disputed"` en el
 * enum obligaría a decidir a qué estado "regresar" al cerrarse —¿`paid`? ¿`refunded`? un
 * contracargo perdido no es un reembolso— y borraría el hecho de que se pagó. Es el mismo criterio
 * que ya mantiene `status` y `paymentStatus` como ejes independientes.
 *
 * Qué guarda cada columna:
 * - `disputeStatus`: el estado **crudo** de Stripe (`needs_response`, `under_review`, `won`,
 *   `lost`, `warning_*`), igual que `shipmentStatus` guarda el crudo de Skydropx. Un enum de
 *   Postgres convertiría cada estado nuevo de Stripe en una migración; la clasificación vive en
 *   `components/admin/orders/disputeStatus.ts` (front), que trata como "abierta" cualquier cosa
 *   que no reconozca.
 * - `disputeReason`: el motivo crudo (`fraudulent`, `product_not_received`, `duplicate`, …).
 * - `disputedAt`: la PRIMERA vez que se supo de la disputa. No se pisa en eventos posteriores —
 *   `updated`/`closed` mueven el estado, no la fecha en que empezó el problema.
 * - `disputeAmount`: el importe disputado, que puede ser PARCIAL (por eso no basta con leer
 *   `total`). Mismo `DECIMAL(10,2)` y mismo getter `parseFloat` que el resto del dinero del
 *   pedido: Stripe lo manda en centavos y el servicio lo divide entre 100 al guardar, para que la
 *   columna hable la misma unidad que `total`/`subtotal`.
 *
 * **Nullable y sin backfill**: `null` significa "este pedido nunca tuvo disputa", que es la verdad
 * para todo lo anterior a esta fase y para la enorme mayoría de lo que venga.
 *
 * **Sin índice**: nadie filtra ni pagina por estos campos. La hoja de empaque los lee sobre los
 * pedidos que ya trajo (`disputeBlocksShipping`), y el modal los lee de un pedido concreto.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "disputeStatus", {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "disputeReason", {
    type: DataTypes.STRING(48),
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "disputedAt", {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "disputeAmount", {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    defaultValue: null,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("orders", "disputeAmount");
  await queryInterface.removeColumn("orders", "disputedAt");
  await queryInterface.removeColumn("orders", "disputeReason");
  await queryInterface.removeColumn("orders", "disputeStatus");
}
