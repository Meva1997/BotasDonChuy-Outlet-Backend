import request from "supertest";

import app from "../../src/app";
import { sequelize } from "../../src/config/database";
import * as readiness from "../../src/services/readiness";
import { markDraining, resetReadinessCache } from "../../src/services/readiness";
import { setupTestDatabase, closeTestDatabase } from "../setup/db";

/**
 * Fase O.5 — readiness real en el healthcheck. Nivel 2 (HTTP contra Postgres real).
 *
 * Lo que esta suite defiende:
 *  1. **Que los dos probes sigan siendo distintos.** `/health` es liveness y NO debe tocar la BD:
 *     si dependiera de ella, una caída momentánea de Postgres haría que el orquestador reinicie
 *     la app en vez de solo sacarla de rotación. Un refactor que "unifique" los dos handlers
 *     rompe justo eso, así que se afirma aquí.
 *  2. **Que el 503 no filtre el error de la BD.** Es una ruta pública sin auth: el detalle
 *     (host, puerto, driver) va al log, nunca al cuerpo.
 */
beforeAll(setupTestDatabase);
afterAll(closeTestDatabase);

beforeEach(resetReadinessCache);

describe("GET /health/ready", () => {
  it("responde 200 con la base de datos arriba", async () => {
    const res = await request(app).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      database: "up",
      timestamp: expect.any(String),
    });
    expect(new Date(res.body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("responde 503 cuando la base de datos no responde, sin filtrar el error", async () => {
    const authenticate = jest
      .spyOn(sequelize, "authenticate")
      .mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:5432 (database "botas_test", user "postgres")'),
      );

    try {
      const res = await request(app).get("/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: "unavailable", database: "down", reason: "database" });

      // Barrido sobre el JSON completo: ningún dato de la conexión puede asomarse por el cuerpo.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/ECONNREFUSED/i);
      expect(serialized).not.toMatch(/5432/);
      expect(serialized).not.toMatch(/postgres/i);
    } finally {
      authenticate.mockRestore();
    }
  });

  it("responde 503 mientras el proceso está apagándose, sin consultar la BD", async () => {
    const authenticate = jest.spyOn(sequelize, "authenticate");
    markDraining();

    try {
      const res = await request(app).get("/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: "unavailable", reason: "draining" });
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });
});

describe("GET /health (liveness) no cambia", () => {
  it("responde 200 sin consultar la base de datos", async () => {
    const authenticate = jest.spyOn(sequelize, "authenticate");

    try {
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", timestamp: expect.any(String) });
      // Clave de la fase: el liveness no puede caer con Postgres caído, o el orquestador
      // reiniciaría la app en vez de sacarla de rotación.
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });
});

describe("GET /health/ready — red de seguridad del handler", () => {
  it("responde 503 (no 500) si el chequeo llegara a lanzar", async () => {
    // `checkReadiness` está escrito para NUNCA lanzar (una BD caída es un `{ ready:false }`
    // válido, no un error de request). Este catch es la red por si esa garantía se rompiera en
    // un refactor: la ruta no debe llegar al `errorHandler`, que reportaría a Sentry en CADA
    // sondeo —varios por minuto, para siempre— y devolvería copy en español a una máquina.
    const check = jest
      .spyOn(readiness, "checkReadiness")
      .mockRejectedValue(new Error("fallo inesperado en el chequeo"));

    try {
      const res = await request(app).get("/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        status: "unavailable",
        database: "down",
        timestamp: expect.any(String),
      });
      // Igual que el 503 normal: el detalle del error va al log, nunca al cuerpo de una ruta
      // pública sin auth.
      expect(JSON.stringify(res.body)).not.toContain("fallo inesperado");
    } finally {
      check.mockRestore();
    }
  });
});
