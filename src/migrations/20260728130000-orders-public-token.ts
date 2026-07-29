import { QueryInterface, DataTypes } from "sequelize";

/**
 * `orders.publicToken` (Fase O.4): identificador **opaco** de la orden para la consulta pública
 * de estado (`GET /api/orders/lookup/:token`), que viaja como link en el correo de confirmación.
 *
 * Por qué un token y no `id + email`: los ids son secuenciales y un correo es adivinable, así que
 * ese par sería enumerable aunque se le ponga rate limit — cualquiera podría recorrer los pedidos
 * de la tienda. Un UUID aleatorio no se adivina, y como es la ÚNICA credencial de esa ruta, el
 * índice único es parte de la garantía (un token nunca puede resolver a dos pedidos).
 *
 * Nullable porque las filas ya existentes no lo tenían; se rellenan aquí mismo con
 * `gen_random_uuid()` (nativo desde Postgres 13, sin extensión) para que un pedido anterior al
 * deploy también sea consultable. El índice único se crea DESPUÉS del backfill: con varias filas
 * en `null` un índice único plano las toleraría, pero crearlo antes obligaría a que el UPDATE
 * masivo respetara la unicidad fila por fila sin necesidad.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "publicToken", {
    type: DataTypes.UUID,
    allowNull: true,
    defaultValue: null,
  });

  await queryInterface.sequelize.query(
    `UPDATE "orders" SET "publicToken" = gen_random_uuid() WHERE "publicToken" IS NULL;`,
  );

  await queryInterface.addIndex("orders", ["publicToken"], {
    unique: true,
    name: "orders_public_token_unique",
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("orders", "orders_public_token_unique");
  await queryInterface.removeColumn("orders", "publicToken");
}
