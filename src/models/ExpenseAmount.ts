import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../config/database";

/**
 * El monto de un gasto, **versionado por fecha de vigencia** (Fase N.3).
 *
 * Es la pieza central de la fase, y la razón por la que `expenses` **no** tiene columna `amount`:
 * el monto vigente es *la versión con el `effectiveFrom` más grande que ya empezó*, y el monto de
 * julio es *la versión que estaba vigente en julio*. Así, cuando Render sube de $290 a $340, julio
 * sigue valiendo $290 en el historial y agosto vale $340 — los meses pasados **nunca** se
 * reescriben, que es justo lo que el dueño necesita para detectar "algo cambió".
 *
 * Guardar además un `expenses.amount` "actual" habría dejado dos fuentes de verdad que se
 * desincronizan con el primer edit mal hecho (el mismo riesgo que CLAUDE.md documenta con
 * `redeemedCount` vs `activeRedemptions`). Las tablas son de decenas de filas, así que resolver la
 * versión en memoria no cuesta nada: el `currentAmount` del listado se **calcula**.
 */
export interface ExpenseAmountAttributes {
  id: number;
  expenseId: number;
  amount: number;
  /**
   * Desde qué día rige este monto. `DATEONLY` (string `"YYYY-MM-DD"` al leerlo desde Sequelize) por
   * la misma razón que las fechas de `Expense`: es un día de calendario, no un instante.
   */
  effectiveFrom: string;
  /** Por qué cambió ("subió el dólar", "cambio de plan a Pro"). El monto solo dice cuánto. */
  note: string | null;
}

interface ExpenseAmountCreationAttributes extends Optional<
  ExpenseAmountAttributes,
  "id" | "note"
> {}

export class ExpenseAmount
  extends Model<ExpenseAmountAttributes, ExpenseAmountCreationAttributes>
  implements ExpenseAmountAttributes
{
  declare id: number;
  declare expenseId: number;
  declare amount: number;
  declare effectiveFrom: string;
  declare note: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

ExpenseAmount.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    expenseId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      get() {
        const value = this.getDataValue("amount");
        return value === null ? null : parseFloat(value as unknown as string);
      },
    },
    effectiveFrom: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    note: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: "expense_amounts",
    timestamps: true,
    // Declarado aquí ADEMÁS de en la migración porque `tests/setup/db.ts` arma el esquema con
    // `sync({ force: true })`, no con migraciones (mismo motivo que `coupons_code_unique`).
    //
    // Dos montos vigentes el mismo día para el mismo gasto es una contradicción, y este índice es
    // además lo que convierte "corregir el monto que acabo de capturar hoy" en una corrección en
    // su lugar en vez de una versión duplicada que dejaría el historial ambiguo.
    indexes: [
      {
        unique: true,
        name: "expense_amounts_effective_unique",
        fields: ["expenseId", "effectiveFrom"],
      },
    ],
  },
);
