import request from "supertest";
import app from "../../src/app";

/**
 * Smoke test de infra (Parte 0). Importar `src/app` bajo `NODE_ENV=test` ejercita todo
 * el arranque: el fail-fast de cada `src/config/*` (que `.env.test` debe satisfacer), el
 * registro de rutas y — gracias al gate de `app.ts` — SIN abrir un puerto, conectar a la
 * BD ni arrancar el sweeper. `GET /health` no toca la BD, así que pasa sin Postgres.
 *
 * Si esta prueba falla, el problema es de configuración/arranque, no de una feature.
 */
describe("smoke: app arranca en entorno de test", () => {
  it("GET /health responde 200 { status: 'ok' }", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
