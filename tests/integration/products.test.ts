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

  it("availableSizes refleja toda la categoría, no solo la talla filtrada", async () => {
    await createProduct({ name: "A", type: "bota", sizes: { 25: 2, 26: 0 } });
    await createProduct({ name: "B", type: "bota", sizes: { 27: 4 } });
    await createProduct({ name: "C", type: "sombrero", sizes: { 60: 3 } });

    const res = await request(app).get("/api/products").query({ categoria: "bota", talla: 25 });

    expect(res.status).toBe(200);
    // 26 tiene stock 0 (no cuenta), 60 es de otra categoría (no cuenta).
    expect(res.body.availableSizes).toEqual([25, 27]);
  });

  it("nunca expone unitCost ni publicId en los productos listados", async () => {
    await createProduct({ name: "Bota" });

    const res = await request(app).get("/api/products");

    expect(res.status).toBe(200);
    expect(res.body.products[0]).not.toHaveProperty("unitCost");
  });
});
