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

  it("GET /api/docs.json sirve el spec de OpenAPI con todas las rutas montadas", async () => {
    const res = await request(app).get("/api/docs.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    // El spec se construye leyendo los bloques `@openapi` de `src/routes/**/*.ts` con un glob;
    // si ese glob dejara de empatar (p. ej. al mover un router a otra subcarpeta), el spec
    // quedaría vacío y Swagger UI se serviría sin una sola ruta, sin que nada más fallara.
    const paths = Object.keys(res.body.paths ?? {});
    expect(paths).toEqual(expect.arrayContaining(["/api/products", "/api/orders", "/health"]));
    expect(res.body.components?.securitySchemes?.bearerAuth).toBeDefined();
  });
});
