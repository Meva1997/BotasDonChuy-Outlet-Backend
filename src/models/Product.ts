import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface ProductAttributes {
  id: number;
  name: string;
  description?: string;
  originalPrice: number;
  salePrice: number;
  readonly discountPercent: number;
  unitCost: number;
  stock: number;
  type: "bota" | "sombrero" | "ropa";
  sizes: number[];
  imageSrc?: string;
  code?: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  visible: boolean;
}

interface ProductCreationAttributes extends Optional<
  ProductAttributes,
  "id" | "description" | "imageSrc" | "code" | "discountPercent"
> {}

export class Product
  extends Model<ProductAttributes, ProductCreationAttributes>
  implements ProductAttributes
{
  declare id: number;
  declare name: string;
  declare description?: string;
  declare originalPrice: number;
  declare salePrice: number;
  declare readonly discountPercent: number;
  declare unitCost: number;
  declare stock: number;
  declare type: "bota" | "sombrero" | "ropa";
  declare sizes: number[];
  declare imageSrc?: string;
  declare code?: string;
  declare weightKg: number;
  declare lengthCm: number;
  declare widthCm: number;
  declare heightCm: number;
  declare visible: boolean;
}

Product.init(
  {
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
      get() {
        const value = this.getDataValue("originalPrice");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    salePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("salePrice");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    discountPercent: {
      type: DataTypes.VIRTUAL,
      get() {
        const originalPrice = this.getDataValue("originalPrice") as unknown as number;
        const salePrice = this.getDataValue("salePrice") as unknown as number;
        if (!originalPrice) return 0;
        return Math.round(
          ((parseFloat(originalPrice as unknown as string) -
            parseFloat(salePrice as unknown as string)) /
            parseFloat(originalPrice as unknown as string)) *
            100,
        );
      },
    },
    unitCost: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("unitCost");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    type: {
      type: DataTypes.ENUM("bota", "sombrero", "ropa"),
      allowNull: false,
    },
    sizes: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: false,
      defaultValue: [],
    },
    imageSrc: {
      type: DataTypes.STRING,
      allowNull: true,
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
  },
  {
    sequelize,
    tableName: "products",
    timestamps: true,
  },
);
