/**
 * `sendEmail` (`src/services/email.service.ts`) — Nivel 1: sin BD, sin HTTP real, con el cliente
 * de Resend mockeado (mandar un correo de verdad cuesta y sale del dominio de pruebas).
 *
 * Lo que se prueba aquí son **dos garantías**, y son la razón de existir de esta envoltura:
 * `sendEmail` **loguea pero NUNCA lanza**. Todos sus llamadores son fire-and-forget colgados de
 * flujos que no se pueden tumbar por un correo — el checkout, el webhook de Stripe (que
 * respondería 500 y provocaría reintentos en bucle), forgot-password. La SDK de Resend tiene
 * **dos** formas de fallar y las dos tienen que quedar contenidas: devuelve `{ data, error }` sin
 * lanzar en un error de API, y lanza de verdad ante un fallo de red. Y, desde que un correo
 * "tragado" en silencio (dominio no verificado) dejó a un comprador sin su confirmación sin que
 * nadie se enterara, `sendEmail` también devuelve `true`/`false` — el único canal que un llamador
 * tiene para distinguir "se mandó" de "se tragó un error" (`sendOrderEmail` en
 * `payment.service.ts` lo usa para alertar).
 */
const sendMock = jest.fn();
jest.mock("../../../src/config/resend", () => ({
  resend: { emails: { send: sendMock } },
  EMAIL_FROM: "pruebas@botasdonchuy.test",
  FRONTEND_URL: "https://tienda.test",
}));

import { sendEmail } from "../../../src/services/email.service";
import { logger } from "../../../src/config/logger";

const baseInput = {
  to: "cliente@test.com",
  subject: "Tu pedido",
  html: "<p>Gracias por tu compra</p>",
};

let errorSpy: jest.SpyInstance;
let infoSpy: jest.SpyInstance;

beforeEach(() => {
  sendMock.mockReset();
  // Se silencian además de espiarse: el log de pino ensuciaría la salida de la suite con
  // errores que estos casos provocan a propósito.
  errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined as never);
  infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined as never);
});

afterEach(() => {
  errorSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("sendEmail — camino feliz", () => {
  it("manda el correo con el remitente de configuración y loguea el id de Resend", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_abc123" }, error: null });

    await expect(sendEmail(baseInput)).resolves.toBe(true);

    expect(sendMock).toHaveBeenCalledTimes(1);
    // El `from` NUNCA viene del llamador: sale de EMAIL_FROM, que `config/resend` exige al arrancar.
    expect(sendMock.mock.calls[0][0]).toEqual({
      from: "pruebas@botasdonchuy.test",
      to: "cliente@test.com",
      subject: "Tu pedido",
      html: "<p>Gracias por tu compra</p>",
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resendId: "re_abc123" }),
      expect.stringContaining("Enviado"),
    );
  });

  it("pasa la clave de idempotencia a Resend cuando se le da", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    await sendEmail({ ...baseInput, idempotencyKey: "order-confirmation/42" });

    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "order-confirmation/42" });
  });

  it("omite el segundo argumento cuando no hay clave, en vez de mandar un objeto vacío", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_2" }, error: null });

    await sendEmail(baseInput);

    // `{}` haría que Resend recibiera opciones sin `idempotencyKey`; `undefined` es lo que la
    // SDK espera para "sin opciones".
    expect(sendMock.mock.calls[0][1]).toBeUndefined();
  });

  it("acepta varios destinatarios", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_3" }, error: null });

    await sendEmail({ ...baseInput, to: ["uno@test.com", "dos@test.com"] });

    expect(sendMock.mock.calls[0][0].to).toEqual(["uno@test.com", "dos@test.com"]);
  });

  it("tolera una respuesta sin `data` (no revienta al leer data.id)", async () => {
    sendMock.mockResolvedValue({ data: null, error: null });

    await expect(sendEmail(baseInput)).resolves.toBe(true);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resendId: undefined }),
      expect.stringContaining("Enviado"),
    );
  });
});

describe("sendEmail — nunca lanza", () => {
  it("contiene el `error` que la SDK devuelve SIN lanzar (403 de dominio no verificado) y devuelve false", async () => {
    // El caso real del repo: sin dominio verificado, Resend responde 403 a cualquier
    // destinatario que no sea el dueño de la cuenta. La SDK no lanza — lo devuelve en `error`,
    // así que un `try/catch` por sí solo no bastaría. El `false` de retorno es lo que permite a
    // un llamador (p. ej. `sendOrderEmail`) notar este fallo, que de otro modo es invisible.
    sendMock.mockResolvedValue({
      data: null,
      error: { statusCode: 403, name: "validation_error", message: "Domain not verified" },
    });

    await expect(sendEmail(baseInput)).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ statusCode: 403 }) }),
      expect.stringContaining("Resend devolvió un error"),
    );
    // No se loguea como enviado: sería mentira en la bitácora.
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("contiene una excepción de red (Resend caído) sin propagarla y devuelve false", async () => {
    sendMock.mockRejectedValue(new Error("fetch failed"));

    await expect(sendEmail(baseInput)).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("excepción"),
    );
  });

  it("contiene también un throw síncrono de la SDK y devuelve false", async () => {
    sendMock.mockImplementation(() => {
      throw new Error("cliente mal inicializado");
    });

    await expect(sendEmail(baseInput)).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("no alerta por correo desde aquí: sería un bucle sobre el canal roto", async () => {
    // `alert.service` reusa `sendEmail`, así que si esta función intentara alertar de su propio
    // fallo, una caída de Resend se realimentaría. La comprobación es que el único efecto sea
    // el log — ni un segundo intento de envío. (Es responsabilidad del LLAMADOR, no de esta
    // función, decidir si el `false` de retorno amerita una alerta — ver payment.service.ts.)
    sendMock.mockResolvedValue({ data: null, error: { message: "boom" } });

    await sendEmail(baseInput);

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
