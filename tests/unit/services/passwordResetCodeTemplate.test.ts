/**
 * `passwordResetCodeTemplate` (`src/services/email/templates/passwordResetCode.ts`) — Nivel 1:
 * función pura, se llama y se afirma sobre el HTML que devuelve.
 *
 * Es el único correo del flujo de recuperación (Fase 9.2), y su contenido **es** la credencial:
 * si el código no se renderiza, nadie puede recuperar su contraseña. Lo demás que se prueba aquí
 * son las condiciones que un cliente de correo impone (CSS inline, nada externo) y el saludo
 * condicional, que es la única rama del template.
 */
import { passwordResetCodeTemplate } from "../../../src/services/email/templates/passwordResetCode";

describe("passwordResetCodeTemplate", () => {
  it("renderiza el código de 5 dígitos tal cual", async () => {
    const html = passwordResetCodeTemplate({ code: "04821", name: "Alex" });

    expect(html).toContain("04821");
  });

  it("conserva los ceros a la izquierda del código", () => {
    // `crypto.randomInt(0, 100000)` se rellena a 5 dígitos: un "00042" que se renderizara como
    // "42" no coincidiría con el hash guardado y el usuario quedaría fuera sin saber por qué.
    const html = passwordResetCodeTemplate({ code: "00042" });

    expect(html).toContain("00042");
    expect(html).not.toMatch(/>\s*42\s*</);
  });

  it("saluda por nombre cuando lo recibe", () => {
    const html = passwordResetCodeTemplate({ code: "12345", name: "Alex" });

    expect(html).toContain("Hola Alex,");
  });

  it("cae a un saludo genérico sin nombre, sin dejar un hueco ni un 'undefined'", () => {
    const html = passwordResetCodeTemplate({ code: "12345" });

    expect(html).toContain("Hola,");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  it("trata la cadena vacía como 'sin nombre' (no deja 'Hola ,')", () => {
    const html = passwordResetCodeTemplate({ code: "12345", name: "" });

    expect(html).toContain("Hola,");
    expect(html).not.toContain("Hola ,");
  });

  it("anuncia la vigencia y el uso único del código", () => {
    // Es lo que evita el correo de soporte "puse el código y no sirvió": el código expira a los
    // 15 min (`RESET_CODE_TTL_MINUTES`) y se quema al usarse.
    const html = passwordResetCodeTemplate({ code: "12345" });

    expect(html).toContain("15 minutos");
    expect(html).toContain("una vez");
  });

  it("incluye la salida para quien no pidió el cambio", () => {
    const html = passwordResetCodeTemplate({ code: "12345" });

    expect(html).toMatch(/no solicitaste/i);
  });

  it("es un documento HTML completo y con todos los estilos inline", () => {
    const html = passwordResetCodeTemplate({ code: "12345", name: "Alex" });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // Los clientes de correo no cargan hojas ni scripts externos: todo va en `style="..."`.
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</style>");
    expect(html).toContain('style="');
  });

  it("no filtra datos de la cuenta más allá del nombre", () => {
    // El correo no está autenticado y se reenvía: aparte del código, no debe llevar nada del
    // usuario (ni su email, ni su rol) que no haga falta para completar el flujo.
    const html = passwordResetCodeTemplate({ code: "12345", name: "Alex" });

    expect(html).not.toContain("@");
  });
});
