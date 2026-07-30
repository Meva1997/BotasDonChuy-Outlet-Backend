import { QueryInterface, DataTypes } from "sequelize";

/**
 * Gastos reales (Fase N.3): las dos tablas que sustituyen la constante `GASTOS_FIJOS = 2000` que
 * el dashboard restaba para calcular GANANCIA NETA.
 *
 * `expenses` es la identidad + el calendario del gasto; `expense_amounts` es **el monto,
 * versionado por fecha de vigencia**. Esa separación no es normalización por gusto: es lo que hace
 * que subir el precio de Render hoy no reescriba lo que costaba en julio, y que "¿algo cambió?"
 * tenga una respuesta consultable en vez de ser una corazonada.
 *
 * `expense_amounts_effective_unique` se declara además en `ExpenseAmount.init()` porque
 * `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones.
 *
 * Los dos catálogos de ENUM se repiten literales aquí en vez de importarse de `models/Expense.ts`:
 * las migraciones corren fuera del arranque de la app y no deben arrastrar `config/database.ts`
 * (que instanciaría una segunda conexión). Al agregar un valor nuevo, tocar ambos lados.
 */

const CATEGORIES = [
  "infraestructura",
  "software",
  "renta",
  "servicios",
  "paqueteria",
  "publicidad",
  "nomina",
  "impuestos",
  "otro",
];

const FREQUENCIES = [
  "once",
  "weekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "yearly",
];

export async function up(queryInterface: QueryInterface) {
  await queryInterface.createTable("expenses", {
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
      type: DataTypes.ENUM(...CATEGORIES),
      allowNull: false,
    },
    frequency: {
      type: DataTypes.ENUM(...FREQUENCIES),
      allowNull: false,
    },
    // DATEONLY y no DATE: un cargo es un día de calendario, no un instante. Esquiva de raíz el
    // problema de zona horaria que `couponDateSchema` tuvo que resolver con un offset fijo.
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  });

  await queryInterface.createTable("expense_amounts", {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    expenseId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "expenses",
        key: "id",
      },
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  });

  // Dos montos vigentes el mismo día para el mismo gasto es una contradicción; además, es lo que
  // hace que re-editar el monto capturado hoy corrija la fila en vez de duplicar la versión.
  await queryInterface.addIndex("expense_amounts", ["expenseId", "effectiveFrom"], {
    unique: true,
    name: "expense_amounts_effective_unique",
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeIndex(
    "expense_amounts",
    "expense_amounts_effective_unique",
  );
  await queryInterface.dropTable("expense_amounts");
  await queryInterface.dropTable("expenses");
  // `dropTable` NO borra los tipos ENUM que `DataTypes.ENUM` creó implícitamente
  // (`enum_<tabla>_<columna>`): sin esto, un `migrate` posterior falla con "type already exists".
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_expenses_category";`);
  await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_expenses_frequency";`);
}
