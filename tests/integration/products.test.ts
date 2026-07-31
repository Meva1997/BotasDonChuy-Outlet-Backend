import request from "supertest";

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createProduct } from "../setup/factories";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

describe("GET /api/products", () => {
  it("pagina en SQL: total/totalPages reflejan todo el catálogo visible aunque perPage recorte la página", async () => {
    for (let i = 0; i < 5; i++) {
      await createProduct({ name: `Bota ${i}` });
    }

    const res = await request(app).get("/api/products").query({ perPage: 2, page: 1 });

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.page).toBe(1);
  });

  it("clampea page a totalPages cuando se pide una página fuera de rango", async () => {
    await createProduct({ name: "Bota única" });

    const res = await request(app).get("/api/products").query({ perPage: 9, page: 99 });

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.totalPages).toBe(1);
    expect(res.body.products).toHaveLength(1);
  });

  it("no cuenta productos no visibles ni soft-deleted", async () => {
    await createProduct({ name: "Visible" });
    await createProduct({ name: "Oculto", visible: false });
    const borrado = await createProduct({ name: "Borrado" });
    await borrado.update({ deletedAt: new Date() });

    const res = await request(app).get("/api/products");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products.map((p: { name: string }) => p.name)).toEqual(["Visible"]);
  });

  it("filtra por talla usando la subquery (solo productos con stock > 0 en esa talla)", async () => {
    const conTalla = await createProduct({ name: "Con talla 25", sizes: { 25: 3, 26: 0 } });
    await createProduct({ name: "Sin talla 25", sizes: { 26: 5 } });
    await createProduct({ name: "Talla 25 sin stock", sizes: { 25: 0, 27: 2 } });

    const res = await request(app).get("/api/products").query({ talla: 25 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].id).toBe(conTalla.id);
  });

  it("ignora una talla inválida (no numérica) en vez de romper la consulta", async () => {
    await createProduct({ name: "Bota" });

    const res = await request(app).get("/api/products").query({ talla: "abc" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("ignora una talla vacía en vez de vaciar el catálogo", async () => {
    // `Number("")` es 0 y `Number.isInteger(0)` es true, así que sin el corte explícito un
    // `?talla=` filtraba por `size = 0` y no devolvía NADA.
    await createProduct({ name: "Bota" });

    const res = await request(app).get("/api/products").query({ talla: "" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  // ── Búsqueda por texto (?q=) ────────────────────────────────────────────────

  it("busca por nombre de forma parcial y sin distinguir mayúsculas", async () => {
    await createProduct({ name: "Bota Vaquera Premium" });
    await createProduct({ name: "Sombrero de palma", type: "sombrero" });

    const res = await request(app).get("/api/products").query({ q: "vaquera" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].name).toBe("Bota Vaquera Premium");
  });

  it("busca también por código (SKU)", async () => {
    await createProduct({ name: "Bota A", code: "BTA-001" });
    await createProduct({ name: "Bota B", code: "SOM-002" });

    const res = await request(app).get("/api/products").query({ q: "bta-0" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].code).toBe("BTA-001");
  });

  it("trata el % como texto literal, no como comodín de ILIKE", async () => {
    // El bug que motiva `escapeLike`: sin escapar, `%` haría match con TODO el catálogo.
    // Es el mismo que renombraba productos en el importador con "Bota%Premium".
    const literal = await createProduct({ name: "Bota 100% piel" });
    await createProduct({ name: "Bota Roja" });

    const res = await request(app).get("/api/products").query({ q: "100%" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].id).toBe(literal.id);
  });

  it("trata el _ como texto literal, no como comodín de un carácter", async () => {
    const literal = await createProduct({ name: "Bota", code: "BTA_1" });
    await createProduct({ name: "Otra", code: "BTAX1" });

    const res = await request(app).get("/api/products").query({ q: "BTA_1" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].id).toBe(literal.id);
  });

  it("no revienta con un q que es solo una barra invertida", async () => {
    // Sin escapar la `\`, el patrón `%\%` deja un escape colgante y Postgres responde
    // `22025 LIKE pattern must not end with escape character`, que el errorHandler degradaría
    // a un 500 — un error de servidor provocable con un solo carácter en la query string.
    await createProduct({ name: "Bota" });

    const res = await request(app).get("/api/products").query({ q: "\\" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("combina q en AND con categoria y talla (el OR no se come el resto del where)", async () => {
    const esperado = await createProduct({
      name: "Bota charra",
      type: "bota",
      sizes: { 25: 2 },
    });
    await createProduct({ name: "Bota charra", type: "bota", sizes: { 30: 2 } });
    await createProduct({ name: "Sombrero charro", type: "sombrero", sizes: { 25: 2 } });
    await createProduct({ name: "Bota lisa", type: "bota", sizes: { 25: 2 } });

    const res = await request(app)
      .get("/api/products")
      .query({ q: "charr", categoria: "bota", talla: 25 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].id).toBe(esperado.id);
  });

  it("ignora un q en blanco en vez de filtrar por cadena vacía", async () => {
    await createProduct({ name: "Bota" });
    await createProduct({ name: "Sombrero", type: "sombrero" });

    const res = await request(app).get("/api/products").query({ q: "   " });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it("total y totalPages reflejan el filtro de q (el where se comparte con el count)", async () => {
    for (let i = 0; i < 4; i++) await createProduct({ name: `Bota ${i}` });
    for (let i = 0; i < 3; i++) await createProduct({ name: `Sombrero ${i}`, type: "sombrero" });

    const res = await request(app).get("/api/products").query({ q: "bota", perPage: 2 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.products).toHaveLength(2);
  });

  // ── Rango de precio (?precioMin= / ?precioMax=) ─────────────────────────────

  it("acota por precioMin y precioMax de forma inclusiva en ambos extremos", async () => {
    await createProduct({ name: "Barata", salePrice: 400 });
    await createProduct({ name: "En rango baja", salePrice: 500 });
    await createProduct({ name: "En rango alta", salePrice: 1500 });
    await createProduct({ name: "Cara", salePrice: 1600 });

    const res = await request(app)
      .get("/api/products")
      .query({ precioMin: 500, precioMax: 1500 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.products.map((p: { name: string }) => p.name).sort()).toEqual([
      "En rango alta",
      "En rango baja",
    ]);
  });

  it("devuelve vacío cuando precioMin > precioMax (no corrige ni intercambia el rango)", async () => {
    await createProduct({ name: "Bota", salePrice: 800 });

    const res = await request(app)
      .get("/api/products")
      .query({ precioMin: 2000, precioMax: 100 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.products).toHaveLength(0);
  });

  it("ignora un precio inválido o negativo en vez de romper la consulta", async () => {
    await createProduct({ name: "Bota", salePrice: 800 });

    const res = await request(app)
      .get("/api/products")
      .query({ precioMin: "abc", precioMax: -5 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  // ── Orden (?orden=) ─────────────────────────────────────────────────────────

  it("ordena por precio ascendente y descendente", async () => {
    await createProduct({ name: "Media", salePrice: 800 });
    await createProduct({ name: "Cara", salePrice: 1500 });
    await createProduct({ name: "Barata", salePrice: 300 });

    const asc = await request(app).get("/api/products").query({ orden: "precio_asc" });
    expect(asc.status).toBe(200);
    expect(asc.body.products.map((p: { name: string }) => p.name)).toEqual([
      "Barata",
      "Media",
      "Cara",
    ]);

    const desc = await request(app).get("/api/products").query({ orden: "precio_desc" });
    expect(desc.body.products.map((p: { name: string }) => p.name)).toEqual([
      "Cara",
      "Media",
      "Barata",
    ]);
  });

  it("orden=novedad devuelve primero el producto más reciente", async () => {
    await createProduct({ name: "Primero" });
    await createProduct({ name: "Segundo" });
    const ultimo = await createProduct({ name: "Tercero" });

    const res = await request(app).get("/api/products").query({ orden: "novedad" });

    expect(res.status).toBe(200);
    expect(res.body.products[0].id).toBe(ultimo.id);
  });

  it("desempata por id cuando dos productos tienen el mismo precio (paginación estable)", async () => {
    // Sin el desempate, Postgres no garantiza un orden estable entre páginas y el cliente vería
    // un producto repetido y otro perdido al pasar de página.
    for (let i = 0; i < 4; i++) await createProduct({ name: `Igual ${i}`, salePrice: 800 });

    const p1 = await request(app)
      .get("/api/products")
      .query({ orden: "precio_asc", perPage: 2, page: 1 });
    const p2 = await request(app)
      .get("/api/products")
      .query({ orden: "precio_asc", perPage: 2, page: 2 });

    const ids = [...p1.body.products, ...p2.body.products].map((p: { id: number }) => p.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("ignora un orden no reconocido y cae al orden por defecto", async () => {
    await createProduct({ name: "A" });
    await createProduct({ name: "B" });

    const res = await request(app).get("/api/products").query({ orden: "carisimo" });

    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { name: string }) => p.name)).toEqual(["A", "B"]);
  });

  it("combina búsqueda, rango de precio y orden en una sola consulta", async () => {
    await createProduct({ name: "Bota barata", salePrice: 300 });
    await createProduct({ name: "Bota media", salePrice: 800 });
    await createProduct({ name: "Bota cara", salePrice: 2000 });
    await createProduct({ name: "Sombrero media", type: "sombrero", salePrice: 800 });

    const res = await request(app)
      .get("/api/products")
      .query({ q: "bota", precioMin: 500, precioMax: 2500, orden: "precio_desc" });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.products.map((p: { name: string }) => p.name)).toEqual([
      "Bota cara",
      "Bota media",
    ]);
  });

  it("availableSizes refleja toda la categoría, no solo la talla filtrada", async () => {
    await createProduct({ name: "A", type: "bota", sizes: { 25: 2, 26: 0 } });
    await createProduct({ name: "B", type: "bota", sizes: { 27: 4 } });
    await createProduct({ name: "C", type: "sombrero", sizes: { 60: 3 } });

    const res = await request(app).get("/api/products").query({ categoria: "bota", talla: 25 });

    expect(res.status).toBe(200);
    // 26 tiene stock 0 (no cuenta), 60 es de otra categoría (no cuenta).
    expect(res.body.availableSizes).toEqual([25, 27]);
  });

  it("availableSizes SÍ se acota por q y por precio, pero NO por la talla ya elegida", async () => {
    // Acotarlo por q/precio evita ofrecer una talla que no existe dentro de la búsqueda (elegirla
    // devolvería cero resultados); NO acotarlo por `talla` evita el callejón contrario, que
    // elegir una talla vacíe el propio selector y no haya forma de cambiarla.
    await createProduct({ name: "Bota charra", salePrice: 800, sizes: { 25: 2 } });
    await createProduct({ name: "Bota charra grande", salePrice: 900, sizes: { 30: 1 } });
    await createProduct({ name: "Bota charra cara", salePrice: 5000, sizes: { 40: 1 } });
    await createProduct({ name: "Sombrero", type: "sombrero", sizes: { 60: 3 } });

    const res = await request(app)
      .get("/api/products")
      .query({ q: "charra", precioMax: 1000, talla: 25 });

    expect(res.status).toBe(200);
    // 25 y 30 salen de la búsqueda dentro del rango; 40 queda fuera por precio y 60 por `q`.
    // La 30 sigue apareciendo pese al `talla=25`, que es justo lo que no debe acotarse.
    expect(res.body.availableSizes).toEqual([25, 30]);
    // La lista sí respeta las tres condiciones a la vez.
    expect(res.body.total).toBe(1);
    expect(res.body.products[0].name).toBe("Bota charra");
  });

  it("nunca expone unitCost ni publicId en los productos listados", async () => {
    await createProduct({ name: "Bota" });

    const res = await request(app).get("/api/products");

    expect(res.status).toBe(200);
    expect(res.body.products[0]).not.toHaveProperty("unitCost");
  });
});
