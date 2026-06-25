import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface OrderItemAttributes {
  id: number;
  orderId: number;
  productId: number;
  nameSnapshot: string;
  size: number;
  quantity: number;
  unitOriginalPrice: number;
  unitSalePrice: number;
  unitCost: number;
}

interface OrderItemCreationAttributes extends Optional<
  OrderItemAttributes,
  "id"
> {}

export class OrderItem
  extends Model<OrderItemAttributes, OrderItemCreationAttributes>
  implements OrderItemAttributes
{
  declare id: number;
  declare orderId: number;
  declare productId: number;
  declare nameSnapshot: string;
  declare size: number;
  declare quantity: number;
  declare unitOriginalPrice: number;
  declare unitSalePrice: number;
  declare unitCost: number;
}

OrderItem.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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
      get() {
        const value = this.getDataValue("unitOriginalPrice");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    unitSalePrice: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("unitSalePrice");
        return value === null ? null : parseFloat(value as unknown as string);
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
  },
  {
    sequelize,
    tableName: "order_items",
    timestamps: true,
  },
);
