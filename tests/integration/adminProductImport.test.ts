import request from "supertest";
import ExcelJS from "exceljs";
import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, createProduct, signToken } from "../setup/factories";
import { Product } from "../../src/models/Product";
import { ProductSize } from "../../src/models/ProductSize";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

let token: string;

beforeEach(async () => {
  const { user } = await createAdminUser();
  token = signToken(user);
});

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const HEADERS = [
  "Código",
  "Nombre",
  "Categoría",
  "Descripción",
  "Precio original",
  "Precio oferta",
  "Costo unitario",
  "Tallas",
  "Peso (kg)",
  "Largo (cm)",
  "Ancho (cm)",
  "Alto (cm)",
  "Visible",
] as const;

type HeaderKey = (typeof HEADERS)[number];
type RowInput = Partial<Record<HeaderKey, string | number | boolean>>;

function buildRow(fields: RowInput): (string | number | boolean | undefined)[] {
  return HEADERS.map((h) => fields[h]);
}

async function buildWorkbookBuffer(
  headers: readonly string[],
  rows: (string | number | boolean | undefined)[][],
  mutate?: (sheet: ExcelJS.Worksheet) => void,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Productos");
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow(row);
  mutate?.(sheet);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/** Fila válida "de fila nueva": trae todos los campos requeridos para crear. */
function fullNewProductRow(overrides: RowInput = {}): RowInput {
  return {
    Categoría: "bota",
    "Precio original": 1000,
    "Precio oferta": 800,
    "Costo unitario": 400,
    Tallas: "25,26",
    "Peso (kg)": 1.5,
    "Largo (cm)": 30,
    "Ancho (cm)": 20,
    "Alto (cm)": 15,
    ...overrides,
  };
}

const previewUrl = "/api/admin/products/import/preview";
const commitUrl = "/api/admin/products/import";

const preview = (buffer: Buffer) =>
  request(app)
    .post(previewUrl)
    .set("Authorization", `Bearer ${token}`)
    .attach("file", buffer, { filename: "import.xlsx", contentType: XLSX_MIME_TYPE });

const commit = (rows: unknown[]) =>
  request(app).post(commitUrl).set("Authorization", `Bearer ${token}`).send({ rows });

/** Flujo completo: previsualiza y confirma todas las filas aplicables. */
async function importFile(buffer: Buffer) {
  const previewRes = await preview(buffer);
  if (previewRes.status !== 200) return { previewRes, commitRes: null };
  const rows = previewRes.body.rows
    .filter((r: { action: string }) => r.action !== "error")
    .map((r: { input: unknown }) => r.input);
  const commitRes = rows.length > 0 ? await commit(rows) : null;
  return { previewRes, commitRes };
}

describe("importación de productos — auth", () => {
  it("preview sin token → 401", async () => {
    expect((await request(app).post(previewUrl)).status).toBe(401);
  });

  it("confirmación sin token → 401", async () => {
    expect((await request(app).post(commitUrl).send({ rows: [] })).status).toBe(401);
  });
});

describe("preview — no escribe nada", () => {
  it("previsualizar un alta no crea el producto", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Código: "BTA-100", Nombre: "Bota nueva" })),
    ]);

    const res = await preview(buffer);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 1, created: 1, updated: 0, unchanged: 0, failed: 0 });
    expect(res.body.rows[0]).toMatchObject({ row: 2, action: "create", before: null });
    expect(res.body.rows[0].after).toMatchObject({ id: null, code: "BTA-100", name: "Bota nueva" });
    expect(await Product.count()).toBe(0);
  });

  it("muestra el diff viejo vs nuevo y el stock sumado por talla", async () => {
    const existing = await createProduct({
      code: "BTA-1",
      name: "Bota vieja",
      salePrice: 800,
      sizes: { 25: 3 },
    } as any);

    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow({ Código: "BTA-1", "Precio oferta": 750, Tallas: "25x2, 26x4" }),
    ]);

    const res = await preview(buffer);
    const row = res.body.rows[0];

    expect(row.action).toBe("update");
    expect(row.productId).toBe(existing.id);
    expect(row.before).toMatchObject({ salePrice: 800, stock: 3 });
    expect(row.after).toMatchObject({ salePrice: 750, stock: 9 });
    expect(row.changes).toEqual([
      { field: "salePrice", label: "Precio oferta", before: 800, after: 750 },
    ]);
    expect(row.sizeChanges).toEqual([
      { size: 25, before: 3, added: 2, after: 5 },
      { size: 26, before: 0, added: 4, after: 4 },
    ]);

    // Nada se escribió todavía.
    const reloaded = await Product.findByPk(existing.id);
    expect(reloaded!.salePrice).toBe(800);
  });

  it("proyecta las filas del mismo archivo entre sí (fila 2 crea, fila 3 restockea)", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Código: "BTA-SEQ", Nombre: "Bota secuencial", Tallas: "25x2" })),
      buildRow({ Código: "BTA-SEQ", Tallas: "25" }),
    ]);

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("create");
    // Sin el overlay, esta fila se vería como una segunda alta del mismo código.
    expect(res.body.rows[1].action).toBe("update");
    expect(res.body.rows[1].after.stock).toBe(3);
  });

  it("marca como `unchanged` una fila que no cambia nada", async () => {
    await createProduct({ code: "BTA-IG", salePrice: 800 } as any);
    const buffer = await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "BTA-IG", "Precio oferta": 800 })]);

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("unchanged");
    expect(res.body.summary.unchanged).toBe(1);
    expect(res.body.rows[0].warnings.join(" ")).toMatch(/no cambia nada/i);
  });
});

