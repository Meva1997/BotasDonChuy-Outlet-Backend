/**
 * Alta del **primer usuario admin** en una base vacía.
 *
 * Es el único camino para entrar al panel en un despliegue nuevo: `POST /api/admin/users` exige
 * un JWT, y para tener un JWT hace falta un usuario que todavía no existe.
 *
 * **No confundir con `pnpm seed`**, que NO sirve para producción: hace
 * `TRUNCATE … RESTART IDENTITY CASCADE` de ocho tablas (`orders` y `adminusers` incluidas) antes
 * de insertar nada, mete 30+ productos mock y un histórico de órdenes falsas que el dashboard y
 * los reportes contarían como ventas reales, y crea el admin con correo y contraseña
 * hardcodeados. Este script solo toca `adminusers`, una fila.
 *
 * `BrandSettings` **no** se crea aquí a propósito: `brand.controller.ts` ya hace `findOrCreate`
 * del singleton `id: 1` en el primer `GET /api/admin/brand` (que es público), así que hacerlo
 * también aquí metería una tercera copia de `BRAND_DEFAULTS` sin ganar nada.
 *
 * Uso en producción — **compilado**, no con `ts-node`:
 *
 *     BOOTSTRAP_ADMIN_EMAIL=duenio@botasdonchuy.com \
 *     BOOTSTRAP_ADMIN_PASSWORD='…' \
 *       node dist/scripts/bootstrapAdmin.js
 *
 * `ts-node`/`sequelize-cli`/`typescript` son devDependencies, así que `pnpm seed` y
 * `pnpm migrate` no existen tras un `pnpm install --prod`. Todo lo que este script necesita en
 * runtime (`bcrypt`, `sequelize`, `pg`, `dotenv`, `zod`) sí está en `dependencies`, y `tsc` lo
 * emite a `dist/scripts/` sin tocar la config — así el bootstrap no depende de cómo se resuelva
 * el paso de migraciones del pipeline.
 *
 * Las credenciales entran por **variables de entorno** y no por argumentos para que la
 * contraseña no quede en el historial del shell ni sea visible en `ps`, y para que la misma
 * invocación sirva en un one-off shell y en un release step.
 */

// `config/database` PRIMERO, y por su side effect: es quien llama a `dotenv.config()`.
// `utils/password` lee BCRYPT_ROUNDS al evaluar el módulo, así que importarlo antes que esto
// dejaría el costo de bcrypt en su default aunque el .env diga otra cosa. Mismo orden que seed.ts.
import { sequelize } from "../config/database";
import "../config/zod"; // mensajes por defecto de zod en español (este script no pasa por app.ts)
import { AdminUser } from "../models/AdminUser";
import { hashPassword } from "../utils/password";
import { createAdminUserSchema } from "../schemas/adminUser";
import { z } from "zod";

// Nota: NO se importa `src/app.ts` ni nada que lo arrastre. Eso haría fail-fast por las llaves
// de Cloudinary/Resend/Skydropx, arrancaría los tres crons y abriría el puerto. Este script
// corre con `DATABASE_URL` (y opcionalmente `BCRYPT_ROUNDS`) como único entorno necesario.

export interface BootstrapResult {
  /** `"created"` cuando se dio de alta la fila, `"password-reset"` cuando ya existía. */
  action: "created" | "password-reset";
  id: number;
  email: string;
  role: "owner" | "admin";
}

/** Error de uso del script (entorno incompleto, contraseña inválida, correo ya tomado). */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

type EnvLike = Record<string, string | undefined>;

