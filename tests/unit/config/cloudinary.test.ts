/**
 * Pure unit — sin red. Cubre la rama hard-require de `src/config/cloudinary.ts`
 * (`CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
 * ausentes) reimportando el módulo con `jest.isolateModules` para cada caso —
 * es un solo `if` con tres `||`, así que cada variable se prueba por separado
 * para cubrir cada término de la condición compuesta.
 *
 * Se asigna `""` y no `delete`, mismo truco que `resend.test.ts`/`stripe.test.ts`:
 * el `dotenv.config()` propio de cloudinary.ts no sobreescribe una key ya presente
 * en `process.env` (aunque esté vacía), así que no se repuebla desde el `.env` real.
 */
describe("config/cloudinary", () => {
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;

  afterEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
    process.env.CLOUDINARY_API_KEY = originalApiKey;
    process.env.CLOUDINARY_API_SECRET = originalApiSecret;
  });

  it("truena al importar si falta CLOUDINARY_CLOUD_NAME", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/cloudinary");
      });
    }).toThrow(/Cloudinary no está configurado/);
  });

  it("truena al importar si falta CLOUDINARY_API_KEY", () => {
    process.env.CLOUDINARY_API_KEY = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/cloudinary");
      });
    }).toThrow(/Cloudinary no está configurado/);
  });

  it("truena al importar si falta CLOUDINARY_API_SECRET", () => {
    process.env.CLOUDINARY_API_SECRET = "";

    expect(() => {
      jest.isolateModules(() => {
        require("../../../src/config/cloudinary");
      });
    }).toThrow(/Cloudinary no está configurado/);
  });
});
