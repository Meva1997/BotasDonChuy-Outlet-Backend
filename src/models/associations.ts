import { Product } from "./Product";
import { ProductSize } from "./ProductSize";
import { Order } from "./Order";
import { OrderItem } from "./OrderItem";

Product.hasMany(ProductSize, {
  as: "productSizes",
  foreignKey: "productId",
  onDelete: "CASCADE",
});
ProductSize.belongsTo(Product, { foreignKey: "productId" });

Order.hasMany(OrderItem, {
  as: "items",
  foreignKey: "orderId",
  onDelete: "CASCADE",
});
OrderItem.belongsTo(Order, { foreignKey: "orderId" });

OrderItem.belongsTo(Product, { foreignKey: "productId" });
Product.hasMany(OrderItem, { foreignKey: "productId" });
