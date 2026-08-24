import { sequelize } from "../../src/config/database";
import { setupTestDatabase, closeTestDatabase } from "../setup/db";

/**
 * Nivel 2 (Postgres real, sin HTTP): los índices calientes de `orders`
 * (docs/PRE-PRODUCCION.md, punto 11) existen realmente en la base.
 *
 * Por qué merece un test aunque un índice "no cambie comportamiento": este repo tiene DOS
 * fuentes de esquema —las migraciones de `src/migrations/` para dev/prod y el
 * `sync({ force: true })` de `tests/setup/db.ts`, que lee `Model.init`— y nada las compara.
 * Un índice declarado solo en la migración, o solo en el modelo, no rompe nada visible: se
 * descubre meses después con la tabla ya crecida y el webhook de Stripe agotando su timeout.
 * Esta suite mira el esquema que sale de `Model.init`; el otro lado se verifica corriendo la
 * migración.
 *
 * No hay `truncateAll` entre tests: no se inserta ni una fila, solo se lee el catálogo.
 */
describe("índices de la tabla orders", () => {
  let indexNames: string[];

  beforeAll(async () => {
    await setupTestDatabase();
    const [rows] = await sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'orders';`,
    );
    indexNames = (rows as Array<{ indexname: string }>).map((r) => r.indexname);
  });

  afterAll(closeTestDatabase);

  it.each([
    // Quién lo necesita, para que el nombre no sea lo único que sostenga el test.
    ["orders_payment_intent_id", "cada evento del webhook de Stripe (pagos y disputas)"],
    ["orders_skydropx_shipment_id", "cada evento del webhook de Skydropx y la reconciliación"],
    ["orders_payment_status_created_at", "dashboard y reportes (ventana de 180 días)"],
    ["orders_status_created_at", "pendingOrderSweeper y pendingShipmentWhere"],
  ])('existe %s — lo usa %s', (name) => {
    expect(indexNames).toContain(name);
  });

  it("conserva el índice único del token público (Fase O.4)", () => {
    // Es el que ya estaba: si un cambio en el array `indexes:` lo perdiera, un token podría
    // resolver a dos pedidos y ningún otro test lo notaría.
    expect(indexNames).toContain("orders_public_token_unique");
  });

  it("los índices parciales excluyen las filas en null", async () => {
    // La parcialidad no es cosmética: es lo que mantiene chico el índice cuando la mayoría de
    // los pedidos no tiene guía. Si alguien quitara el `where`, esto lo detecta.
    const [rows] = await sequelize.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'orders'
          AND indexname IN ('orders_payment_intent_id', 'orders_skydropx_shipment_id');`,
    );
    const defs = rows as Array<{ indexname: string; indexdef: string }>;

    expect(defs).toHaveLength(2);
    for (const { indexdef } of defs) {
      expect(indexdef).toMatch(/WHERE .*IS NOT NULL/i);
    }
  });
});
