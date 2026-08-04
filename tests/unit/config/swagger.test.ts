/**
 * Pure unit — sin red. Cubre la rama del fallback de PORT en el `servers[0].url`
 * de `src/config/swagger.ts` (`process.env.PORT || 4000`): el resto de la suite
 * siempre corre con PORT definido (`.env.test`), así que esa rama nunca se toma
 * salvo aquí. `swagger.ts` no hace su propio `dotenv.config()`, así que basta con
 * borrar la variable antes de reimportar.
 */
describe("config/swagger", () => {
  const originalPort = process.env.PORT;

  afterEach(() => {
    process.env.PORT = originalPort;
  });

  it("usa 4000 como fallback cuando PORT no está definida", () => {
    delete process.env.PORT;

    let swaggerSpec: { servers: Array<{ url: string }> } | undefined;
    jest.isolateModules(() => {
      swaggerSpec = require("../../../src/config/swagger").swaggerSpec;
    });

    expect(swaggerSpec!.servers[0].url).toBe("http://localhost:4000");
  });
});
