import { QueryInterface, DataTypes } from "sequelize";

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("orders", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    status: {
      type: DataTypes.ENUM("pending", "paid", "shipped", "delivered", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    savings: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    shipping: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
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
    skydropxShipmentId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    trackingNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    trackingUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    labelUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    shipmentStatus: {
      type: DataTypes.STRING,
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
  await queryInterface.dropTable("orders");
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_orders_status";`);
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_orders_paymentStatus";`);
}