describe("confirmación — aplica lo revisado", () => {
  it("crea un producto nuevo vía código", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Código: "BTA-100", Nombre: "Bota nueva vía código" })),
    ]);

    const { commitRes } = await importFile(buffer);

    expect(commitRes!.status).toBe(200);
    expect(commitRes!.body.summary).toMatchObject({ total: 1, created: 1, failed: 0 });

    const product = await Product.findOne({ where: { code: "BTA-100" } });
    expect(product).not.toBeNull();
    const sizes = await ProductSize.findAll({ where: { productId: product!.id }, order: [["size", "ASC"]] });
    expect(sizes.map((s) => ({ size: s.size, stock: s.stock }))).toEqual([
      { size: 25, stock: 1 },
      { size: 26, stock: 1 },
    ]);
  });

  it("aplica las ediciones que hizo el dueño, no lo que traía el archivo", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Nombre del archivo", "Precio oferta": 800 })),
    ]);

    const previewRes = await preview(buffer);
    const edited = { ...previewRes.body.rows[0].input, name: "Nombre corregido", salePrice: 700 };
    const commitRes = await commit([edited]);

    expect(commitRes.status).toBe(200);
    const product = await Product.findOne({ where: { name: "Nombre corregido" } });
    expect(product!.salePrice).toBe(700);
    expect(await Product.findOne({ where: { name: "Nombre del archivo" } })).toBeNull();
  });

  it("restockea SUMANDO al stock previo, sin reemplazarlo", async () => {
    const existing = await createProduct({ code: "BTA-1", sizes: { 25: 3 } } as any);

    const { commitRes } = await importFile(
      await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "BTA-1", Tallas: "25,26" })]),
    );

    expect(commitRes!.body.summary).toMatchObject({ total: 1, created: 0, updated: 1, failed: 0 });
    const sizes = await ProductSize.findAll({ where: { productId: existing.id }, order: [["size", "ASC"]] });
    expect(sizes.map((s) => ({ size: s.size, stock: s.stock }))).toEqual([
      { size: 25, stock: 4 },
      { size: 26, stock: 1 },
    ]);
  });

  it('la notación "26x20" restockea 20 piezas de la talla 26', async () => {
    const existing = await createProduct({ code: "BTA-X", sizes: { 26: 2 } } as any);

    await importFile(await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "BTA-X", Tallas: "26x20, 27x5" })]));

    const sizes = await ProductSize.findAll({ where: { productId: existing.id }, order: [["size", "ASC"]] });
    expect(sizes.map((s) => ({ size: s.size, stock: s.stock }))).toEqual([
      { size: 26, stock: 22 },
      { size: 27, stock: 5 },
    ]);
  });

  it("restockea por nombre exacto insensible a mayúsculas cuando la fila no trae código", async () => {
    const existing = await createProduct({ name: "Sombrero Texano", sizes: { 27: 2 } } as any);

    const { commitRes } = await importFile(
      await buildWorkbookBuffer(HEADERS, [buildRow({ Nombre: "SOMBRERO TEXANO", Tallas: "27" })]),
    );

    expect(commitRes!.body.rows[0].status).toBe("updated");
    const sizes = await ProductSize.findAll({ where: { productId: existing.id } });
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toMatchObject({ size: 27, stock: 3 });
  });

  it("no blanquea columnas ausentes en la fila", async () => {
    const existing = await createProduct({
      code: "BTA-2",
      visible: false,
      description: "descripción original",
      sizes: { 25: 1 },
    } as any);

    await importFile(await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "BTA-2", Tallas: "25" })]));

    const reloaded = await Product.findByPk(existing.id);
    expect(reloaded!.visible).toBe(false);
    expect(reloaded!.description).toBe("descripción original");
  });

  it("reactiva un producto descontinuado que hace match", async () => {
    const existing = await createProduct({ code: "BTA-3", sizes: { 25: 2 } } as any);
    await existing.update({ deletedAt: new Date(), visible: false });

    const { previewRes, commitRes } = await importFile(
      await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "BTA-3", Tallas: "25" })]),
    );

    expect(previewRes.body.rows[0].reactivated).toBe(true);
    expect(previewRes.body.rows[0].before.discontinued).toBe(true);
    expect(previewRes.body.rows[0].after.discontinued).toBe(false);
    expect(commitRes!.body.rows[0].message).toMatch(/reactivado/i);

    const reloaded = await Product.findByPk(existing.id, { paranoid: false });
    expect(reloaded!.deletedAt).toBeNull();
    expect(reloaded!.visible).toBe(true);
    expect((await ProductSize.findAll({ where: { productId: existing.id } }))[0]).toMatchObject({
      size: 25,
      stock: 3,
    });
  });

  it("una fila inválida se reporta como error sin bloquear las válidas (éxito parcial)", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Producto válido" })),
      buildRow(fullNewProductRow({ Nombre: "Producto precio inválido", "Precio oferta": 2000 })),
    ]);

    const previewRes = await preview(buffer);

    expect(previewRes.body.summary).toEqual({ total: 2, created: 1, updated: 0, unchanged: 0, failed: 1 });
    expect(previewRes.body.rows[1]).toMatchObject({ row: 3, action: "error" });
    expect(previewRes.body.rows[1].message).toMatch(/Fila 3:.*precio de oferta/i);

    // El dueño confirma solo la fila buena.
    await commit([previewRes.body.rows[0].input]);
    const products = await Product.findAll();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Producto válido");
  });

  it("filas secuenciales sobre el mismo código nuevo: la 2ª restockea lo que creó la 1ª", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Código: "BTA-SEQ", Nombre: "Bota secuencial", Tallas: "25,25" })),
      buildRow({ Código: "BTA-SEQ", Tallas: "25" }),
    ]);

    const { commitRes } = await importFile(buffer);

    expect(commitRes!.body.rows[0]).toMatchObject({ row: 2, status: "created" });
    expect(commitRes!.body.rows[1]).toMatchObject({ row: 3, status: "updated" });

    const products = await Product.findAll({ where: { code: "BTA-SEQ" } });
    expect(products).toHaveLength(1);
    const sizes = await ProductSize.findAll({ where: { productId: products[0].id } });
    expect(sizes[0]).toMatchObject({ size: 25, stock: 3 }); // 2 de la fila 1 + 1 de la fila 2
  });

  it("dos peticiones concurrentes con el mismo código nuevo: una crea, la otra reporta duplicado", async () => {
    const rowA = { row: 2, code: "BTA-RACE", name: "Bota carrera A", type: "bota", originalPrice: 1000, salePrice: 800, unitCost: 400, sizes: "25", weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 };
    const rowB = { ...rowA, name: "Bota carrera B" };

    const [resA, resB] = await Promise.all([commit([rowA]), commit([rowB])]);

    const statuses = [resA.body.rows[0].status, resB.body.rows[0].status].sort();
    expect(statuses).toEqual(["created", "error"]);
    expect(await Product.count({ where: { code: "BTA-RACE" } })).toBe(1);
  });
});

