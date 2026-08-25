import { booleanEnv } from "../utils/env";

/**
 * TLS de la conexión a PostgreSQL, en un solo lugar para la app y para `sequelize-cli`.
 *
 * ## Por qué existe este archivo (y por qué `?sslmode=require` NO basta)
 *
 * El consejo habitual —"si el proveedor exige TLS, agrégale `?sslmode=require` a la cadena"— es
 * **falso en este stack**, y falla de la peor forma: en silencio, dejando la conexión en claro.
 * El recorrido, verificado sobre las versiones instaladas:
 *
 *   1. `sequelize/lib/sequelize.js` parsea la URL y copia **todos** los query params a
 *      `options.dialectOptions`, así que `sslmode` sobrevive hasta ahí.
 *   2. `sequelize/lib/dialects/postgres/connection-manager.js` arma la config que le pasa a `pg`
 *      con un `_.pick` sobre una **allowlist**: `application_name`, `ssl`, `client_encoding`,
 *      `binary`, `keepAlive`, `statement_timeout`, … `sslmode` **no está en esa lista** y se
 *      descarta ahí mismo.
 *   3. `pg/lib/connection-parameters.js` lee `config.ssl` (nunca `config.sslmode`); como llega
 *      `undefined`, cae a `defaults.ssl`, que es `false`.
 *
 * Resultado: el `sslmode` de la cadena no llega a ningún lado. Contra un servidor que **exige**
 * TLS el síntoma al menos es ruidoso (la conexión es rechazada); contra uno que lo acepta pero no
 * lo exige, la sesión viaja sin cifrar y nadie se entera. De ahí que la única forma correcta sea
 * poner `dialectOptions.ssl` explícitamente — que es lo que devuelve `databaseSslOptions()` — y de
 * ahí también el aviso de `warnIfSslModeIgnored`.
 *
 * ## Los dos knobs
 *
 * - `DATABASE_SSL` (default `false`): enciende TLS. Apagado el default a propósito — un Postgres
 *   local de desarrollo no habla TLS, y encenderlo por defecto rompería a todo el que clone el
 *   repo. En un PaaS con la base en la **misma región** (red privada, p. ej. la URL interna de
 *   Render) tampoco hace falta; sí lo hace para cualquier conexión externa.
 * - `DATABASE_SSL_REJECT_UNAUTHORIZED` (default `true`): a `false` para proveedores que sirven un
 *   certificado autofirmado. Es una rebaja real de seguridad (deja de verificarse contra quién se
 *   está hablando, aunque el tráfico siga cifrado), así que el default es verificar y ponerlo en
 *   `false` tiene que ser una decisión deliberada de quien despliega.
 *
 * Ambos pasan por `booleanEnv` y no por `=== "true"` por el motivo de siempre: cualquier cadena no
 * vacía es truthy, `"false"` incluida.
 */

/** Modos de `sslmode` que EXIGEN TLS: si aparecen en la URL, quien la escribió espera cifrado. */
const SSL_MODES_THAT_EXPECT_TLS = new Set(["require", "verify-ca", "verify-full", "no-verify"]);

/**
 * Avisa cuando el `DATABASE_URL` trae un `sslmode` que espera TLS pero `DATABASE_SSL` está
 * apagado — es decir, cuando alguien creyó haber activado el cifrado y no lo activó.
 *
 * `console.warn` y no el logger de pino, por el mismo motivo que `positiveNumberEnv`
 * (`src/utils/env.ts`): a este módulo lo importan los `config/*`, que se evalúan antes que nada.
 * Tampoco lanza: un aviso mal calibrado no debe impedir arrancar, y el caso legítimo
 * (`sslmode` heredado en la cadena que da el proveedor + red privada) existe.
 */
function warnIfSslModeIgnored(enabled: boolean): void {
  if (enabled) return;

  const url = process.env.DATABASE_URL;
  if (!url) return;

  // Sin `new URL()`: una cadena de conexión con caracteres raros en la contraseña la haría
  // lanzar, y este chequeo es un aviso, no una validación.
  const match = /[?&]sslmode=([^&]+)/i.exec(url);
  const mode = match?.[1]?.trim().toLowerCase();
  if (mode === undefined || !SSL_MODES_THAT_EXPECT_TLS.has(mode)) return;

  console.warn(
    `[config] DATABASE_URL trae sslmode=${mode}, pero Sequelize lo descarta antes de llegar a pg: ` +
      "la conexión se abriría SIN TLS. Usa DATABASE_SSL=true (y " +
      "DATABASE_SSL_REJECT_UNAUTHORIZED=false si el certificado es autofirmado).",
  );
}

/**
 * Bloque `dialectOptions` con la configuración de TLS, listo para pasarse al constructor de
 * Sequelize (y al config de `sequelize-cli`).
 *
 * Devuelve un objeto **vacío** cuando `DATABASE_SSL` está apagado —y no `{ ssl: false }`— para que
 * el comportamiento sea idéntico al de antes de que existiera este archivo: `pg` no recibe la
 * clave y cae a su propio default.
 */
export function databaseSslOptions(): { ssl?: { rejectUnauthorized: boolean } } {
  const enabled = booleanEnv("DATABASE_SSL", false);

  warnIfSslModeIgnored(enabled);

  if (!enabled) return {};

  return {
    ssl: {
      rejectUnauthorized: booleanEnv("DATABASE_SSL_REJECT_UNAUTHORIZED", true),
    },
  };
}
