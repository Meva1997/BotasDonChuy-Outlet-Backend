import { QueryInterface, Op } from "sequelize";

/**
 * `code` (SKU) es nullable y muchas líneas de producto (p. ej. `ropa`) legítimamente no lo usan,
 * así que un índice único plano rompería con filas en blanco. Un índice único parcial permite
 * duplicar/omitir `code` en blanco pero garantiza unicidad quando sí se define — necesario para
 * que el importador masivo (POST /api/admin/products/import) pueda emparejar filas del Excel por
 * `code` de forma confiable.
 */
const CODE_NOT_BLANK = {
  [Op.and]: [{ code: { [Op.ne]: null } }, { code: { [Op.ne]: "" } }],
};

export async function up(queryInterface: QueryInterface) {
  await queryInterface.addIndex("products", ["code"], {
    unique: true,
    name: "products_code_unique",
    where: CODE_NOT_BLANK,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("products", "products_code_unique");
}
