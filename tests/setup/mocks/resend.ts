/**
 * Mock reutilizable del envío de correo (`src/services/email.service`). Scaffolding para
 * las partes 3/4: los tests verifican que `sendEmail` se llamó (o no, o una sola vez),
 * nunca mandan un correo real por Resend.
 *
 * Uso en un test (el `jest.mock` va en el archivo de test por el hoisting de Jest):
 *
 *   const sendEmailMock = jest.fn().mockResolvedValue(undefined);
 *   jest.mock("../../src/services/email.service", () => ({ sendEmail: sendEmailMock }));
 *
 * Este helper solo documenta la firma esperada para mantener los tests consistentes.
 */
export type SendEmailMock = jest.Mock<Promise<void>, [Record<string, unknown>]>;

export function buildSendEmailMock(): SendEmailMock {
  return jest.fn().mockResolvedValue(undefined) as SendEmailMock;
}
