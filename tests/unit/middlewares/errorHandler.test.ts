/**
 * Pure unit — sin BD. `errorHandler` es una función determinista de (err, req, res, next),
 * así que se llama directo con un `res` de mentiras en vez de montar Supertest.
 *
 * Lo que importa verificar de cara a Sentry: la rama catch-all (errores no reconocidos,
 * los que responden 500) es la ÚNICA que llama `Sentry.captureException` — las ramas con
 * causa conocida (ZodError, AppError, MulterError, etc.) responden su propio status sin
 * reportar la petición del cliente como si fuera una falla del servidor.
 */
import { ZodError, z } from "zod";
import { MulterError } from "multer";
import { UniqueConstraintError, ValidationError as SequelizeValidationError } from "sequelize";
import type { Request, Response } from "express";
import { errorHandler } from "../../../src/middlewares/errorHandler";
import { AppError } from "../../../src/middlewares/AppError";

const captureExceptionMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock("../../../src/config/sentry", () => ({
  Sentry: {
    captureException: (...args: unknown[]) => captureExceptionMock(...args),
    init: jest.fn(),
  },
}));

jest.mock("../../../src/config/logger", () => ({
  logger: {
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function buildRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("error no reconocido: responde 500, loguea y reporta a Sentry", () => {
    const res = buildRes();
    const err = new Error("boom");

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Error interno del servidor" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it("AppError: responde su statusCode/message propios y NO reporta a Sentry", () => {
    const res = buildRes();
    const err = new AppError("No encontrado", 404);

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "No encontrado" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("ZodError: responde 400 y NO reporta a Sentry", () => {
    const res = buildRes();
    const schema = z.object({ email: z.string().min(1, "El correo es requerido") });
    const parsed = schema.safeParse({ email: "" });

    errorHandler(parsed.error as ZodError, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("MulterError (LIMIT_FILE_SIZE): responde 400 y NO reporta a Sentry", () => {
    const res = buildRes();
    const err = new MulterError("LIMIT_FILE_SIZE");

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("UniqueConstraintError: responde 409 y NO reporta a Sentry", () => {
    const res = buildRes();
    const err = Object.assign(new UniqueConstraintError({ errors: [] }), {
      errors: [{ path: "email" }],
    });

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("SequelizeValidationError: responde 400 y NO reporta a Sentry", () => {
    const res = buildRes();
    const err = new SequelizeValidationError("mensaje en inglés de Sequelize", []);

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("un conflicto del índice de cupones daría un mensaje inservible: por eso no debe llegar aquí", () => {
    // Regresión de la Fase N.2: si el choque del índice único parcial de `coupon_redemptions`
    // escapara como `UniqueConstraintError`, el comprador leería esto —copia de UI que nombra
    // columnas internas— en vez del 409 accionable. `claimCoupon` lo evita usando
    // `ON CONFLICT DO NOTHING` y traduciendo el conflicto a un `AppError`; este caso documenta
    // qué pasaría si alguien quitara esa traducción en un refactor.
    const res = buildRes();
    const err = Object.assign(new UniqueConstraintError({ errors: [] }), {
      errors: [{ path: "couponId" }, { path: "emailNormalized" }],
    });

    errorHandler(err, {} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { message: string };
    expect(body.message).not.toMatch(/cupón/i);
  });
});
