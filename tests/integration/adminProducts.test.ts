import request from "supertest";

/**
 * `image.service.ts` llamaría a Cloudinary de verdad (subida/borrado real) si no se
 * mockea — ver el roadmap, Parte 8. Se reemplaza el módulo `src/config/cloudinary`
 * completo (no `image.service.ts`) para ejercitar el mismo contrato que el código real
 * usa (`uploader.upload_stream`/`uploader.destroy`), igual que documenta
 * tests/setup/mocks/cloudinary.ts.
 */
import { buildCloudinaryMock, resetCloudinaryMock, failNextUpload } from "../setup/mocks/cloudinary";

const cloudinaryMock = buildCloudinaryMock();
jest.mock("../../src/config/cloudinary", () => ({
  cloudinary: cloudinaryMock,
  CLOUDINARY_PRODUCTS_FOLDER: "botasdonchuy/products",
  CLOUDINARY_BRAND_FOLDER: "botasdonchuy/brand",
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createProduct, createOrder, createOrderItem, signToken } from "../setup/factories";
import { Product } from "../../src/models/Product";
import { ProductSize } from "../../src/models/ProductSize";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

let token: string;

beforeEach(async () => {
  resetCloudinaryMock(cloudinaryMock);
  const { user } = await createAdminUser();
  token = signToken(user);
});

const authed = () => request(app).post("/api/admin/products").set("Authorization", `Bearer ${token}`);

const validProductBody = {
  name: "Bota de prueba",
  originalPrice: 1000,
  salePrice: 800,
  unitCost: 400,
  type: "bota" as const,
  weightKg: 1.5,
  lengthCm: 30,
  widthCm: 20,
  heightCm: 15,
};

const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("adminCreateProduct / adminUpdateProduct — sizes string vs array", () => {
  it("sizes como string \"25,25,26\" agrupa repeticiones en filas ProductSize", async () => {
    const res = await authed().send({ ...validProductBody, sizes: "25,25,26" });

    expect(res.status).toBe(201);

    const rows = await ProductSize.findAll({
      where: { productId: res.body.id },
      order: [["size", "ASC"]],
    });
    expect(rows.map((r) => ({ size: r.size, stock: r.stock }))).toEqual([
      { size: 25, stock: 2 },
      { size: 26, stock: 1 },
    ]);
  });

  it("sizes como array de números también agrupa repeticiones", async () => {
    const res = await authed().send({ ...validProductBody, sizes: [27, 27, 27] });

    expect(res.status).toBe(201);

    const rows = await ProductSize.findAll({ where: { productId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 27, stock: 3 });
  });

  it("adminUpdateProduct con sizes reemplaza por completo las filas anteriores", async () => {
    const created = await authed().send({ ...validProductBody, sizes: "25,26" });
    const productId = created.body.id;

    const res = await request(app)
      .put(`/api/admin/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sizes: [30, 30] });

    expect(res.status).toBe(200);

    const rows = await ProductSize.findAll({ where: { productId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 30, stock: 2 });
  });
});

describe("adminCreateProduct / adminUpdateProduct — hasSizes (existencia manual sin tallas)", () => {
  it("hasSizes:false con stockQuantity crea una sola ProductSize con el centinela", async () => {
    const res = await authed().send({
      ...validProductBody,
      hasSizes: false,
      stockQuantity: 12,
    });

    expect(res.status).toBe(201);
    expect(res.body.hasSizes).toBe(false);
    expect(res.body.stock).toBe(12);

    const rows = await ProductSize.findAll({ where: { productId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 0, stock: 12 });
  });

  it("hasSizes:true (default) sin sizes → 400", async () => {
    const res = await authed().send({ ...validProductBody });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/talla/i);
  });

  it("hasSizes:false sin stockQuantity → 400", async () => {
    const res = await authed().send({ ...validProductBody, hasSizes: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cantidad en existencia/i);
  });

  it("hasSizes:true con stockQuantity (contradicción) → 400", async () => {
    const res = await authed().send({
      ...validProductBody,
      sizes: "25,26",
      stockQuantity: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maneja tallas/i);
  });

  it("hasSizes:false con sizes (contradicción) → 400", async () => {
    const res = await authed().send({
      ...validProductBody,
      hasSizes: false,
      stockQuantity: 5,
      sizes: "25,26",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no maneja tallas/i);
  });

  it("PUT cambia de hasSizes:true a false con stockQuantity → reemplaza las filas por el centinela", async () => {
    const created = await authed().send({ ...validProductBody, sizes: "25,26" });
    const productId = created.body.id;

    const res = await request(app)
      .put(`/api/admin/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ hasSizes: false, stockQuantity: 7 });

    expect(res.status).toBe(200);
    expect(res.body.hasSizes).toBe(false);

    const rows = await ProductSize.findAll({ where: { productId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 0, stock: 7 });
  });

  it("PUT cambia de hasSizes:true a false SIN stockQuantity → 400, no toca nada", async () => {
    const created = await authed().send({ ...validProductBody, sizes: "25,26" });
    const productId = created.body.id;

    const res = await request(app)
      .put(`/api/admin/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ hasSizes: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cantidad en existencia/i);

    const rows = await ProductSize.findAll({ where: { productId } });
    expect(rows).toHaveLength(2);
  });

  it("PUT cambia de hasSizes:false a true SIN sizes → 400", async () => {
    const created = await authed().send({
      ...validProductBody,
      hasSizes: false,
      stockQuantity: 4,
    });
    const productId = created.body.id;

    const res = await request(app)
      .put(`/api/admin/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ hasSizes: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tallas/i);
  });

  it("PUT solo actualizando stockQuantity de un producto ya sin tallas (sin resituar hasSizes)", async () => {
    const created = await authed().send({
      ...validProductBody,
      hasSizes: false,
      stockQuantity: 4,
    });
    const productId = created.body.id;

    const res = await request(app)
      .put(`/api/admin/products/${productId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stockQuantity: 9 });

    expect(res.status).toBe(200);
    const rows = await ProductSize.findAll({ where: { productId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 0, stock: 9 });
  });

  it("GET /api/products (público) no ofrece talla 0 en availableSizes para un producto sin tallas", async () => {
    await authed().send({ ...validProductBody, hasSizes: false, stockQuantity: 3, visible: true });

    const res = await request(app).get("/api/products");

    expect(res.status).toBe(200);
    expect(res.body.availableSizes).not.toContain(0);
  });
});

describe("DELETE /api/admin/products/:id", () => {
  it("soft-delete cuando el producto está referenciado por un OrderItem (conserva imágenes)", async () => {
    const product = await createProduct({
      images: [{ url: "https://cloudinary.test/a.jpg", publicId: "pub_a" }],
    } as any);
    const order = await createOrder();
    await createOrderItem(order.id, product);

    const res = await request(app)
      .delete(`/api/admin/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, softDeleted: true });

    const reloaded = await Product.findByPk(product.id, { paranoid: false });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.visible).toBe(false);
    expect(reloaded!.deletedAt).not.toBeNull();
    expect(reloaded!.images).toHaveLength(1);
    expect(cloudinaryMock.uploader.destroy).not.toHaveBeenCalled();
  });

  it("hard-delete cuando no hay OrderItem — borra la fila, cascada de ProductSize y sus imágenes de Cloudinary", async () => {
    const product = await createProduct({
      images: [
        { url: "https://cloudinary.test/a.jpg", publicId: "pub_a" },
        { url: "https://cloudinary.test/b.jpg", publicId: "pub_b" },
      ],
    } as any);

    const res = await request(app)
      .delete(`/api/admin/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, softDeleted: false });

    const reloaded = await Product.findByPk(product.id);
    expect(reloaded).toBeNull();

    const sizeRows = await ProductSize.findAll({ where: { productId: product.id } });
    expect(sizeRows).toHaveLength(0);

    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledTimes(2);
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith("pub_a", expect.anything());
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith("pub_b", expect.anything());
  });
});

describe("POST /api/admin/products/:id/images", () => {
  it("sube 1 imagen y la agrega a la galería", async () => {
    const product = await createProduct();

    const res = await request(app)
      .post(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .attach("images", pngBuffer, { filename: "a.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.images).toHaveLength(1);
    expect(cloudinaryMock.uploader.upload_stream).toHaveBeenCalledTimes(1);
  });

  it("rechaza cuando el total excedería el tope de 3 (chequeo temprano, sin llamar a Cloudinary)", async () => {
    const product = await createProduct({
      images: [
        { url: "https://cloudinary.test/a.jpg", publicId: "pub_a" },
        { url: "https://cloudinary.test/b.jpg", publicId: "pub_b" },
      ],
    } as any);

    const res = await request(app)
      .post(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .attach("images", pngBuffer, { filename: "c.png", contentType: "image/png" })
      .attach("images", pngBuffer, { filename: "d.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/máximo/i);
    expect(cloudinaryMock.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it("dos adds concurrentes que juntos exceden el tope: uno 201, el otro 400 (recheck bajo FOR UPDATE)", async () => {
    const product = await createProduct({
      images: [
        { url: "https://cloudinary.test/a.jpg", publicId: "pub_a" },
        { url: "https://cloudinary.test/b.jpg", publicId: "pub_b" },
      ],
    } as any);

    const [resA, resB] = await Promise.all([
      request(app)
        .post(`/api/admin/products/${product.id}/images`)
        .set("Authorization", `Bearer ${token}`)
        .attach("images", pngBuffer, { filename: "c.png", contentType: "image/png" }),
      request(app)
        .post(`/api/admin/products/${product.id}/images`)
        .set("Authorization", `Bearer ${token}`)
        .attach("images", pngBuffer, { filename: "d.png", contentType: "image/png" }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 400]);

    const reloaded = await Product.findByPk(product.id);
    expect(reloaded!.images).toHaveLength(3);

    // El que perdió la carrera subió a Cloudinary (pasó el chequeo temprano) pero la
    // transacción no persistió: su asset recién subido debe limpiarse.
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledTimes(1);
  });

  it("subida todo-o-nada: si una de varias falla, las que sí subieron se destruyen y nada se persiste", async () => {
    const product = await createProduct();
    failNextUpload(cloudinaryMock, 1); // la 2ª subida de las 2 en este request fallará

    const res = await request(app)
      .post(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .attach("images", pngBuffer, { filename: "a.png", contentType: "image/png" })
      .attach("images", pngBuffer, { filename: "b.png", contentType: "image/png" });

    expect(res.status).toBe(502);

    const reloaded = await Product.findByPk(product.id);
    expect(reloaded!.images).toHaveLength(0);

    // Una subida tuvo éxito antes de que la otra fallara: esa debe destruirse.
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/admin/products/:id/images", () => {
  it("persiste el borrado en BD antes de destruir el asset en Cloudinary (best-effort)", async () => {
    const product = await createProduct({
      images: [
        { url: "https://cloudinary.test/a.jpg", publicId: "pub_a" },
        { url: "https://cloudinary.test/b.jpg", publicId: "pub_b" },
      ],
    } as any);

    const res = await request(app)
      .delete(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .send({ publicId: "pub_a" });

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([{ url: "https://cloudinary.test/b.jpg", publicId: "pub_b" }]);

    const reloaded = await Product.findByPk(product.id);
    expect(reloaded!.images).toHaveLength(1);
    expect(reloaded!.images[0].publicId).toBe("pub_b");
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith("pub_a", expect.anything());
  });

  it("un publicId que ya no está en el producto → 404, sin llamar a destroy", async () => {
    const product = await createProduct({
      images: [{ url: "https://cloudinary.test/a.jpg", publicId: "pub_a" }],
    } as any);

    const res = await request(app)
      .delete(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .send({ publicId: "pub_zzz" });

    expect(res.status).toBe(404);
    expect(cloudinaryMock.uploader.destroy).not.toHaveBeenCalled();
  });

  it("un destroy que rechaza (Cloudinary caído) no revierte el cambio ya persistido en BD", async () => {
    const product = await createProduct({
      images: [{ url: "https://cloudinary.test/a.jpg", publicId: "pub_a" }],
    } as any);
    cloudinaryMock.uploader.destroy.mockRejectedValueOnce(new Error("cloudinary down"));

    const res = await request(app)
      .delete(`/api/admin/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .send({ publicId: "pub_a" });

    expect(res.status).toBe(200);
    const reloaded = await Product.findByPk(product.id);
    expect(reloaded!.images).toHaveLength(0);
  });
});

describe("lecturas públicas — toPublicProduct despoja publicId", () => {
  it("GET /api/products/:id nunca expone publicId", async () => {
    const product = await createProduct({
      images: [{ url: "https://cloudinary.test/a.jpg", publicId: "pub_a" }],
    } as any);

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.images).toEqual([{ url: "https://cloudinary.test/a.jpg" }]);
  });

  it("GET /api/products (listado) tampoco expone publicId", async () => {
    await createProduct({
      images: [{ url: "https://cloudinary.test/a.jpg", publicId: "pub_a" }],
    } as any);

    const res = await request(app).get("/api/products");

    expect(res.status).toBe(200);
    expect(res.body.products[0].images).toEqual([{ url: "https://cloudinary.test/a.jpg" }]);
  });
});
