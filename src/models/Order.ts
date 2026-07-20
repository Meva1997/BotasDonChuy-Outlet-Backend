import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";
import type { OrderItem } from "./OrderItem";

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
  // Seam de pagos (Stripe llega en Fase 8). Nullable hoy: la orden nace en
  // status "pending" / paymentStatus "unpaid" y el PaymentIntent aún no existe.
  paymentIntentId: string | null;
  paymentStatus: "unpaid" | "processing" | "paid" | "failed";
  // Envío en vivo con Skydropx (Fase 8.4). Nullable: una orden creada por el
  // fallback de tarifa plana (Skydropx no disponible al cotizar) no tiene
  // cotización asociada. Cuando existen, `skydropxQuotationId` permite re-consultar
  // el `total` autoritativo y `skydropxRateId` identifica el rate elegido — la base
  // para generar la guía al pagar (Fase 8.5).
  skydropxQuotationId: string | null;
  skydropxRateId: string | null;
  // Bandera operativa SOLO para el dueño (Fase 8.4+): `true` = la paquetería
  // elegida NO recoge a domicilio, hay que llevar el paquete a su sucursal.
  // Nullable/`null` cuando no aplica: órdenes con tarifa plana de respaldo (sin
  // cotización Skydropx) u órdenes previas a esta columna. Se excluye de la
  // respuesta pública de checkout — el cliente no la ve (ver orders.service.ts).
  shippingRequiresDropoff: boolean | null;
}

interface OrderCreationAttributes extends Optional<
  OrderAttributes,
  | "id"
  | "references"
  | "shippingCarrier"
  | "paymentIntentId"
  | "paymentStatus"
  | "skydropxQuotationId"
  | "skydropxRateId"
  | "shippingRequiresDropoff"
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
  declare paymentIntentId: string | null;
  declare paymentStatus: "unpaid" | "processing" | "paid" | "failed";
  declare skydropxQuotationId: string | null;
  declare skydropxRateId: string | null;
  declare shippingRequiresDropoff: boolean | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
  declare items?: OrderItem[];
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
    paymentIntentId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    paymentStatus: {
      type: DataTypes.ENUM("unpaid", "processing", "paid", "failed"),
      allowNull: false,
      defaultValue: "unpaid",
    },
    skydropxQuotationId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    skydropxRateId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    shippingRequiresDropoff: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "orders",
    timestamps: true,
  },
);