// ── Regresiones: cada uno de estos casos antes se aplicaba o se descartaba en silencio ────────

describe("celdas que no se pueden leer → la fila falla en vez de reportarse como aplicada", () => {
  it("una celda con fórmula sin resultado calculado no se ignora en silencio", async () => {
    const existing = await createProduct({ code: "F-1", salePrice: 800 } as any);
    const buffer = await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "F-1" })], (sheet) => {
      sheet.getRow(2).getCell(6).value = { formula: "1000*0.5" } as never;
    });

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].message).toMatch(/Precio oferta.*fórmula/i);
    expect((await Product.findByPk(existing.id))!.salePrice).toBe(800);
  });

  it("una fórmula CON resultado calculado sí se lee", async () => {
    await createProduct({ code: "F-2", salePrice: 800 } as any);
    const buffer = await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "F-2" })], (sheet) => {
      sheet.getRow(2).getCell(6).value = { formula: "1000*0.5", result: 500 } as never;
    });

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("update");
    expect(res.body.rows[0].after.salePrice).toBe(500);
  });

  it("una celda con error de Excel (#REF!) falla la fila", async () => {
    await createProduct({ code: "F-3" } as any);
    const buffer = await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "F-3" })], (sheet) => {
      sheet.getRow(2).getCell(5).value = { error: "#REF!" } as never;
    });

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].message).toMatch(/#REF!/);
  });

  it("texto con formato mixto (richText) se lee como texto, no como [object Object]", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [buildRow(fullNewProductRow({}))], (sheet) => {
      sheet.getRow(2).getCell(2).value = {
        richText: [{ text: "Bota " }, { text: "Roja" }],
      } as never;
    });

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("create");
    expect(res.body.rows[0].after.name).toBe("Bota Roja");
  });

  it("un valor no reconocido en Visible falla la fila en vez de asumir Sí", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Visible raro", Visible: "quizá" })),
    ]);

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].message).toMatch(/Visible/i);
  });
});

