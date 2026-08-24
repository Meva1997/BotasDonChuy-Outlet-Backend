import request from "supertest";

/**
 * Nivel 1 (sin BD): la POLÍTICA (`apiDocsEnabled`, "en producción apagado salvo que lo pidas")
 * se prueba en `tests/unit/utils/env.test.ts`; lo que se verifica aquí es el **cableado** en
 * `app.ts` — que la bandera realmente decida si las dos rutas se montan.
 *
 * A propósito NO se toca `NODE_ENV` en este archivo: reimportar `app.ts` con
 * `NODE_ENV="production"` dispararía `connectDB()`, los tres crons y `app.listen(PORT)` dentro
 * de la suite. Poner `API_DOCS_ENABLED` a mano ejercita las dos ramas del `if` sin ese riesgo.
 */
describe("gate de /api/docs en app.ts", () => {
  const load = async (value?: string) => {
    jest.resetModules();
    if (value === undefined) delete process.env.API_DOCS_ENABLED;
    else process.env.API_DOCS_ENABLED = value;
    return (await import("../../../src/app")).default;
  };

  afterAll(() => {
    delete process.env.API_DOCS_ENABLED;
  });

  it("sin la variable (entorno de test) sirve la UI y el spec", async () => {
    const app = await load(undefined);

    const spec = await request(app).get("/api/docs.json");
    expect(spec.status).toBe(200);
    expect(Object.keys(spec.body.paths ?? {}).length).toBeGreaterThan(0);

    const ui = await request(app).get("/api/docs/");
    expect(ui.status).toBe(200);
  });

  it("API_DOCS_ENABLED=false deja ambas rutas en 404, sin filtrar el spec", async () => {
    const app = await load("false");

    const spec = await request(app).get("/api/docs.json");
    expect(spec.status).toBe(404);
    // Lo que importa del 404: que el cuerpo no traiga el mapa de endpoints por otra vía.
    expect(spec.body.paths).toBeUndefined();

    const ui = await request(app).get("/api/docs/");
    expect(ui.status).toBe(404);
  });

  it("el resto de la API sigue montada con las docs apagadas", async () => {
    // El gate envuelve solo esas dos rutas; si alguien moviera la llave del `if` de lugar,
    // se llevaría por delante los routers que van justo debajo.
    const app = await load("false");

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
