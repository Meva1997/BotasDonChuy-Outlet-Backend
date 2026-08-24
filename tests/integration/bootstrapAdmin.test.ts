import request from "supertest";

/**
 * Mismo motivo que en `auth.test.ts`: `authRateLimiter` (10 req / 15 min) es una única
 * instancia compartida cuyo store en memoria vive por todo el proceso de Jest. Esta suite
 * hace varios round-trips de login, así que sin el mock el propio limiter reventaría la
 * suite con 429 antes de probar nada.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { bootstrapAdmin, BootstrapError } from "../../src/scripts/bootstrapAdmin";
import { AdminUser } from "../../src/models/AdminUser";
import { Product } from "../../src/models/Product";
import { Order } from "../../src/models/Order";
import { hashPassword } from "../../src/utils/password";

/**
 * Entorno mínimo válido. Se pasa como objeto y no vía `process.env` a propósito: la función
 * acepta el entorno por parámetro justo para poder probarla sin ensuciar el proceso de Jest.
 */
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    BOOTSTRAP_ADMIN_EMAIL: "duenio@botasdonchuy.com",
    BOOTSTRAP_ADMIN_PASSWORD: "Password1!",
    ...overrides,
  };
}

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

describe("bootstrapAdmin — alta del primer usuario", () => {
  it("crea el usuario con rol owner y sin guardar la contraseña en claro", async () => {
    const result = await bootstrapAdmin(env());

    expect(result.action).toBe("created");
    expect(result.email).toBe("duenio@botasdonchuy.com");
    expect(result.role).toBe("owner");

    const row = await AdminUser.findByPk(result.id);
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Admin");
    expect(row!.role).toBe("owner");
    expect(row!.passwordHash).not.toBe("Password1!");
    expect(row!.passwordHash.startsWith("$2")).toBe(true);
  });

  /**
   * La aserción que de verdad importa: es la única que prueba que la cuenta no nació muerta.
   * Si el script validara la contraseña con reglas distintas a las de `loginSchema`, el hash
   * se guardaría bien y el dueño jamás podría entrar al panel. Mismo patrón que
   * `adminBrandUsers.test.ts` usa para `POST /api/admin/users`.
   */
  it("la cuenta creada puede iniciar sesión de verdad (round-trip contra POST /api/auth/login)", async () => {
    await bootstrapAdmin(env());

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "duenio@botasdonchuy.com", password: "Password1!" });

    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe("string");
    expect(login.body.user.email).toBe("duenio@botasdonchuy.com");
    expect(login.body.user.role).toBe("owner");
  });

  it("respeta BOOTSTRAP_ADMIN_NAME y BOOTSTRAP_ADMIN_ROLE cuando se pasan", async () => {
    const result = await bootstrapAdmin(
      env({ BOOTSTRAP_ADMIN_NAME: "Don Chuy", BOOTSTRAP_ADMIN_ROLE: "admin" }),
    );

    expect(result.role).toBe("admin");
    const row = await AdminUser.findByPk(result.id);
    expect(row!.name).toBe("Don Chuy");
  });

  it("hashea la contraseña YA recortada, así que el login funciona con la versión sin espacios", async () => {
    // Un espacio final pegado en el editor de variables de un PaaS: el esquema hace .trim()
    // antes de validar, así que hay que hashear lo que devuelve el parse y no el crudo.
    await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: "Password1!  " }));

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "duenio@botasdonchuy.com", password: "Password1!" });

    expect(login.status).toBe(200);
  });

  it("no toca ninguna otra tabla — a diferencia de pnpm seed", async () => {
    await bootstrapAdmin(env());

    expect(await Product.count()).toBe(0);
    expect(await Order.count()).toBe(0);
    expect(await AdminUser.count()).toBe(1);
  });
});

