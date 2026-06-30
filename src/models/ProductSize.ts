import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface ProductSizeAttributes {
  id: number;
  productId: number;
  size: number;
  stock: number;
}

interface ProductSizeCreationAttributes extends Optional<
  ProductSizeAttributes,
  "id"
> {}

export class ProductSize
  extends Model<ProductSizeAttributes, ProductSizeCreationAttributes>
  implements ProductSizeAttributes
{
  declare id: number;
  declare productId: number;
  declare size: number;
  declare stock: number;
}

ProductSize.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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
  },
  {
    sequelize,
    tableName: "product_sizes",
    timestamps: true,
    indexes: [{ unique: true, fields: ["productId", "size"] }],
  },
);
