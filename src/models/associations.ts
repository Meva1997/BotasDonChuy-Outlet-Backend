import { Product } from "./Product";
import { ProductSize } from "./ProductSize";
import { Order } from "./Order";
import { OrderItem } from "./OrderItem";
import { Coupon } from "./Coupon";
import { CouponRedemption } from "./CouponRedemption";

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

// Cupones (Fase N.2). `coupon_redemptions` es la bitácora de canjes y, con su índice único
// parcial, el mecanismo que hace cumplir el "un uso por cliente".
Coupon.hasMany(CouponRedemption, {
  as: "redemptions",
  foreignKey: "couponId",
  onDelete: "CASCADE",
});
CouponRedemption.belongsTo(Coupon, { foreignKey: "couponId" });

// `CASCADE` desde la orden es consistente con `order_items`, con una consecuencia asumida: un
// `DELETE FROM orders` a mano borraría la fila de canje sin pasar por `releaseCouponForOrder`,
// dejando `redeemedCount` inflado para siempre. Ningún camino del código borra pedidos (cancelar
// solo cambia `status`), así que se prefiere permitir la limpieza manual y hacer la divergencia
// VISIBLE: el listado admin devuelve `activeRedemptions` (conteo vivo) junto al contador.
CouponRedemption.belongsTo(Order, { foreignKey: "orderId" });
Order.hasOne(CouponRedemption, {
  as: "couponRedemption",
  foreignKey: "orderId",
  onDelete: "CASCADE",
});

// En sentido contrario va con `RESTRICT` (en la migración): un cupón con pedidos NO se puede
// borrar, así que `orders.couponId` nunca queda apuntando a nada. Nada en runtime lee esta
// asociación —el `couponCode` congelado es lo que se muestra—, se declara para que
// `sync({ force: true })` cree la FK en la BD de test igual que la crea la migración en prod.
Order.belongsTo(Coupon, { as: "coupon", foreignKey: "couponId" });
