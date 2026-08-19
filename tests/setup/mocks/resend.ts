/**
 * Mock reutilizable del envío de correo (`src/services/email.service`). Scaffolding para
 * las partes 3/4: los tests verifican que `sendEmail` se llamó (o no, o una sola vez),
 * nunca mandan un correo real por Resend.
 *
 * Uso en un test (el `jest.mock` va en el archivo de test por el hoisting de Jest):
 *
 *   const sendEmailMock = jest.fn().mockResolvedValue(true);
 *   jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));
 *
 * Resuelve `true` (éxito) por defecto a propósito: `sendOrderEmail`
 * (`payment.service.ts`) dispara una alerta cuando `sendEmail` resuelve `false`, así que un
 * mock que por defecto "fallara" dispararía esa alerta en cada test que no la espera.
 *
 * Este helper solo documenta la firma esperada para mantener los tests consistentes.
 */
export type SendEmailMock = jest.Mock<Promise<boolean>, [Record<string, unknown>]>;

export function buildSendEmailMock(): SendEmailMock {
  return jest.fn().mockResolvedValue(true) as SendEmailMock;
}
