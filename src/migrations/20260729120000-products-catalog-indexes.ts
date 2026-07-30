import { QueryInterface, Op } from "sequelize";

/**
 * Índices para los filtros del catálogo público (Fase N.1): `?categoria=` sobre `type` y
 * `?precioMin=`/`?precioMax=`/`?orden=precio_*` sobre `salePrice`.
 *
 * Hasta aquí `products` no tenía NINGÚN índice fuera de la PK y `products_code_unique`, así que
 * cada listado era un seq scan. Con el catálogo creciendo en lotes de hasta 500 filas por
 * archivo de importación, ese barrido se paga en cada página de la tienda.
 *
 * Los dos son **parciales** con el predicado que llevan TODAS las consultas públicas
 * (`visible = true AND "deletedAt" IS NULL`): los productos ocultos o dados de baja no los mira
 * ninguna de esas consultas, así que mantenerlos en el índice solo lo engorda. El precedente es
 * `products_code_unique`, que también es parcial y también está declarado en `Product.init()` —
 * obligatorio, porque `tests/setup/db.ts` arma el esquema con `sync({ force: true })` y no con
 * migraciones.
 *
 * NO se crea aquí el índice `pg_trgm` sobre `name` que el roadmap deja como condicional: un GIN
 * `gin_trgm_ops` no se puede expresar en `Model.init()`, así que existiría en producción pero no
 * en el esquema de pruebas. Se difiere hasta medir la búsqueda con catálogo real.
 */
const VISIBLE_Y_NO_BORRADO = {
  [Op.and]: [{ visible: true }, { deletedAt: { [Op.is]: null } }],
};

export async function up(queryInterface: QueryInterface) {
  await queryInterface.addIndex("products", ["type"], {
    name: "products_type_visible",
    where: VISIBLE_Y_NO_BORRADO,
  });

  // Lleva `id` a propósito: el listado ordena por ("salePrice", "id") —el desempate por id es
  // lo que hace determinista la paginación cuando varios productos comparten precio, cosa
  // habitual en lotes importados— y un índice de una sola columna no puede satisfacer ese
  // ORDER BY completo: obligaría a un sort incremental, que es justo lo que se viene a evitar.
  await queryInterface.addIndex("products", ["salePrice", "id"], {
    name: "products_sale_price_visible",
    where: VISIBLE_Y_NO_BORRADO,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("products", "products_sale_price_visible");
  await queryInterface.removeIndex("products", "products_type_visible");
}
