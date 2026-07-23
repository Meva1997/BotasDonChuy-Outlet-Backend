/**
 * Mock reutilizable de Skydropx. Scaffolding para las partes 3/4: cotizar o crear una
 * guía real cuesta saldo, así que en los tests se mockea. Hay dos niveles según lo que
 * el test necesite aislar:
 *
 * 1. Mockear las funciones del servicio (`src/services/skydropx.service`) — lo más común,
 *    para el checkout (`getQuotationRate`) y la creación de guía (`createShipment`):
 *
 *      const getQuotationRateMock = jest.fn();
 *      const createShipmentMock = jest.fn();
 *      jest.mock("../../src/services/skydropx.service", () => ({
 *        ...jest.requireActual("../../src/services/skydropx.service"),
 *        getQuotationRate: getQuotationRateMock,
 *        createShipment: createShipmentMock,
 *      }));
 *
 * 2. Mockear `global.fetch` — para probar el cliente HTTP en sí (OAuth, throttle, poll).
 *    `buildFetchMock` arma una cola de respuestas JSON que se consumen en orden.
 */
export function buildFetchMock(responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  return jest.fn(async () => {
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  });
}

/** Rate normalizado de ejemplo (forma de `NormalizedShippingRate`) para los tests. */
export function sampleRate(overrides: Record<string, unknown> = {}) {
  return {
    id: "rate_test_1",
    carrier: "dhl",
    service: "Estándar",
    amount: 150,
    total: 150,
    currency: "MXN",
    requiresDropoff: false,
    ...overrides,
  };
}
