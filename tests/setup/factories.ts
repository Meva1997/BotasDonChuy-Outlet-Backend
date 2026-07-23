/**
 * Factories de datos de prueba (partes 2 en adelante). Cada helper crea una fila con
 * valores por defecto sensatos y acepta un `overrides` parcial para el caso que la
 * prueba necesita destacar (p. ej. un producto con stock 1 en una sola talla para el
 * test de descuento atómico concurrente).
 *
 * Requieren una BD de test activa (ver tests/setup/db.ts) — no son puros.
 */
import { Product } from "../../src/models/Product";
import { ProductSize } from "../../src/models/ProductSize";
import { AdminUser } from "../../src/models/AdminUser";
import { Order } from "../../src/models/Order";
import { OrderItem } from "../../src/models/OrderItem";
import { hashPassword } from "../../src/utils/password";

let emailCounter = 0;

interface ProductOverrides {
  name?: string;
  type?: "bota" | "sombrero" | "ropa";
  originalPrice?: number;
  salePrice?: number;
  unitCost?: number;
  visible?: boolean;
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  /** Stock por talla, p. ej. `{ 25: 3, 26: 1 }`. Crea las filas de ProductSize. */
  sizes?: Record<number, number>;
}

/** Crea un Product (bota por defecto) con sus tallas/stock en ProductSize. */
export async function createProduct(overrides: ProductOverrides = {}): Promise<Product> {
  const { sizes = { 25: 5, 26: 5 }, ...productAttrs } = overrides;
  const product = await Product.create({
    name: "Bota de prueba",
    type: "bota",
    originalPrice: 1000,
    salePrice: 800,
    unitCost: 400,
    visible: true,
    weightKg: 1.5,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 15,
    ...productAttrs,
  } as any);

  await Promise.all(
    Object.entries(sizes).map(([size, stock]) =>
      ProductSize.create({ productId: product.id, size: Number(size), stock })
    )
  );

  return product;
}

interface AdminUserOverrides {
  name?: string;
  email?: string;
  password?: string; // texto plano; se hashea con bcrypt
  role?: "owner" | "admin";
}

/**
 * Crea un AdminUser con contraseña real hasheada (bcrypt). Devuelve el usuario y la
 * contraseña en claro para que la prueba de login la pueda enviar.
 */
export async function createAdminUser(
  overrides: AdminUserOverrides = {}
): Promise<{ user: AdminUser; password: string }> {
  const password = overrides.password ?? "Password1!";
  const email = overrides.email ?? `admin${++emailCounter}@test.com`;
  const user = await AdminUser.create({
    name: overrides.name ?? "Admin de prueba",
    email,
    passwordHash: await hashPassword(password),
    role: overrides.role ?? "admin",
  } as any);
  return { user, password };
}

interface OrderOverrides {
  status?: "pending" | "paid" | "shipped" | "delivered" | "cancelled";
  subtotal?: number;
  savings?: number;
  shipping?: number;
  total?: number;
  paymentIntentId?: string | null;
  paymentStatus?: string;
  customerEmail?: string;
}

/** Crea una Order con totales y datos de cliente por defecto (status `pending`). */
export async function createOrder(overrides: OrderOverrides = {}): Promise<Order> {
  const subtotal = overrides.subtotal ?? 800;
  const savings = overrides.savings ?? 0;
  const shipping = overrides.shipping ?? 150;
  return Order.create({
    status: overrides.status ?? "pending",
    subtotal,
    savings,
    shipping,
    total: overrides.total ?? subtotal - savings + shipping,
    customerName: "Cliente de prueba",
    customerEmail: overrides.customerEmail ?? "cliente@test.com",
    customerPhone: "4610000000",
    street: "Calle Falsa 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "GTO",
    postalCode: "38000",
    paymentIntentId: overrides.paymentIntentId ?? null,
    paymentStatus: overrides.paymentStatus ?? "unpaid",
  } as any);
}

/** Crea un OrderItem congelado para una orden y producto dados. */
export async function createOrderItem(
  orderId: number,
  product: Product,
  overrides: { size?: number; quantity?: number } = {}
): Promise<OrderItem> {
  return OrderItem.create({
    orderId,
    productId: product.id,
    nameSnapshot: product.name,
    size: overrides.size ?? 25,
    quantity: overrides.quantity ?? 1,
    unitOriginalPrice: product.originalPrice,
    unitSalePrice: product.salePrice,
    unitCost: product.unitCost,
  } as any);
}
