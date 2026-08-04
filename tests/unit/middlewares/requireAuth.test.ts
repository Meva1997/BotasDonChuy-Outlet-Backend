/**
 * Pure unit — sin BD ni Supertest. `requireAuth`/`requireRole` son funciones síncronas de
 * (req, res, next) que solo leen `req.headers.authorization` / `req.user`, así que se llaman
 * directo con un `req`/`res` de mentiras.
 *
 * `JWT_SECRET` viene de `.env.test` (cargado por `tests/setup/env.ts`), así que `jsonwebtoken`
 * real (sin mockear) puede firmar tokens válidos con el mismo secreto que usa el middleware.
 *
 * Antes de este archivo, `requireAuth` solo se ejercitaba de rebote a través de suites de
 * integración: el camino feliz y "sin token" estaban bien cubiertos, pero la rama catch
 * (token inválido/expirado) solo se disparaba una vez en toda la suite, y `requireRole` nunca
 * se llamaba (no está enganchado en ninguna ruta hoy — ver CLAUDE.md).
 */
import jsonwebtoken from "jsonwebtoken";
import type { Response } from "express";
import { requireAuth, requireRole, type AuthRequest, type AuthUser } from "../../../src/middlewares/requireAuth";
import { AppError } from "../../../src/middlewares/AppError";

const SESSION_EXPIRED_MESSAGE = "Tu sesión expiró. Vuelve a iniciar sesión para continuar.";
const NO_SESSION_MESSAGE = "Necesitas iniciar sesión para acceder a esta sección.";
const NO_PERMISSION_MESSAGE = "Tu cuenta no tiene permisos para realizar esta acción.";

const AUTH_USER: AuthUser = { id: "1", name: "Ana", email: "ana@test.com", role: "owner" };

function buildReq(authorization?: string): AuthRequest {
  return { headers: { authorization } } as AuthRequest;
}

function signValidToken(overrides: Partial<AuthUser> = {}): string {
  return jsonwebtoken.sign({ ...AUTH_USER, ...overrides }, process.env.JWT_SECRET!);
}

describe("requireAuth", () => {
  it("sin header Authorization: 401 'Necesitas iniciar sesión...'", () => {
    const req = buildReq(undefined);

    expect(() => requireAuth(req, {} as Response, jest.fn())).toThrow(AppError);
    try {
      requireAuth(req, {} as Response, jest.fn());
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toBe(NO_SESSION_MESSAGE);
    }
  });

  it("header con otro esquema (no 'Bearer '): 401 'Necesitas iniciar sesión...'", () => {
    const req = buildReq(`Basic ${Buffer.from("user:pass").toString("base64")}`);

    try {
      requireAuth(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toBe(NO_SESSION_MESSAGE);
    }
  });

  it("'Bearer ' con token vacío: 401 'Tu sesión expiró...'", () => {
    const req = buildReq("Bearer ");

    try {
      requireAuth(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toBe(SESSION_EXPIRED_MESSAGE);
    }
  });

  it("token con firma inválida (otro secreto): 401 'Tu sesión expiró...'", () => {
    const token = jsonwebtoken.sign(AUTH_USER, "otro-secreto-distinto");
    const req = buildReq(`Bearer ${token}`);

    try {
      requireAuth(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toBe(SESSION_EXPIRED_MESSAGE);
    }
  });

  it("token expirado: 401 'Tu sesión expiró...'", () => {
    const token = jsonwebtoken.sign(AUTH_USER, process.env.JWT_SECRET!, { expiresIn: -10 });
    const req = buildReq(`Bearer ${token}`);

    try {
      requireAuth(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
      expect((err as AppError).message).toBe(SESSION_EXPIRED_MESSAGE);
    }
  });

  it("token válido: asigna req.user y llama next() sin lanzar", () => {
    const token = signValidToken();
    const req = buildReq(`Bearer ${token}`);
    const next = jest.fn();

    expect(() => requireAuth(req, {} as Response, next)).not.toThrow();

    expect(next).toHaveBeenCalledTimes(1);
    // `jsonwebtoken.verify` agrega `iat` al payload decodificado, así que no es un `toEqual` exacto.
    expect(req.user).toMatchObject(AUTH_USER);
  });
});

describe("requireRole", () => {
  it("sin req.user: 403 'Tu cuenta no tiene permisos...'", () => {
    const req = buildReq();
    const middleware = requireRole("owner", "admin");

    try {
      middleware(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).message).toBe(NO_PERMISSION_MESSAGE);
    }
  });

  it("req.user con un rol no incluido: 403 'Tu cuenta no tiene permisos...'", () => {
    const req = buildReq();
    req.user = { ...AUTH_USER, role: "admin" };
    const middleware = requireRole("owner");

    try {
      middleware(req, {} as Response, jest.fn());
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).message).toBe(NO_PERMISSION_MESSAGE);
    }
  });

  it("req.user con un rol incluido: llama next() sin lanzar", () => {
    const req = buildReq();
    req.user = { ...AUTH_USER, role: "admin" };
    const next = jest.fn();
    const middleware = requireRole("owner", "admin");

    expect(() => middleware(req, {} as Response, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
