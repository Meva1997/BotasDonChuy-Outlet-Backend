import dotenv from "dotenv";
import type { SignOptions } from "jsonwebtoken";

// Igual que src/config/stripe.ts / resend.ts / cloudinary.ts: los imports de módulo se
// evalúan ANTES del dotenv.config() de src/app.ts, así que cada config carga su propio .env.
dotenv.config({ quiet: true });

const secret = process.env.JWT_SECRET?.trim();

/**
 * Secreto de firma de los JWT del panel admin. **Exigido al arrancar.**
 *
 * Hasta que este módulo existió, `JWT_SECRET` se leía con `process.env.JWT_SECRET!` en
 * `auth.controller.ts` y en `requireAuth.ts`, y **nadie la validaba**: sin ella el server
 * levantaba contento, servía el catálogo público sin inmutarse, y reventaba con un **500** en
 * el primer `POST /api/auth/login` (`jsonwebtoken.sign` lanza con un secreto `undefined`) y en
 * toda ruta con `requireAuth`. Es decir, el síntoma aparecía lejísimos de la causa y solo
 * cuando alguien intentaba entrar al panel — justo el peor momento para descubrirlo, porque el
 * despliegue "arrancó bien".
 *
 * Se exige aquí, con el mismo criterio que las llaves de Stripe/Resend/Cloudinary/Skydropx:
 * es una credencial sin la cual una parte entera de la app no funciona, no una perilla
 * operativa (esas caen a su default con un aviso, ver `src/utils/env.ts`).
 *
 * Se hace `trim()` antes de validar porque un valor de solo espacios —fácil de producir en el
 * editor de variables de un PaaS— firmaría tokens con un secreto efectivamente vacío en vez de
 * fallar.
 */
if (!secret) {
  throw new Error(
    "JWT_SECRET no está configurada. Agrégala al .env (una cadena larga y aleatoria): sin ella " +
      "el panel admin no puede emitir ni verificar sesiones.",
  );
}

/** Secreto compartido para firmar y verificar los JWT. Vive solo en el .env. */
export const JWT_SECRET: string = secret;

/**
 * Vigencia del token emitido al iniciar sesión. Default explícito: 7 días.
 *
 * El default **importa**. Antes esto era `expiresIn: process.env.JWT_EXPIRES_IN as …`, así que
 * con la variable sin definir quedaba `expiresIn: undefined` — y eso no es "una vigencia por
 * defecto", es **un token que no expira nunca**. Un JWT filtrado (historial del navegador de
 * una compu prestada, un log) valdría para siempre, y como no hay lista de revocación, la única
 * forma de invalidarlo sería rotar `JWT_SECRET` y sacar a todos.
 */
export const JWT_EXPIRES_IN: SignOptions["expiresIn"] =
  (process.env.JWT_EXPIRES_IN?.trim() as SignOptions["expiresIn"]) || "7d";
