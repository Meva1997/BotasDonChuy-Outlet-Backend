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
  paymentStatus: "unpaid" | "processing" | "paid" | "failed" | "refunded";
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
  // Guía automática al pagar (Fase 8.5). `skydropxShipmentId` es el guard anti-doble-guía:
  // se reclama con un valor centinela ANTES de llamar a Skydropx (crear una guía cuesta dinero
  // real) y se reemplaza por el id real de la guía al terminar — ver createShipmentForOrder en
  // payment.service.ts. `trackingNumber`/`trackingUrl`/`labelUrl` quedan `null` hasta que el
  // webhook de Skydropx (Fase 8.6) los reporte: la creación de la guía es asíncrona, la respuesta
  // de `POST /shipments` no los incluye (confirmado contra sandbox real). `shipmentStatus` es el
  // último estado que reporte ese mismo webhook (`in_transit`, `delivered`, etc.).
  skydropxShipmentId: string | null;
  // Momento en que se reclamó el centinela de creación de guía (Fase O.3). Es el reloj con el
  // que se decide si un `"creating"` quedó HUÉRFANO (el proceso murió antes de llamar a
  // Skydropx) y puede liberarse. Columna propia y no `updatedAt` a propósito: `updatedAt` lo
  // bumpea cualquier otra escritura sobre el pedido (webhook de envío, avance manual de estado,
  // marcado de pago), así que un pedido realmente atorado en `"creating"` reiniciaba su reloj
  // cada vez que el dueño lo tocaba desde el panel y nunca podía liberarse.
  shipmentClaimedAt: Date | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  shipmentStatus: string | null;
  // Cancelación/reembolso manual (Fase H.5). Se pueblan solo cuando una orden `paid`
  // se cancela por el panel admin y Stripe procesa el reembolso: `refundId` es el id
  // del reembolso (`re_...`) y `refundedAt` el momento en que se aplicó. Nullas en
  // cualquier otro caso. Ver `cancelOrderByAdmin` en orders.service.ts.
  refundId: string | null;
  refundedAt: Date | null;
  // Token opaco de consulta pública (Fase O.4). Es la ÚNICA credencial de
  // `GET /api/orders/lookup/:token`, la ruta que deja al cliente ver el estado y el rastreo de
  // su pedido sin cuenta ni contraseña — de ahí que sea un UUID aleatorio con índice único y no
  // el par `id + email` (ids secuenciales + correo adivinable = enumerable). Se genera en
  // `createOrder`; nullable solo por las filas anteriores a la columna (la migración las rellenó).
  publicToken: string | null;
  // Cupón de descuento (Fase N.2). `couponId` apunta al cupón canjeado (FK con `RESTRICT`, así
  // que un cupón con historia no se puede borrar y dejar la orden huérfana); `couponCode` es el
  // texto **CONGELADO** al momento de la compra, igual que los precios del `OrderItem`: un cupón
  // editado o desactivado después no altera el histórico. Los dos son `null` cuando no se usó
  // cupón.
  couponId: number | null;
  couponCode: string | null;
  // Descuento en pesos que aplicó el cupón. Columna APARTE de `savings` a propósito (regla
  // explícita del roadmap): `savings` significa "ahorro outlet" (`originalPrice` vs `salePrice`)
  // y sumar el cupón ahí falsearía el margen del dashboard. No es nullable —default `0`— para que
  // todo consumidor que hace aritmética se ahorre el `?? 0` y una fila anterior al deploy lea 0.
  // Invariante nuevo de toda la app: `total = subtotal − savings − couponDiscount + shipping`.
  couponDiscount: number;
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
  | "skydropxShipmentId"
  | "shipmentClaimedAt"
  | "trackingNumber"
  | "trackingUrl"
  | "labelUrl"
  | "shipmentStatus"
  | "refundId"
  | "refundedAt"
  | "publicToken"
  | "couponId"
  | "couponCode"
  | "couponDiscount"
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
  declare paymentStatus: "unpaid" | "processing" | "paid" | "failed" | "refunded";
  declare skydropxQuotationId: string | null;
  declare skydropxRateId: string | null;
  declare shippingRequiresDropoff: boolean | null;
  declare skydropxShipmentId: string | null;
  declare shipmentClaimedAt: Date | null;
  declare trackingNumber: string | null;
  declare trackingUrl: string | null;
  declare labelUrl: string | null;
  declare shipmentStatus: string | null;
  declare refundId: string | null;
  declare refundedAt: Date | null;
  declare publicToken: string | null;
  declare couponId: number | null;
  declare couponCode: string | null;
  declare couponDiscount: number;
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
      type: DataTypes.ENUM("unpaid", "processing", "paid", "failed", "refunded"),
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
    shipmentClaimedAt: {
      type: DataTypes.DATE,
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
    refundId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    refundedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    publicToken: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
    },
    couponId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    couponCode: {
      type: DataTypes.STRING(32),
      allowNull: true,
      defaultValue: null,
    },
    couponDiscount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      get() {
        const value = this.getDataValue("couponDiscount");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
  },
  {
    sequelize,
    tableName: "orders",
    timestamps: true,
    // El índice se declara aquí ADEMÁS de en su migración (Fase O.4) porque
    // `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones:
    // sin esto, la unicidad del token —la única garantía de que un token no resuelva a dos
    // pedidos— no existiría en la BD de test. Mismo motivo que el índice de `product_sizes`.
    indexes: [
      { unique: true, fields: ["publicToken"], name: "orders_public_token_unique" },
    ],
  },
);
