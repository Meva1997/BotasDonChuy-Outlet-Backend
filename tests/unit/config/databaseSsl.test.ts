import { databaseSslOptions } from "../../../src/config/databaseSsl";

/**
 * Nivel 1 (sin BD): `databaseSslOptions` es lo único que hace que la conexión a Postgres viaje
 * cifrada, y su modo de fallar es el peor posible — un `?sslmode=require` en la cadena parece
 * activarlo y no activa nada, porque Sequelize descarta esa clave antes de llegar a `pg` (el
 * recorrido completo está documentado en `src/config/databaseSsl.ts`). De ahí que se prueben
 * las dos cosas: el objeto que se le pasa a `pg` y el aviso que atrapa esa trampa.
 */
describe("databaseSslOptions", () => {
  const ORIGINAL_URL = process.env.DATABASE_URL;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DATABASE_SSL;
    delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
    process.env.DATABASE_URL = ORIGINAL_URL;
    warnSpy.mockRestore();
  });

  describe("apagado (el default)", () => {
    it("devuelve un objeto vacío, SIN la clave ssl", () => {
      // No es lo mismo que `{ ssl: false }`: al no mandar la clave, `pg` cae a su propio
      // default y el comportamiento queda idéntico al de antes de que existiera este módulo.
      // Un dev con Postgres local (que no habla TLS) tiene que poder conectarse sin configurar nada.
      const options = databaseSslOptions();

      expect(options).toEqual({});
      expect(options).not.toHaveProperty("ssl");
    });

    it("sigue apagado con DATABASE_SSL=false, y con la cadena vacía", () => {
      process.env.DATABASE_SSL = "false";
      expect(databaseSslOptions()).toEqual({});

      // `Boolean("")` y `Boolean("false")` son la razón de usar `booleanEnv`.
      process.env.DATABASE_SSL = "";
      expect(databaseSslOptions()).toEqual({});
    });
  });

  describe("encendido", () => {
    it("verifica el certificado por default", () => {
      process.env.DATABASE_SSL = "true";

      expect(databaseSslOptions()).toEqual({ ssl: { rejectUnauthorized: true } });
    });

    it("deja de verificarlo solo si se pide explícitamente", () => {
      // El caso del proveedor con certificado autofirmado. Es una rebaja real de seguridad
      // (el tráfico sigue cifrado, pero ya no se verifica con quién se habla), así que tiene
      // que ser deliberada y nunca el default.
      process.env.DATABASE_SSL = "true";
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = "false";

      expect(databaseSslOptions()).toEqual({ ssl: { rejectUnauthorized: false } });
    });

    it("acepta 1/0, mayúsculas y espacios en ambos knobs", () => {
      process.env.DATABASE_SSL = " TRUE ";
      expect(databaseSslOptions()).toEqual({ ssl: { rejectUnauthorized: true } });

      process.env.DATABASE_SSL = "1";
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = "0";
      expect(databaseSslOptions()).toEqual({ ssl: { rejectUnauthorized: false } });
    });

    it("un valor basura cae al default con aviso, sin tumbar el arranque", () => {
      process.env.DATABASE_SSL = "si";

      expect(databaseSslOptions()).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DATABASE_SSL"));
    });

    it("un valor basura en rejectUnauthorized deja la verificación ENCENDIDA", () => {
      // La dirección del fallo importa: caer a `false` por un typo dejaría la conexión sin
      // verificar creyendo que está protegida.
      process.env.DATABASE_SSL = "true";
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = "nel";

      expect(databaseSslOptions()).toEqual({ ssl: { rejectUnauthorized: true } });
    });
  });

  describe("aviso de sslmode ignorado", () => {
    const withUrl = (url: string) => {
      process.env.DATABASE_URL = url;
      return databaseSslOptions();
    };

    it.each(["require", "verify-ca", "verify-full", "no-verify"])(
      "avisa cuando la URL trae sslmode=%s y DATABASE_SSL está apagado",
      (mode) => {
        withUrl(`postgres://u:p@host:5432/db?sslmode=${mode}`);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Sequelize lo descarta antes de llegar a pg"),
        );
      },
    );

    it("no avisa si DATABASE_SSL ya está encendido", () => {
      // Ahí el `sslmode` sobra pero no engaña a nadie: el TLS sí está configurado.
      process.env.DATABASE_SSL = "true";
      withUrl("postgres://u:p@host:5432/db?sslmode=require");

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("no avisa con modos que no esperan TLS, ni sin sslmode", () => {
      withUrl("postgres://u:p@host:5432/db?sslmode=disable");
      withUrl("postgres://u:p@host:5432/db?sslmode=allow");
      withUrl("postgres://u:p@host:5432/db");

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("lo detecta también cuando sslmode no es el primer parámetro", () => {
      withUrl("postgres://u:p@host:5432/db?application_name=api&sslmode=REQUIRE");

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("sslmode=require"));
    });

    it("no revienta si DATABASE_URL trae caracteres que romperían new URL()", () => {
      // Una contraseña con símbolos sin escapar es motivo suficiente para que `new URL()` lance;
      // este chequeo es un aviso, no una validación, y nunca debe impedir el arranque.
      expect(() => withUrl("postgres://u:p@ss w:rd@host:5432/db?sslmode=require")).not.toThrow();

      delete process.env.DATABASE_URL;
      expect(() => databaseSslOptions()).not.toThrow();
    });
  });
});
