import request from "supertest";

/**
 * `authRateLimiter` (10 req / 15 min) es una única instancia compartida por las 4 rutas
 * de `auth.routes.ts` — su store en memoria vive por todo el proceso de Jest, no por
 * test. Esta suite hace bastantes más de 10 requests (login + varios escenarios de
 * código de reset), así que sin este mock el propio rate limiter reventaría la suite
 * con 429 mucho antes de llegar a probar la lógica real. Probar el rate limit en sí no
 * es parte del alcance de esta parte del roadmap.
 */
jest.mock("express-rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../../src/app";
import { setupTestDatabase, truncateAll, closeTestDatabase } from "../setup/db";
import { createAdminUser } from "../setup/factories";
import { AdminUser } from "../../src/models/AdminUser";
import { hashResetCode, RESET_CODE_TTL_MINUTES, RESET_CODE_MAX_ATTEMPTS } from "../../src/utils/resetCode";

const RESET_CODE_INVALID_MESSAGE = `El código no es válido o ya expiró (dura ${RESET_CODE_TTL_MINUTES} minutos). Solicita uno nuevo para continuar.`;

/** Fija un código de reset conocido en claro para que la prueba lo pueda enviar tal cual. */
async function setResetCode(
  user: AdminUser,
  code: string,
  opts: { expired?: boolean; attempts?: number } = {}
): Promise<void> {
  await user.update({
    resetPasswordCodeHash: hashResetCode(code),
    resetPasswordExpiresAt: new Date(Date.now() + (opts.expired ? -1000 : RESET_CODE_TTL_MINUTES * 60 * 1000)),
    resetPasswordAttempts: opts.attempts ?? 0,
  });
}

beforeAll(setupTestDatabase);
afterEach(truncateAll);
afterAll(closeTestDatabase);

describe("POST /api/auth/login", () => {
  it("password correcta → { token, user }", async () => {
    const { user, password } = await createAdminUser({ email: "owner@test.com" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({
      id: String(user.id),
      name: user.name,
      email: user.email,
      role: user.role,
    });
  });

  it("email desconocido y password incorrecta devuelven el MISMO 401 byte-idéntico", async () => {
    const { user } = await createAdminUser({ email: "real@test.com", password: "Password1!" });

    const unknownEmailRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "noexiste@test.com", password: "OtraClave1!" });

    const wrongPasswordRes = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "OtraClave1!" });

    expect(unknownEmailRes.status).toBe(401);
    expect(wrongPasswordRes.status).toBe(401);
    // Byte-idéntico: mismo body completo, no solo el texto del mensaje.
    expect(unknownEmailRes.body).toEqual(wrongPasswordRes.body);
    expect(unknownEmailRes.body.message).toBe(
      "Correo o contraseña incorrectos. Verifica tus datos e inténtalo de nuevo."
    );
  });
});

describe("assertValidResetCode vía POST /api/auth/verify-reset-code", () => {
  it("código válido y vigente → { ok: true }, no lo consume", async () => {
    const { user } = await createAdminUser();
    await setResetCode(user, "12345");

    const res = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: user.email, code: "12345" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // No lo consume: el mismo código sigue siendo válido después.
    const secondRes = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: user.email, code: "12345" });
    expect(secondRes.status).toBe(200);
  });

  it("mensaje idéntico para correo inexistente, código incorrecto y código expirado", async () => {
    const missingUserRes = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: "noexiste@test.com", code: "12345" });

    const { user: userWrongCode } = await createAdminUser();
    await setResetCode(userWrongCode, "12345");
    const wrongCodeRes = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: userWrongCode.email, code: "99999" });

    const { user: userExpired } = await createAdminUser();
    await setResetCode(userExpired, "12345", { expired: true });
    const expiredRes = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: userExpired.email, code: "12345" });

    for (const res of [missingUserRes, wrongCodeRes, expiredRes]) {
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(RESET_CODE_INVALID_MESSAGE);
    }
  });

  it("agota RESET_CODE_MAX_ATTEMPTS y quema el código (mismo mensaje después)", async () => {
    const { user } = await createAdminUser();
    await setResetCode(user, "12345");

    for (let i = 0; i < RESET_CODE_MAX_ATTEMPTS; i++) {
      const res = await request(app)
        .post("/api/auth/verify-reset-code")
        .send({ email: user.email, code: "00000" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(RESET_CODE_INVALID_MESSAGE);
    }

    const reloaded = await AdminUser.findByPk(user.id);
    expect(reloaded!.resetPasswordCodeHash).toBeNull();
    expect(reloaded!.resetPasswordExpiresAt).toBeNull();
    expect(reloaded!.resetPasswordAttempts).toBe(0);

    // El código correcto original ya no sirve: quedó quemado.
    const afterBurnRes = await request(app)
      .post("/api/auth/verify-reset-code")
      .send({ email: user.email, code: "12345" });
    expect(afterBurnRes.status).toBe(400);
    expect(afterBurnRes.body.message).toBe(RESET_CODE_INVALID_MESSAGE);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("código válido actualiza la contraseña y la quema (un solo uso)", async () => {
    const { user } = await createAdminUser();
    await setResetCode(user, "12345");

    const res = await request(app).post("/api/auth/reset-password").send({
      email: user.email,
      code: "12345",
      newPassword: "NuevaClave1!",
      confirmPassword: "NuevaClave1!",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "NuevaClave1!" });
    expect(loginRes.status).toBe(200);

    const reuseRes = await request(app).post("/api/auth/reset-password").send({
      email: user.email,
      code: "12345",
      newPassword: "OtraClave2!",
      confirmPassword: "OtraClave2!",
    });
    expect(reuseRes.status).toBe(400);
    expect(reuseRes.body.message).toBe(RESET_CODE_INVALID_MESSAGE);
  });
});
