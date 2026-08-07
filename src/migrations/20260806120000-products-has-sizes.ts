import { QueryInterface, DataTypes } from "sequelize";

/**
 * `products.hasSizes`: distingue mercancía que se vende por talla (botas, sombreros — el
 * comportamiento de siempre) de mercancía con una sola existencia manual, sin tallas (un
 * corbatín, una hebilla de cinturón). `true` por default para no alterar ningún producto
 * existente. Cuando es `false`, el producto usa una única fila de `ProductSize` con
 * `size: NO_SIZE_SENTINEL` (0) cuyo `stock` es la cantidad capturada a mano — ver
 * `src/utils/noSizeSentinel.ts`. No requiere backfill: todo producto ya guardado sigue
 * manejando tallas como hasta ahora.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("products", "hasSizes", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("products", "hasSizes");
}
