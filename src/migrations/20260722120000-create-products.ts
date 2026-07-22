import { QueryInterface, DataTypes } from "sequelize";

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("products", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    originalPrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    salePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    unitCost: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("bota", "sombrero", "ropa"),
      allowNull: false,
    },
    images: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    weightKg: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    lengthCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    widthCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    heightCm: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    visible: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
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
  await queryInterface.dropTable("products");
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_products_type";`);
}