describe("columnas no reconocidas", () => {
  it("se reportan como aviso del archivo en vez de descartarse en silencio", async () => {
    await createProduct({ code: "C-1", salePrice: 800 } as any);
    const buffer = await buildWorkbookBuffer(["Código", "Precio de lista", "Proveedor"], [["C-1", 1200, "Acme"]]);

    const res = await preview(buffer);

    expect(res.body.warnings.join(" ")).toMatch(/"Proveedor"/);
    expect(res.body.warnings.join(" ")).toMatch(/no se reconocieron/i);
    // La columna que sí se reconoce se aplica.
    expect(res.body.rows[0].changes).toEqual([
      { field: "originalPrice", label: "Precio original", before: 1000, after: 1200 },
    ]);
  });

  it("dos columnas que significan lo mismo → 400 en vez de que gane una al azar", async () => {
    const buffer = await buildWorkbookBuffer(["Código", "Precio oferta", "Precio de oferta"], [["C-1", 700, 900]]);

    const res = await preview(buffer);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/columnas repetidas/i);
  });
});

describe("emparejamiento por nombre", () => {
  it("un nombre con % no empareja por comodín ni renombra otro producto", async () => {
    const existing = await createProduct({ name: "Bota Roja Premium", code: null } as any);
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Bota%Premium" })),
    ]);

    const { commitRes } = await importFile(buffer);

    expect(commitRes!.body.rows[0].status).toBe("created");
    expect((await Product.findByPk(existing.id))!.name).toBe("Bota Roja Premium");
    expect(await Product.count()).toBe(2);
  });

  it("un nombre que empareja con dos productos es ambiguo → error pidiendo código", async () => {
    await createProduct({ name: "Bota Gemela", code: "G-1" } as any);
    await createProduct({ name: "bota gemela", code: "G-2" } as any);

    const res = await preview(
      await buildWorkbookBuffer(HEADERS, [buildRow({ Nombre: "Bota Gemela", Tallas: "25" })]),
    );

    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].message).toMatch(/2 productos.*Código/is);
  });

  it("un código que solo difiere en mayúsculas empareja pero no reescribe el guardado", async () => {
    const existing = await createProduct({ code: "BTA-9" } as any);

    const { previewRes } = await importFile(
      await buildWorkbookBuffer(HEADERS, [buildRow({ Código: "bta-9", Tallas: "25" })]),
    );

    expect(previewRes.body.rows[0].action).toBe("update");
    expect(previewRes.body.rows[0].warnings.join(" ")).toMatch(/solo difiere en mayúsculas/i);
    expect((await Product.findByPk(existing.id))!.code).toBe("BTA-9");
  });
});

describe("mensajes de error por fila", () => {
  it("reporta hasta 3 campos faltantes, no solo el primero", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow({ Nombre: "Producto incompleto", Categoría: "bota", Tallas: "25" }),
    ]);

    const message = (await preview(buffer)).body.rows[0].message;

    expect(message).toMatch(/precio original/i);
    expect(message.split("·").length).toBeGreaterThanOrEqual(3);
    expect(message).toMatch(/campos más por corregir/i);
  });
});