function flag(raw: string | undefined): boolean {
  // Mismo criterio que `booleanEnv` de utils/env.ts: cualquier cadena no vacía es truthy en JS,
  // "false" incluida, que es justo lo que alguien escribe para apagar algo.
  const value = raw?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Crea (o resetea) el usuario admin descrito por el entorno.
 *
 * Vive en una función exportada, con el runner CLI detrás de `require.main === module`, para que
 * sea testeable: `seed.ts` no tiene tests precisamente porque importarlo lo ejecuta entero y
 * llama `process.exit`.
 */
export async function bootstrapAdmin(env: EnvLike = process.env): Promise<BootstrapResult> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  const resetPassword = flag(env.BOOTSTRAP_RESET_PASSWORD);

  if (!email || !password) {
    throw new BootstrapError(
      "Faltan BOOTSTRAP_ADMIN_EMAIL y/o BOOTSTRAP_ADMIN_PASSWORD. Ejemplo:\n" +
        "  BOOTSTRAP_ADMIN_EMAIL=duenio@botasdonchuy.com \\\n" +
        "  BOOTSTRAP_ADMIN_PASSWORD='TuContra1@' node dist/scripts/bootstrapAdmin.js",
    );
  }

  // Se valida con el MISMO esquema que usa `POST /api/admin/users`, no con reglas propias.
  // Es el punto crítico del script: si la contraseña no cumple exactamente la complejidad de
  // `loginSchema`, se crearía una cuenta que hashea bien pero que **nunca** puede pasar
  // `POST /api/auth/login` — la cabecera de src/schemas/auth.ts advierte justo de esto.
  let parsed;
  try {
    parsed = createAdminUserSchema.parse({
      name: env.BOOTSTRAP_ADMIN_NAME?.trim() || "Admin",
      email,
      tempPassword: password,
      // El primer usuario de la tienda es `owner`, no `admin` (que es el default del esquema y
      // lo que crea el seed). El guard de `DELETE /api/admin/users/:id` se niega a borrar al
      // último `owner`; una base con cero owners hace que ese guard no proteja nada y el panel
      // se pueda quedar sin acceso. Los dos roles tienen los mismos permisos de ruta por diseño,
      // así que esto no abre nada: solo activa el guard de integridad.
      role: env.BOOTSTRAP_ADMIN_ROLE?.trim() || "owner",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BootstrapError(error.issues.map((issue) => `• ${issue.message}`).join("\n"));
    }
    throw error;
  }

  // `parse` aplica `.trim()` ANTES de los regex, así que hay que hashear lo que devuelve el
  // esquema y no el crudo del entorno: un espacio final pegado en el editor de variables del
  // PaaS validaría la versión recortada y guardaría el hash de otra cadena → cuenta muerta.
  const { name, email: validEmail, tempPassword, role } = parsed;

  // `authenticate()` directo y no `connectDB()`: ese hace `process.exit(1)` y se traga el objeto
  // de error, y aquí el mensaje de por qué no conectó es justo lo que se necesita ver.
  await sequelize.authenticate();

  // El login busca el correo tal cual (`auth.controller.ts`, sin normalizar) y `AdminUser` no
  // tiene hooks de lowercasing, así que se guarda exactamente lo que se escribió.
  const existing = await AdminUser.findOne({ where: { email: validEmail } });

  if (existing) {
    if (!resetPassword) {
      throw new BootstrapError(
        `Ya existe un usuario admin con el correo "${validEmail}" (id ${existing.id}). ` +
          "No se modificó nada.\n" +
          "Si lo que quieres es reescribir su contraseña, vuelve a correr el script con " +
          "BOOTSTRAP_RESET_PASSWORD=true.",
      );
    }

    await existing.update({
      passwordHash: await hashPassword(tempPassword),
      // Se limpian las tres columnas de recuperación, igual que hace `resetPassword` en
      // auth.controller.ts: si no, un código de 5 dígitos pedido antes de este reset seguiría
      // vivo y permitiría cambiar la contraseña recién puesta.
      resetPasswordCodeHash: null,
      resetPasswordExpiresAt: null,
      resetPasswordAttempts: 0,
    });

    return {
      action: "password-reset",
      id: existing.id,
      email: existing.email,
      role: existing.role,
    };
  }

  const created = await AdminUser.create({
    name,
    email: validEmail,
    passwordHash: await hashPassword(tempPassword),
    role,
  } as never);

  return { action: "created", id: created.id, email: created.email, role: created.role };
}

// Runner CLI. `console.log` y no pino, mismo criterio que seed.ts: esto lo lee una persona en
// una terminal, no un agregador de logs. El resumen NUNCA imprime la contraseña.
if (require.main === module) {
  bootstrapAdmin()
    .then(async (result) => {
      const verb = result.action === "created" ? "creado" : "actualizado (contraseña reescrita)";
      console.log(`✅ Usuario admin ${verb}`);
      console.log(`   id:     ${result.id}`);
      console.log(`   correo: ${result.email}`);
      console.log(`   rol:    ${result.role}`);
      console.log("\nEntra al panel con ese correo y la contraseña que acabas de definir.");
      await sequelize.close();
      process.exit(0);
    })
    .catch(async (error) => {
      if (error instanceof BootstrapError) {
        console.error(`❌ ${error.message}`);
      } else {
        console.error("❌ No se pudo dar de alta el usuario admin:", error);
      }
      await sequelize.close().catch(() => undefined);
      process.exit(1);
    });
}
