import { sequelize } from "./config/database";
import { Product } from "./models/Product";
import { ProductSize } from "./models/ProductSize";
import { AdminUser } from "./models/AdminUser";
import { Order } from "./models/Order";
import { OrderItem } from "./models/OrderItem";
import { BrandSettings } from "./models/BrandSettings";
import { Expense } from "./models/Expense";
import { ExpenseAmount } from "./models/ExpenseAmount";
import "./models/associations";
import { computeTotals, type CartLineItem } from "./services/cart";
import { hashPassword } from "./utils/password";

interface SeedProduct {
  id: number;
  name: string;
  description: string;
  originalPrice: number;
  salePrice: number;
  unitCost: number;
  type: "bota" | "sombrero" | "ropa";
  sizes: number[];
  code?: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

// Datos exactos de frontend/db/mockProducts.ts
const PRODUCTS: SeedProduct[] = [
  {
    id: 1,
    name: "Bota Ranchera 1972",
    description:
      "Piel de res curtida al vegetal, horma tradicional de Saltillo. Costura a mano del taller original — el último lote antes de cerrar la línea.",
    originalPrice: 4800,
    salePrice: 1920.5,
    unitCost: 800.75,
    type: "bota",
    sizes: [25, 26, 27, 28],
    code: "jeh3ujlkh",
    weightKg: 2.5,
    lengthCm: 35,
    widthCm: 30,
    heightCm: 20,
  },
  {
    id: 2,
    name: "Bota Exótica de Avestruz",
    description:
      "Piel de avestruz genuina con acabado natural. Corte artesanal de edición limitada — piezas únicas de colección.",
    originalPrice: 7200,
    salePrice: 2880,
    unitCost: 1400,
    type: "bota",
    sizes: [24, 26, 28],
    weightKg: 2.5,
    lengthCm: 35,
    widthCm: 30,
    heightCm: 20,
  },
  {
    id: 3,
    name: "Sombrero Llanero 30X",
    description:
      "Fieltro prensado de 30X con ala ancha y copa alta. Forma clásica norteña, acabado interior en tela de seda natural.",
    originalPrice: 3400,
    salePrice: 1530,
    unitCost: 580.5,
    type: "sombrero",
    sizes: [56, 58, 60],
    weightKg: 0.8,
    lengthCm: 45,
    widthCm: 45,
    heightCm: 20,
  },
  {
    id: 4,
    name: "Bota Piel de Víbora",
    description:
      "Piel de víbora de cascabel con horma vaquera. Suela de cuero doble cosida — resistencia y estilo en cada paso.",
    originalPrice: 5600,
    salePrice: 2240,
    unitCost: 950,
    type: "bota",
    sizes: [25, 27],
    code: "3hk3hllf",
    weightKg: 2.5,
    lengthCm: 35,
    widthCm: 30,
    heightCm: 20,
  },
  {
    id: 5,
    name: "Sombrero Norteño Pelo de Camello",
    description:
      "Pelo de camello natural con acabado cepillado. Ala recta tradicional, cinta de piel cosida a mano.",
    originalPrice: 2800,
    salePrice: 1400,
    unitCost: 520,
    type: "sombrero",
    sizes: [58],
    weightKg: 0.8,
    lengthCm: 45,
    widthCm: 45,
    heightCm: 20,
  },
  {
    id: 6,
    name: "Bota Bordada Tejana",
    description:
      "Piel de res con bordado floral tejano en hilo de seda. Puntera cuadrada, tacón cubano de madera lacada.",
    originalPrice: 3900,
    salePrice: 1755,
    unitCost: 750,
    type: "bota",
    sizes: [24, 25, 26, 27],
    weightKg: 2.5,
    lengthCm: 35,
    widthCm: 30,
    heightCm: 20,
  },
];

// Histórico exacto de frontend/db/mockData.ts (MONTHLY_UNIT_SALES)
const MONTHLY_UNIT_SALES: { key: string; units: Record<number, number> }[] = [
  { key: "2026-01", units: { 1: 3, 2: 4, 3: 2, 4: 6, 5: 1, 6: 1 } },
  { key: "2026-02", units: { 1: 4, 2: 3, 3: 1, 4: 5, 5: 0, 6: 2 } },
  { key: "2026-03", units: { 1: 3, 2: 5, 3: 2, 4: 4, 5: 1, 6: 1 } },
  { key: "2026-04", units: { 1: 4, 2: 4, 3: 3, 4: 4, 5: 0, 6: 1 } },
  { key: "2026-05", units: { 1: 4, 2: 6, 3: 2, 4: 3, 5: 1, 6: 2 } },
  { key: "2026-06", units: { 1: 2, 2: 2, 3: 1, 4: 1, 5: 0, 6: 0 } },
];

// Defaults exactos de frontend/lib/brand.ts
const BRAND_DEFAULTS = {
  brandName: "Botas Don Chuy Outlet",
  heroText: "Liquidación final · Sin reposición",
  tagline: "Piezas únicas. Sin reposición.\nCuando se acaba, se acaba.",
  cartNotice: "Estos artículos no se reservan",
  footerNote: "Liquidación de inventario · piezas finales · sin reposición",
};

async function seed() {
  await sequelize.authenticate();
  console.log("✅ Conexión a PostgreSQL establecida");

  await sequelize.query(
    "TRUNCATE TABLE product_sizes, order_items, orders, products, adminusers, brand_settings, expense_amounts, expenses RESTART IDENTITY CASCADE",
  );
  console.log("🧹 Tablas limpiadas");

  await sequelize.transaction(async (t) => {
    const productsById = new Map<number, SeedProduct>();

    for (const p of PRODUCTS) {
      await Product.create(
        {
          id: p.id,
          name: p.name,
          description: p.description,
          originalPrice: p.originalPrice,
          salePrice: p.salePrice,
          unitCost: p.unitCost,
          type: p.type,
          code: p.code,
          weightKg: p.weightKg,
          lengthCm: p.lengthCm,
          widthCm: p.widthCm,
          heightCm: p.heightCm,
          visible: true,
        },
        { transaction: t },
      );

      for (const size of p.sizes) {
        await ProductSize.create(
          { productId: p.id, size, stock: 1 },
          { transaction: t },
        );
      }

      productsById.set(p.id, p);
    }
    console.log(`📦 ${PRODUCTS.length} productos creados`);

    let ordersCreated = 0;
    for (const month of MONTHLY_UNIT_SALES) {
      const lineEntries = Object.entries(month.units).filter(
        ([, qty]) => qty > 0,
      );
      if (lineEntries.length === 0) continue;

      const lineItems: CartLineItem[] = lineEntries.map(([productId, qty]) => {
        const product = productsById.get(Number(productId))!;
        return { product, quantity: qty };
      });
      const totals = computeTotals(lineItems);

      const createdAt = new Date(`${month.key}-15T12:00:00.000Z`);

      const order = await Order.create(
        {
          status: "paid",
          paymentStatus: "paid",
          subtotal: totals.subtotal,
          savings: totals.savings,
          shipping: totals.shipping,
          total: totals.total,
          customerName: "Cliente Histórico",
          customerEmail: "ventas@botasdonchuy.mx",
          customerPhone: "0000000000",
          street: "N/A",
          neighborhood: "N/A",
          city: "Celaya",
          state: "Guanajuato",
          postalCode: "38000",
          createdAt,
          updatedAt: createdAt,
        } as any,
        { transaction: t },
      );

      for (const [productId, qty] of lineEntries) {
        const product = productsById.get(Number(productId))!;
        await OrderItem.create(
          {
            orderId: order.id,
            productId: product.id,
            nameSnapshot: product.name,
            size: product.sizes[0],
            quantity: qty,
            unitOriginalPrice: product.originalPrice,
            unitSalePrice: product.salePrice,
            unitCost: product.unitCost,
            createdAt,
            updatedAt: createdAt,
          } as any,
          { transaction: t },
        );
      }
      ordersCreated++;
    }
    console.log(`🧾 ${ordersCreated} órdenes históricas creadas`);

    const passwordHash = await hashPassword("Queco144@");
    await AdminUser.create(
      {
        name: "Admin",
        email: "mevadev97@gmail.com",
        passwordHash,
        role: "admin",
      },
      { transaction: t },
    );
    console.log("👤 AdminUser semilla creado (mevadev97@gmail.com)");

    await BrandSettings.create(
      { id: 1, ...BRAND_DEFAULTS, logoUrl: undefined as any },
      { transaction: t },
    );
    console.log("🏷️  BrandSettings creado");

    // Migración del `GASTOS_FIJOS = 2000` que `dashboard.service.ts` restaba hasta la Fase N.3.
    // Es una fila normal y editable, no un valor especial: el dueño puede cambiarle el monto,
    // partirla en gastos reales (Render, Vercel, la base de datos) o borrarla. Existe solo para
    // que la GANANCIA NETA del panel no dé un salto el día del deploy.
    const gastosOperacion = await Expense.create(
      {
        concept: "Gastos de operación (dominio + comisión de pasarela)",
        category: "otro",
        frequency: "monthly",
        startsAt: `${MONTHLY_UNIT_SALES[0].key}-01`,
        notes:
          "Estimado heredado del panel anterior. Sustitúyelo por los gastos reales (Render, Vercel, base de datos…) en cuanto los tengas a la mano.",
      },
      { transaction: t },
    );
    await ExpenseAmount.create(
      {
        expenseId: gastosOperacion.id,
        amount: 2000,
        effectiveFrom: `${MONTHLY_UNIT_SALES[0].key}-01`,
      },
      { transaction: t },
    );
    console.log("💸 Gasto recurrente semilla creado ($2,000/mes)");

    // Las filas anteriores se insertan con `id` explícito, lo que en Postgres
    // NO avanza la secuencia SERIAL de cada tabla. Sin esto, el primer INSERT
    // posterior con `id DEFAULT` (p. ej. POST /api/admin/products) reusaría ids
    // ya ocupados y fallaría con UniqueConstraintError. Resincronizamos cada
    // secuencia a MAX(id) para que el siguiente id sea MAX(id)+1.
    const tablesWithExplicitIds = [
      "products",
      "product_sizes",
      "orders",
      "order_items",
      "brand_settings",
    ];
    for (const table of tablesWithExplicitIds) {
      await sequelize.query(
        `SELECT setval(
           pg_get_serial_sequence(:table, 'id'),
           (SELECT COALESCE(MAX(id), 1) FROM "${table}")
         )`,
        { replacements: { table }, transaction: t },
      );
    }
    console.log("🔢 Secuencias de id resincronizadas");
  });

  console.log("✅ Seed completado");
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Error al correr el seed:", error);
    process.exit(1);
  });