describe("números", () => {
  it('"1,5" se lee como 1.5 y avisa, en vez de convertirse en 15', async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Peso con coma", "Peso (kg)": "1,5" })),
    ]);

    const res = await preview(buffer);

    expect(res.body.rows[0].after.weightKg).toBe(1.5);
    expect(res.body.rows[0].warnings.join(" ")).toMatch(/Peso.*1\.5/i);
  });

  it('"1,234.50" se lee como 1234.5 (separador de miles)', async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Precio con miles", "Precio original": "1,234.50" })),
    ]);

    expect((await preview(buffer)).body.rows[0].after.originalPrice).toBe(1234.5);
  });
});

describe("tallas", () => {
  it("una talla fuera de rango falla la fila", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Talla enorme", Tallas: "99999999" })),
    ]);

    const res = await preview(buffer);

    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].message).toMatch(/fuera de rango/i);
  });

  it("una cantidad absurda falla la fila", async () => {
    const buffer = await buildWorkbookBuffer(HEADERS, [
      buildRow(fullNewProductRow({ Nombre: "Cantidad absurda", Tallas: "26x999999" })),
    ]);

    expect((await preview(buffer)).body.rows[0].action).toBe("error");
  });
});

describe("doble envío de la confirmación", () => {
  it("mandar el mismo lote dos veces → 409, el stock no se duplica", async () => {
    const existing = await createProduct({ code: "E-1", sizes: { 25: 0 } } as any);
    const rows = [{ row: 2, code: "E-1", sizes: "25x3" }];

    const first = await commit(rows);
    const second = await commit(rows);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/ya se acaba de aplicar|duplicaría/i);

    const sizes = await ProductSize.findAll({ where: { productId: existing.id } });
    expect(sizes[0]).toMatchObject({ size: 25, stock: 3 });
  });
});

describe("validaciones de archivo y de body", () => {
  it("archivo con solo encabezado → resumen en cero, 200", async () => {
    const res = await preview(await buildWorkbookBuffer(HEADERS, []));

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 });
  });

  it("sin columna Código ni Nombre → 400 antes de procesar cualquier fila", async () => {
    const headersWithoutId = HEADERS.filter((h) => h !== "Código" && h !== "Nombre");
    const res = await preview(await buildWorkbookBuffer(headersWithoutId, []));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/código.*nombre/i);
  });

  it("tipo de archivo incorrecto (.png) → 400", async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await request(app)
      .post(previewUrl)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pngBuffer, { filename: "no-es-excel.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/excel/i);
  });

  it("un .xlsx corrupto → 400 accionable, no un 500", async () => {
    const res = await preview(Buffer.from("no soy un zip válido"));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no se pudo leer el archivo/i);
  });

  it("archivo mayor a 2 MB → 400 con el mensaje correcto (no el de 5 MB de imágenes)", async () => {
    const res = await preview(Buffer.alloc(3 * 1024 * 1024, 0));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/2 MB/);
    expect(res.body.message).not.toMatch(/5 MB/);
  });

  it("un archivo con más de 500 filas se rechaza en vez de colgar la petición", async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      buildRow(fullNewProductRow({ Nombre: `Producto ${i}` })),
    );

    const res = await preview(await buildWorkbookBuffer(HEADERS, rows));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/máximo por importación es 500/i);
  });

  it("la confirmación rechaza claves desconocidas en vez de descartarlas", async () => {
    const res = await commit([{ row: 2, code: "X-1", precioOferta: 700 }]);

    expect(res.status).toBe(400);
  });

  it("la confirmación con rows vacío → 400", async () => {
    expect((await commit([])).status).toBe(400);
  });
});

describe("PUT /api/admin/products/:id — regresión del default de `visible`", () => {
  it("un PUT que solo cambia el nombre no reactiva un producto oculto", async () => {
    const product = await createProduct({ visible: false } as any);

    const res = await request(app)
      .put(`/api/admin/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Solo cambio el nombre" });

    expect(res.status).toBe(200);
    const reloaded = await Product.findByPk(product.id);
    expect(reloaded!.name).toBe("Solo cambio el nombre");
    expect(reloaded!.visible).toBe(false);
  });
});
