/**
 * Factories de datos de prueba (partes 2 en adelante). Cada helper crea una fila con
 * valores por defecto sensatos y acepta un `overrides` parcial para el caso que la
 * prueba necesita destacar (p. ej. un producto con stock 1 en una sola talla para el
 * test de descuento atómico concurrente).
 *
 * Requieren una BD de test activa (ver tests/setup/db.ts) — no son puros.
 */
import jsonwebtoken from "jsonwebtoken";
import { Product } from "../../src/models/Product";
import { ProductSize } from "../../src/models/ProductSize";
import { AdminUser } from "../../src/models/AdminUser";
import { Order } from "../../src/models/Order";
import { OrderItem } from "../../src/models/OrderItem";
import { Coupon } from "../../src/models/Coupon";
import { CouponRedemption } from "../../src/models/CouponRedemption";
import { hashPassword } from "../../src/utils/password";
import { normalizeEmailIdentity } from "../../src/utils/emailIdentity";

let emailCounter = 0;

interface ProductOverrides {
  name?: string;
  /** SKU. Nullable en el modelo, así que por defecto no se manda. */
  code?: string;
  type?: "bota" | "sombrero" | "ropa";
  originalPrice?: number;
  salePrice?: number;
  unitCost?: number;
  visible?: boolean;
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  /** Stock por talla, p. ej. `{ 25: 3, 26: 1 }`. Crea las filas de ProductSize.
   *  Para un producto `hasSizes: false`, usa la clave `0` (NO_SIZE_SENTINEL), p. ej. `{ 0: 12 }`. */
  sizes?: Record<number, number>;
  /** `false` = existencia manual sin tallas. Default `true` (comportamiento de siempre). */
  hasSizes?: boolean;
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
  customerName?: string;
  couponId?: number | null;
  couponCode?: string | null;
  couponDiscount?: number;
  /**
   * Momento de creación explícito. Lo necesita el resumen diario (Fase N.4): su ventana es un día
   * de calendario en hora de la tienda, así que los casos que importan son pedidos situados a una
   * hora concreta (23:30 local dentro, 00:30 del día siguiente fuera).
   */
  createdAt?: Date;
  /** `null` = el pedido cayó a la tarifa plana de respaldo y su guía se genera a mano. */
  skydropxRateId?: string | null;
  skydropxQuotationId?: string | null;
  skydropxShipmentId?: string | null;
  shippingRequiresDropoff?: boolean | null;
}

/** Crea una Order con totales y datos de cliente por defecto (status `pending`). */
export async function createOrder(overrides: OrderOverrides = {}): Promise<Order> {
  const subtotal = overrides.subtotal ?? 800;
  const savings = overrides.savings ?? 0;
  const shipping = overrides.shipping ?? 150;
  const couponDiscount = overrides.couponDiscount ?? 0;
  return Order.create({
    status: overrides.status ?? "pending",
    subtotal,
    savings,
    shipping,
    // El descuento del cupón entra en el total por defecto, o cualquier fixture con cupón
    // quedaría con una aritmética que contradice el invariante que la app mantiene.
    total: overrides.total ?? subtotal - savings - couponDiscount + shipping,
    customerName: overrides.customerName ?? "Cliente de prueba",
    customerEmail: overrides.customerEmail ?? "cliente@test.com",
    customerPhone: "4610000000",
    street: "Calle Falsa 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "GTO",
    postalCode: "38000",
    paymentIntentId: overrides.paymentIntentId ?? null,
    paymentStatus: overrides.paymentStatus ?? "unpaid",
    couponId: overrides.couponId ?? null,
    couponCode: overrides.couponCode ?? null,
    couponDiscount,
    skydropxQuotationId: overrides.skydropxQuotationId ?? null,
    skydropxRateId: overrides.skydropxRateId ?? null,
    skydropxShipmentId: overrides.skydropxShipmentId ?? null,
    shippingRequiresDropoff: overrides.shippingRequiresDropoff ?? null,
    // Solo se manda cuando el caso lo pide: si no, se deja que Sequelize ponga `now()`.
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  } as any);
}

interface CouponOverrides {
  code?: string;
  type?: "percent" | "fixed";
  value?: number;
  maxDiscount?: number | null;
  minSubtotal?: number | null;
  maxRedemptions?: number | null;
  redeemedCount?: number;
  oncePerCustomer?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  active?: boolean;
}

let couponCounter = 0;

/** Crea un Coupon (15% sin topes ni ventana por defecto). */
export async function createCoupon(overrides: CouponOverrides = {}): Promise<Coupon> {
  return Coupon.create({
    code: overrides.code ?? `PRUEBA${++couponCounter}`,
    type: overrides.type ?? "percent",
    value: overrides.value ?? 15,
    maxDiscount: overrides.maxDiscount ?? null,
    minSubtotal: overrides.minSubtotal ?? null,
    maxRedemptions: overrides.maxRedemptions ?? null,
    redeemedCount: overrides.redeemedCount ?? 0,
    oncePerCustomer: overrides.oncePerCustomer ?? true,
    startsAt: overrides.startsAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    active: overrides.active ?? true,
  } as any);
}

/**
 * Crea una fila de canje ya consumida, para probar el bloqueo por correo o la liberación sin
 * pasar por un checkout completo. **No** mueve `redeemedCount`: si la prueba lo necesita
 * consistente, pásalo en `createCoupon({ redeemedCount })`.
 */
export async function createCouponRedemption(
  coupon: Coupon,
  orderId: number,
  overrides: { email?: string; enforced?: boolean; discount?: number } = {}
): Promise<CouponRedemption> {
  const email = overrides.email ?? "cliente@test.com";
  return CouponRedemption.create({
    couponId: coupon.id,
    orderId,
    email,
    emailNormalized: normalizeEmailIdentity(email),
    enforced: overrides.enforced ?? coupon.oncePerCustomer,
    discount: overrides.discount ?? 100,
  } as any);
}

/**
 * Firma un JWT igual al que emite `POST /api/auth/login` (mismo shape de payload
 * que `auth.controller.ts`), para las suites de integración que ejercitan rutas
 * `[auth]` por HTTP sin pasar por el login real.
 */
export function signToken(user: AdminUser): string {
  return jsonwebtoken.sign(
    { id: String(user.id), name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" },
  );
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
