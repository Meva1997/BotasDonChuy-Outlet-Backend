import { QueryInterface, DataTypes } from "sequelize";

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("product_sizes", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "products",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  });

  await queryInterface.addIndex("product_sizes", ["productId", "size"], {
    unique: true,
    name: "product_sizes_product_id_size_unique",
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex("product_sizes", "product_sizes_product_id_size_unique");
  await queryInterface.dropTable("product_sizes");
}
