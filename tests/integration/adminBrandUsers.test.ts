import request from "supertest";

/**
 * Igual que tests/integration/adminProducts.test.ts (Parte 8): el logo de marca pasa por
 * `image.service.ts` → Cloudinary real si no se mockea. Se reemplaza `src/config/cloudinary`
 * completo con el mismo builder reutilizable.
 */
import { buildCloudinaryMock, resetCloudinaryMock } from "../setup/mocks/cloudinary";

const cloudinaryMock = buildCloudinaryMock();
jest.mock("../../src/config/cloudinary", () => ({
  cloudinary: cloudinaryMock,
  CLOUDINARY_PRODUCTS_FOLDER: "botasdonchuy/products",
  CLOUDINARY_BRAND_FOLDER: "botasdonchuy/brand",
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser, signToken } from "../setup/factories";
import { AdminUser } from "../../src/models/AdminUser";
import { BrandSettings } from "../../src/models/BrandSettings";

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

beforeEach(() => {
  resetCloudinaryMock(cloudinaryMock);
});

const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("GET/PUT /api/admin/brand", () => {
  it("GET es público (sin JWT) y crea la fila con defaults si no existía", async () => {
    const res = await request(app).get("/api/admin/brand");

    expect(res.status).toBe(200);
    expect(res.body.brandName).toBe("Botas Don Chuy Outlet");

    const row = await BrandSettings.findByPk(1);
    expect(row).not.toBeNull();
  });

  it("PUT sin JWT → 401", async () => {
    const res = await request(app).put("/api/admin/brand").send({ brandName: "Nueva marca" });
    expect(res.status).toBe(401);
  });

  it("PUT con JWT actualiza el campo enviado", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    const res = await request(app)
      .put("/api/admin/brand")
      .set("Authorization", `Bearer ${token}`)
      .send({ brandName: "Nueva marca" });

    expect(res.status).toBe(200);
    expect(res.body.brandName).toBe("Nueva marca");
  });
});

describe("POST/DELETE /api/admin/brand/logo", () => {
  it("POST sube el logo nuevo y destruye el anterior solo DESPUÉS de persistir el nuevo", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    const first = await request(app)
      .post("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", pngBuffer, { filename: "logo1.png", contentType: "image/png" });
    expect(first.status).toBe(200);
    const firstPublicId = (await BrandSettings.findByPk(1))!.logoPublicId;
    expect(firstPublicId).toBeTruthy();

    const second = await request(app)
      .post("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", pngBuffer, { filename: "logo2.png", contentType: "image/png" });

    expect(second.status).toBe(200);
    const settings = await BrandSettings.findByPk(1);
    expect(settings!.logoPublicId).not.toBe(firstPublicId);
    expect(settings!.logoUrl).toBe(second.body.logoUrl);

    // El anterior se destruye best-effort, con el publicId viejo.
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(firstPublicId, expect.anything());
  });

  it("un destroy que rechaza (Cloudinary caído) no revierte el logo nuevo ya persistido", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    await request(app)
      .post("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", pngBuffer, { filename: "logo1.png", contentType: "image/png" });

    cloudinaryMock.uploader.destroy.mockRejectedValueOnce(new Error("cloudinary down"));

    const second = await request(app)
      .post("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", pngBuffer, { filename: "logo2.png", contentType: "image/png" });

    expect(second.status).toBe(200);
    const settings = await BrandSettings.findByPk(1);
    expect(settings!.logoUrl).toBe(second.body.logoUrl);
  });

  it("DELETE quita el logo en BD y lo destruye best-effort en Cloudinary", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    await request(app)
      .post("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", pngBuffer, { filename: "logo1.png", contentType: "image/png" });
    const publicId = (await BrandSettings.findByPk(1))!.logoPublicId;

    const res = await request(app)
      .delete("/api/admin/brand/logo")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBeNull();
    const settings = await BrandSettings.findByPk(1);
    expect(settings!.logoUrl).toBeNull();
    expect(settings!.logoPublicId).toBeNull();
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(publicId, expect.anything());
  });
});

