import { QueryInterface, Op } from "sequelize";

/**
 * Índices de las consultas calientes de `orders` (punto 11 de docs/PRE-PRODUCCION.md).
 *
 * Hasta aquí la tabla solo tenía `orders_public_token_unique` y la FK de `couponId`, así que
 * **cada evento de webhook y cada carga del panel hacía un scan completo**. Con el volumen del
 * primer mes no se nota; se nota cuando la tabla crece, y el primero que sufre es el webhook de
 * Stripe, que tiene *timeout* y reintenta si no contestamos a tiempo.
 *
 * No cambian ningún comportamiento: ninguna consulta se reescribe, solo dejan de ser scans.
 *
 * Los dos primeros son **parciales** (`IS NOT NULL`) porque la única forma en que se consultan
 * esas columnas es por valor exacto —nunca `WHERE ... IS NULL`—, y una buena parte de las filas
 * las tiene en `null` (un pedido que cayó a la tarifa plana no tiene guía; uno recién creado no
 * tiene PaymentIntent): fuera del índice, esas filas no lo engordan.
 *
 * Los dos últimos son **compuestos con `createdAt`** aunque el hallazgo hablara de `status` a
 * secas: los cuatro llamadores combinan siempre el estado con un rango de fechas y ordenan por
 * `createdAt`, así que un índice de una sola columna dejaría fuera tanto el filtro de fecha como
 * el `ORDER BY`.
 *
 * Se declaran TAMBIÉN en el array `indexes:` de `Order.init()` porque `tests/setup/db.ts` arma
 * el esquema con `sync({ force: true })` y no con migraciones — mismo motivo ya comentado ahí
 * para `orders_public_token_unique` y en `Product.ts` para los del catálogo.
 */
export async function up(queryInterface: QueryInterface) {
  // Lo busca `payment.service.ts` en CADA evento del webhook de Stripe (pago, fallo, cancelación)
  // y en cada evento de disputa de la Fase 28.
  await queryInterface.addIndex("orders", ["paymentIntentId"], {
    name: "orders_payment_intent_id",
    where: { paymentIntentId: { [Op.ne]: null } },
  });

  // Lo busca el webhook de Skydropx en cada evento de `packages`, y la reconciliación de la
  // Fase O.3 por el valor especial `unreconciled:<id real>`.
  await queryInterface.addIndex("orders", ["skydropxShipmentId"], {
    name: "orders_skydropx_shipment_id",
    where: { skydropxShipmentId: { [Op.ne]: null } },
  });

  // Dashboard y reportes: `paymentStatus: "paid"` sobre una ventana de 180 días ordenada por
  // fecha, más el `recentSales` (mismo filtro, `ORDER BY createdAt DESC` con `limit`).
  await queryInterface.addIndex("orders", ["paymentStatus", "createdAt"], {
    name: "orders_payment_status_created_at",
  });

  // `pendingOrderSweeper` (`status: "pending"` + `createdAt < cutoff`) y `pendingShipmentWhere`
  // (`status: "paid"` + `createdAt BETWEEN` + `ORDER BY createdAt ASC`).
  await queryInterface.addIndex("orders", ["status", "createdAt"], {
    name: "orders_status_created_at",
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("orders", "orders_status_created_at");
  await queryInterface.removeIndex("orders", "orders_payment_status_created_at");
  await queryInterface.removeIndex("orders", "orders_skydropx_shipment_id");
  await queryInterface.removeIndex("orders", "orders_payment_intent_id");
}
