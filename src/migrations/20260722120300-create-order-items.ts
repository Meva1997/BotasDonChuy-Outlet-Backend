import { QueryInterface, DataTypes } from "sequelize";

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("order_items", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "orders",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "products",
        key: "id",
      },
      onUpdate: "CASCADE",
    },
    nameSnapshot: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    unitOriginalPrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    unitSalePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    unitCost: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
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
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.dropTable("order_items");
}