describe("bootstrapAdmin — entrada inválida", () => {
  it("falla si falta BOOTSTRAP_ADMIN_EMAIL y no crea nada", async () => {
    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_ADMIN_EMAIL: undefined })),
    ).rejects.toThrow(BootstrapError);

    expect(await AdminUser.count()).toBe(0);
  });

  it("falla si falta BOOTSTRAP_ADMIN_PASSWORD y no crea nada", async () => {
    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: undefined })),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);

    expect(await AdminUser.count()).toBe(0);
  });

  it("rechaza un correo inválido con el mensaje en español del esquema", async () => {
    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_ADMIN_EMAIL: "no-es-un-correo" })),
    ).rejects.toThrow(/correo electrónico válido/);

    expect(await AdminUser.count()).toBe(0);
  });

  // Cada rama de complejidad por separado: si alguna se relajara respecto a `loginSchema`,
  // el script crearía una cuenta incapaz de pasar el login.
  it.each([
    ["menos de 8 caracteres", "Pas1!", /al menos 8 caracteres/],
    ["sin mayúscula", "password1!", /al menos una mayúscula/],
    ["sin número", "Password!", /al menos un número/],
    ["sin signo", "Password1", /al menos un signo/],
  ])("rechaza una contraseña %s", async (_caso, password, mensaje) => {
    await expect(bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: password }))).rejects.toThrow(
      mensaje as RegExp,
    );

    expect(await AdminUser.count()).toBe(0);
  });

  it("rechaza un rol que no existe", async () => {
    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_ADMIN_ROLE: "superadmin" })),
    ).rejects.toThrow(BootstrapError);

    expect(await AdminUser.count()).toBe(0);
  });
});

describe("bootstrapAdmin — el correo ya existe", () => {
  it("falla sin BOOTSTRAP_RESET_PASSWORD y deja intacta la contraseña anterior", async () => {
    await bootstrapAdmin(env());
    const before = (await AdminUser.findOne({ where: { email: "duenio@botasdonchuy.com" } }))!;

    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_ADMIN_PASSWORD: "Otra9@Pass" })),
    ).rejects.toThrow(/BOOTSTRAP_RESET_PASSWORD/);

    const after = (await AdminUser.findOne({ where: { email: "duenio@botasdonchuy.com" } }))!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await AdminUser.count()).toBe(1);

    // Y la contraseña original sigue sirviendo.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "duenio@botasdonchuy.com", password: "Password1!" });
    expect(login.status).toBe(200);
  });

  it("no considera 'false' como activación de la bandera", async () => {
    await bootstrapAdmin(env());

    await expect(
      bootstrapAdmin(env({ BOOTSTRAP_RESET_PASSWORD: "false" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("con BOOTSTRAP_RESET_PASSWORD=true reescribe la contraseña sin crear otra fila", async () => {
    await bootstrapAdmin(env());

    const result = await bootstrapAdmin(
      env({ BOOTSTRAP_ADMIN_PASSWORD: "Otra9@Pass", BOOTSTRAP_RESET_PASSWORD: "true" }),
    );

    expect(result.action).toBe("password-reset");
    expect(await AdminUser.count()).toBe(1);

    const nueva = await request(app)
      .post("/api/auth/login")
      .send({ email: "duenio@botasdonchuy.com", password: "Otra9@Pass" });
    expect(nueva.status).toBe(200);

    const vieja = await request(app)
      .post("/api/auth/login")
      .send({ email: "duenio@botasdonchuy.com", password: "Password1!" });
    expect(vieja.status).toBe(401);
  });

  /**
   * Si el reset no limpiara estas tres columnas, un código de recuperación pedido ANTES del
   * reset seguiría vivo y permitiría cambiar la contraseña que se acaba de poner.
   */
  it("el reset limpia las tres columnas de recuperación de contraseña", async () => {
    await AdminUser.create({
      name: "Admin",
      email: "duenio@botasdonchuy.com",
      passwordHash: await hashPassword("Password1!"),
      role: "owner",
      resetPasswordCodeHash: "un-hash-pendiente",
      resetPasswordExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      resetPasswordAttempts: 3,
    } as never);

    await bootstrapAdmin(
      env({ BOOTSTRAP_ADMIN_PASSWORD: "Otra9@Pass", BOOTSTRAP_RESET_PASSWORD: "true" }),
    );

    const row = (await AdminUser.findOne({ where: { email: "duenio@botasdonchuy.com" } }))!;
    expect(row.resetPasswordCodeHash).toBeNull();
    expect(row.resetPasswordExpiresAt).toBeNull();
    expect(row.resetPasswordAttempts).toBe(0);
  });

  it("conserva el rol existente al resetear (no lo degrada al default)", async () => {
    await bootstrapAdmin(env({ BOOTSTRAP_ADMIN_ROLE: "admin" }));

    const result = await bootstrapAdmin(
      env({ BOOTSTRAP_ADMIN_PASSWORD: "Otra9@Pass", BOOTSTRAP_RESET_PASSWORD: "true" }),
    );

    expect(result.role).toBe("admin");
  });
});
