import * as z from "zod";

/**
 * Fija el locale español para los mensajes por defecto de zod.
 *
 * `errorHandler` promueve los mensajes por campo al `message` de la respuesta
 * (que es lo único que pinta el front), así que cualquier campo sin un mensaje
 * propio en el schema mostraría el default de zod EN INGLÉS al usuario final
 * (p. ej. "Invalid input: expected string, received undefined"). Con el locale,
 * ese mismo caso cae en español aunque el schema no traiga mensaje.
 *
 * Se importa por su side effect desde `app.ts` (como los demás config/) y debe
 * correr antes del primer `parse`.
 */
z.config(z.locales.es());
