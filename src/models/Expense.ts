import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";
import type { ExpenseAmount } from "./ExpenseAmount";

/**
 * Categorías de gasto (Fase N.3). ENUM fijo y no texto libre a propósito: la agrupación por
 * categoría se pinta en el panel, y con texto libre `"Infra"`, `"infraestructura"` e `"INFRA"`
 * serían tres grupos distintos en la misma gráfica sin forma de arreglarlo desde el código.
 * Agregar una categoría nueva es una migración chica (`ALTER TYPE ... ADD VALUE`, ver la del
 * `refunded` de `paymentStatus`).
 */
export const EXPENSE_CATEGORIES = [
  "infraestructura", // Render, Vercel, la base de datos, dominios
  "software", // SaaS y suscripciones que no son infra (diseño, contabilidad)
  "renta",
  "servicios", // luz, agua, internet, teléfono
  "paqueteria", // saldo de guías, cajas, empaque
  "publicidad",
  "nomina",
  "impuestos",
  "otro",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * Cada cuánto se cobra el gasto.
 *
 * `once` es un gasto de una sola vez (una compra de cajas, un anticipo) y por eso **no** entra en
 * la carga mensual recurrente: cuenta completo en su mes y nunca más. El resto se convierte a un
 * equivalente mensual en `expenses.service.ts` (`MONTHLY_FACTOR`) para responder "cuánto tengo que
 * retirar cada mes".
 */
export const EXPENSE_FREQUENCIES = [
  "once",
  "weekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "yearly",
] as const;

export type ExpenseFrequency = (typeof EXPENSE_FREQUENCIES)[number];

export interface ExpenseAttributes {
  id: number;
  /** "Render — Web Service", "Neon Postgres", "Renta del local". */
  concept: string;
  /** Proveedor, para agrupar varios conceptos de la misma cuenta ("Render", "Vercel"). */
  vendor: string | null;
  category: ExpenseCategory;
  frequency: ExpenseFrequency;
  /**
   * Fecha del primer cargo (y **el** cargo, si `frequency: "once"`).
   *
   * `DATEONLY` y no `DATE` a propósito: un cargo es un día de calendario, no un instante, así que
   * esto esquiva de raíz el problema de zona horaria que `couponDateSchema` tuvo que resolver con
   * un offset fijo de México. **Ojo:** Sequelize devuelve `DATEONLY` como un **string
   * `"2026-07-15"`**, no como `Date` — de ahí el tipo.
   */
  startsAt: string;
  /**
   * Se canceló la suscripción. Deja de generar cargos desde esa fecha, pero **el historial pasado
   * se conserva**: lo que ya se gastó se gastó, y borrarlo del historial sería mentirle al dueño.
   */
  endsAt: string | null;
  /** Apagador inmediato sin tocar fechas. Un gasto inactivo no genera cargos nuevos ni entra en la
   *  carga mensual, pero sus cargos pasados siguen en el historial. */
  active: boolean;
  notes: string | null;
}

interface ExpenseCreationAttributes extends Optional<
  ExpenseAttributes,
  "id" | "vendor" | "endsAt" | "active" | "notes"
> {}

export class Expense
  extends Model<ExpenseAttributes, ExpenseCreationAttributes>
  implements ExpenseAttributes
{
  declare id: number;
  declare concept: string;
  declare vendor: string | null;
  declare category: ExpenseCategory;
  declare frequency: ExpenseFrequency;
  declare startsAt: string;
  declare endsAt: string | null;
  declare active: boolean;
  declare notes: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  /** Versiones del monto (`associations.ts`). El monto NO vive en esta tabla: ver `ExpenseAmount`. */
  declare amounts?: ExpenseAmount[];
}

Expense.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    concept: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    vendor: {
      type: DataTypes.STRING(60),
      allowNull: true,
      defaultValue: null,
    },
    category: {
      type: DataTypes.ENUM(...EXPENSE_CATEGORIES),
      allowNull: false,
    },
    frequency: {
      type: DataTypes.ENUM(...EXPENSE_FREQUENCIES),
      allowNull: false,
    },
    startsAt: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    endsAt: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    notes: {
      type: DataTypes.STRING(300),
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "expenses",
    timestamps: true,
  },
);