describe("POST /api/admin/users", () => {
  it("email duplicado → 409 pre-chequeado", async () => {
    const { user } = await createAdminUser({ email: "dup@test.com" });
    const token = signToken(user);

    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Otro admin", email: "dup@test.com", tempPassword: "Password1!" });

    expect(res.status).toBe(409);
  });

  it("tempPassword sin complejidad suficiente → 400", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    const res = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nuevo admin", email: "nuevo@test.com", tempPassword: "weak" });

    expect(res.status).toBe(400);
  });

  it("crea el usuario y la contraseña temporal cumple la misma complejidad de loginSchema (login funciona)", async () => {
    const { user } = await createAdminUser();
    const token = signToken(user);

    const create = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nuevo admin", email: "nuevo@test.com", tempPassword: "Password1!" });

    expect(create.status).toBe(201);
    expect(create.body.passwordHash).toBeUndefined();

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "nuevo@test.com", password: "Password1!" });
    expect(login.status).toBe(200);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  it("400 si el caller se borra a sí mismo", async () => {
    const { user: owner1 } = await createAdminUser({ role: "owner" });
    await createAdminUser({ role: "owner" });
    const token = signToken(owner1);

    const res = await request(app)
      .delete(`/api/admin/users/${owner1.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("400 si el target es el único owner restante", async () => {
    const { user: caller } = await createAdminUser({ role: "admin" });
    const { user: onlyOwner } = await createAdminUser({ role: "owner" });
    const token = signToken(caller);

    const res = await request(app)
      .delete(`/api/admin/users/${onlyOwner.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    const stillThere = await AdminUser.findByPk(onlyOwner.id);
    expect(stillThere).not.toBeNull();
  });

  it("borra un admin normal sin problema (200)", async () => {
    const { user: caller } = await createAdminUser({ role: "owner" });
    const { user: target } = await createAdminUser({ role: "admin" });
    const token = signToken(caller);

    const res = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await AdminUser.findByPk(target.id)).toBeNull();
  });

  it("dos deletes concurrentes a dos owners distintos no dejan el panel en cero (FOR UPDATE)", async () => {
    const { user: caller } = await createAdminUser({ role: "admin" });
    const { user: ownerA } = await createAdminUser({ role: "owner" });
    const { user: ownerB } = await createAdminUser({ role: "owner" });
    const token = signToken(caller);

    const [resA, resB] = await Promise.all([
      request(app).delete(`/api/admin/users/${ownerA.id}`).set("Authorization", `Bearer ${token}`),
      request(app).delete(`/api/admin/users/${ownerB.id}`).set("Authorization", `Bearer ${token}`),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Uno debe pasar (queda un owner) y el otro debe fallar con 400 (dejaría el panel en 0).
    expect(statuses).toEqual([200, 400]);

    const remainingOwners = await AdminUser.count({ where: { role: "owner" } });
    expect(remainingOwners).toBe(1);
  });
});

describe("PUT /api/admin/account", () => {
  it("requiere currentPassword incluso para un cambio solo de email, y la verifica", async () => {
    const { user, password } = await createAdminUser();
    const token = signToken(user);

    const wrongPassword = await request(app)
      .put("/api/admin/account")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "WrongPass1!", email: "nuevo-correo@test.com" });
    expect(wrongPassword.status).toBe(401);

    const ok = await request(app)
      .put("/api/admin/account")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: password, email: "nuevo-correo@test.com" });
    expect(ok.status).toBe(200);

    const reloaded = await AdminUser.findByPk(user.id);
    expect(reloaded!.email).toBe("nuevo-correo@test.com");
  });

  it("un email duplicado → 409 pre-chequeado", async () => {
    const { password: _p1 } = await createAdminUser({ email: "taken@test.com" });
    const { user, password } = await createAdminUser();
    const token = signToken(user);

    const res = await request(app)
      .put("/api/admin/account")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: password, email: "taken@test.com" });

    expect(res.status).toBe(409);
  });
});
