import request from "supertest";

/**
 * Nivel 1 (sin BD): `trustProxyEnv` ya se prueba aparte; lo que se verifica aquí es el cableado en
 * `app.ts`, y sobre todo que **sin la variable el default de Express siga siendo `false`**. Si
 * alguien "arreglara" el rate limiting poniendo `trust proxy` en `true` por defecto, este server —
 * que también puede correr expuesto directo — pasaría a creerle el `X-Forwarded-For` a cualquiera
 * y los límites se saltarían rotando IPs inventadas. Ese default es la parte con implicación de
 * seguridad, así que se blinda con un test.
 */
describe("trust proxy en app.ts", () => {
  const load = async (value?: string) => {
    jest.resetModules();
    if (value === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = value;
    return (await import("../../../src/app")).default;
  };

  afterAll(() => {
    delete process.env.TRUST_PROXY;
  });

  it("sin la variable conserva el default de Express y no rompe nada", async () => {
    const app = await load(undefined);
    expect(app.get("trust proxy")).toBe(false);
    const res = await request(app).get("/health").set("X-Forwarded-For", "203.0.113.9");
    expect(res.status).toBe(200);
  });

  it.each([
    ["1", 1],
    ["loopback", "loopback"],
    ["true", true],
  ])("TRUST_PROXY=%s se aplica al app", async (value, expected) => {
    const app = await load(value as string);
    expect(app.get("trust proxy")).toBe(expected);
    const res = await request(app).get("/health").set("X-Forwarded-For", "203.0.113.9");
    expect(res.status).toBe(200);
  });
});
