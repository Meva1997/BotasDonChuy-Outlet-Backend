import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

export interface OrderAttributes {
  id: number;
  status: "pending" | "paid" | "shipped" | "delivered" | "cancelled";
  subtotal: number;
  savings: number;
  shipping: number;
  total: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  references: string;
  shippingCarrier: string;
}

interface OrderCreationAttributes extends Optional<
  OrderAttributes,
  "id" | "references" | "shippingCarrier"
> {}

export class Order
  extends Model<OrderAttributes, OrderCreationAttributes>
  implements OrderAttributes
{
  declare id: number;
  declare status: "pending" | "paid" | "shipped" | "delivered" | "cancelled";
  declare subtotal: number;
  declare savings: number;
  declare shipping: number;
  declare total: number;
  declare customerName: string;
  declare customerEmail: string;
  declare customerPhone: string;
  declare street: string;
  declare neighborhood: string;
  declare city: string;
  declare state: string;
  declare postalCode: string;
  declare references: string;
  declare shippingCarrier: string;
}

Order.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    status: {
      type: DataTypes.ENUM(
        "pending",
        "paid",
        "shipped",
        "delivered",
        "cancelled",
      ),
      defaultValue: "pending",
      allowNull: false,
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("subtotal");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    savings: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("savings");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    shipping: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("shipping");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("total");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    customerName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerPhone: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    street: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    neighborhood: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    state: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    postalCode: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    references: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    shippingCarrier: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "orders",
    timestamps: true,
  },
);
