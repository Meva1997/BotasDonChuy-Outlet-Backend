import type * as SkydropxService from "../../../src/services/skydropx.service";
import { buildFetchMock } from "../../setup/mocks/skydropx";

/**
 * Parte 7 — cliente HTTP de Skydropx (roadmap-testing.md). Nivel 1: sin BD, sin HTTP
 * real — solo `global.fetch` mockeado. El módulo mantiene estado en memoria (token
 * cacheado, cola de throttle) a nivel de módulo, así que cada test lo re-importa desde
 * cero (`jest.resetModules()`) para no arrastrar estado del test anterior. Se usan
 * fake timers (Jest moderno) para no esperar en tiempo real los 500ms del throttle ni
 * los hasta 8s del poll de cotización.
 */

const addr: SkydropxService.SkydropxAddress = {
  country_code: "MX",
  postal_code: "38000",
  area_level1: "GTO",
  area_level2: "Celaya",
  area_level3: "Centro",
};

const parcel = { weight: 1, length: 10, width: 10, height: 10 };

function oauthBody(expiresIn = 7200) {
  return {
    access_token: `token-${expiresIn}-${Math.random()}`,
    token_type: "bearer",
    expires_in: expiresIn,
    scope: "",
    created_at: Math.floor(Date.now() / 1000),
  };
}

function rate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    success: true,
    status: "success",
    provider_name: "dhl",
    provider_display_name: "DHL",
    provider_service_name: "Estándar",
    provider_service_code: "STD",
    currency_code: "MXN",
    amount: "100.00",
    total: "120.00",
    days: 3,
    pickup: true,
    ...overrides,
  };
}

function pendingRate(id: string) {
  return rate(id, { status: "pending", success: false, amount: null, total: null });
}

/** Avanza el reloj fake en pasos pequeños hasta que la promesa se resuelva o rechace,
 * o hasta agotar `maxMs` (evita colgar el test si algo no se resuelve como se espera). */
async function resolveWithFakeTimers<T>(promise: Promise<T>, maxMs = 15_000, step = 200): Promise<T> {
  let settled = false;
  let result: T | undefined;
  let error: unknown;
  promise.then(
    (r) => {
      settled = true;
      result = r;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += step) {
    await jest.advanceTimersByTimeAsync(step);
  }
  if (!settled) throw new Error("La promesa no se resolvió dentro del presupuesto de fake timers");
  if (error) throw error;
  return result as T;
}

describe("skydropx.service (Parte 7)", () => {
  let skydropx: typeof SkydropxService;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    skydropx = require("../../../src/services/skydropx.service");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("OAuth client_credentials", () => {
    it("cachea el access_token: una segunda llamada no repite el fetch de OAuth", async () => {
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: { data: { balance: 1, currency: "MXN" } } },
        { body: { data: { balance: 2, currency: "MXN" } } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(2); // oauth + request

      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(3); // solo 1 más: el token se reusó
    });

    it("renueva el token ~5 min antes de expirar (expires_in: 7200)", async () => {
      const fetchMock = buildFetchMock([
        { body: oauthBody(7200) },
        { body: { data: { balance: 1 } } },
        { body: { data: { balance: 2 } } },
        { body: oauthBody(7200) },
        { body: { data: { balance: 3 } } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Justo antes del margen de renovación (expiresAt - 5min): sigue usando el token cacheado.
      await jest.advanceTimersByTimeAsync(6899 * 1000);
      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(3); // solo la llamada de negocio, sin oauth nuevo

      // Cruza el margen de renovación: la siguiente llamada debe pedir un token nuevo.
      await jest.advanceTimersByTimeAsync(2 * 1000);
      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(5); // oauth nuevo + la llamada de negocio
    });
  });

  describe("throttle (2 req/s compartido)", () => {
    it("deja pasar al menos 500ms entre cada fetch saliente, incluida la llamada de token", async () => {
      const callTimes: number[] = [];
      let call = 0;
      const fetchMock = jest.fn(async () => {
        callTimes.push(Date.now());
        call += 1;
        const body = call === 1 ? oauthBody() : { data: { balance: call } };
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      });
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await resolveWithFakeTimers(skydropx.getSkydropxCredits()); // oauth + request
      await resolveWithFakeTimers(skydropx.getSkydropxCredits()); // solo request (token cacheado)

      expect(callTimes).toHaveLength(3);
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(500);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(500);
    });
  });

  describe("pollQuotation / getShippingRates", () => {
    it("corta el poll al juntar MIN_READY_RATES (3) tarifas utilizables, sin esperar is_completed", async () => {
      const createResp = { id: "q1", is_completed: false, rates: [] };
      const pollResp = {
        id: "q1",
        is_completed: false,
        rates: [rate("r1"), rate("r2"), rate("r3"), pendingRate("r4")],
      };
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { body: createResp }, { body: pollResp }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcel));

      expect(fetchMock).toHaveBeenCalledTimes(3); // oauth + create + UN solo poll
      expect(result.rates).toHaveLength(3);
    });

    it("trata un rates:[] en la primera lectura como pendiente, no como resuelto", async () => {
      const createResp = { id: "q2", is_completed: false, rates: [] };
      const firstPoll = { id: "q2", is_completed: false, rates: [] };
      const secondPoll = { id: "q2", is_completed: true, rates: [rate("r1"), rate("r2")] };
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: createResp },
        { body: firstPoll },
        { body: secondPoll },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcel));

      // Si el array vacío se tratara como "resuelto", el poll habría cortado tras el
      // primer GET (3 fetch calls) devolviendo 0 tarifas en vez de esperar la segunda lectura.
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.rates).toHaveLength(2);
    });

    it("agota POLL_TIMEOUT_MS (8s) y devuelve lo que ya se resolvió si ninguna tarifa junta el mínimo", async () => {
      const createResp = { id: "q3", is_completed: false, rates: [] };
      const alwaysPending = {
        id: "q3",
        is_completed: false,
        rates: [rate("r1"), pendingRate("r2")], // 1 utilizable, nunca llega a MIN_READY_RATES (3)
      };
      // Cola larga: de sobra para cubrir ~8 polls (1 cada segundo) sin que buildFetchMock
      // se quede sin respuestas (su default es {status:200, body:{}}, que rompería el shape).
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: createResp },
        ...Array.from({ length: 15 }, () => ({ body: alwaysPending })),
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcel), 15_000);

      // Debe haber reintentado el poll varias veces (no solo una) antes de agotar el timeout.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2 + 6);
      // Y devolver la única tarifa utilizable que sí se resolvió, en vez de quedarse colgado o tirar error.
      expect(result.rates).toHaveLength(1);
      expect(result.rates[0].rateId).toBe("r1");
    });
  });

  describe("isUsableRate / normalizeRate", () => {
    it("parsea amount/total de string a number, ordena ascendente por total y recorta a MAX_RATES_RETURNED (5)", async () => {
      const rates = [
        rate("a", { total: "500.00", amount: "480.00" }),
        rate("b", { total: "100.00", amount: "90.00" }),
        rate("c", { total: "300.00", amount: "280.00" }),
        rate("d", { total: "200.00", amount: "190.00" }),
        rate("e", { total: "400.00", amount: "390.00" }),
        rate("f", { total: "150.00", amount: "140.00" }),
      ];
      const createResp = { id: "q4", is_completed: false, rates: [] };
      const pollResp = { id: "q4", is_completed: true, rates };
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { body: createResp }, { body: pollResp }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcel));

      expect(result.rates).toHaveLength(5); // se descarta la más cara (500), quedan las 5 baratas
      expect(result.rates.map((r) => r.total)).toEqual([100, 150, 200, 300, 400]);
      expect(result.rates.every((r) => typeof r.total === "number" && typeof r.amount === "number")).toBe(
        true,
      );
    });
  });

  describe("requiresDropoff (señal combinada)", () => {
    it("es true con pickup:false, true con el regex de 'sin recolección' aunque pickup sea true, y false en el resto", async () => {
      const withPickupFalse = rate("d1", { pickup: false, provider_service_name: "Express" });
      const withRegexNameAccented = rate("d2", {
        pickup: true,
        provider_service_name: "Sin recolección Express",
      });
      const withRegexNameNoAccent = rate("d3", {
        pickup: true,
        provider_service_name: "SIN RECOLECCION",
      });
      const normalService = rate("d4", { pickup: true, provider_service_name: "Estándar" });

      const createResp = { id: "q5", is_completed: false, rates: [] };
      const pollResp = {
        id: "q5",
        is_completed: true,
        rates: [withPickupFalse, withRegexNameAccented, withRegexNameNoAccent, normalService],
      };
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { body: createResp }, { body: pollResp }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcel));
      const byId = Object.fromEntries(result.rates.map((r) => [r.rateId, r]));

      expect(byId["d1"].requiresDropoff).toBe(true);
      expect(byId["d2"].requiresDropoff).toBe(true);
      expect(byId["d3"].requiresDropoff).toBe(true);
      expect(byId["d4"].requiresDropoff).toBe(false);
    });
  });

  describe("SkydropxRequestError", () => {
    it("conserva el status HTTP de un 4xx (bug de integración nuestro)", async () => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { status: 422, body: { error: "bad" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await expect(resolveWithFakeTimers(skydropx.getSkydropxCredits())).rejects.toMatchObject({
        name: "SkydropxRequestError",
        status: 422,
      });
    });

    it("conserva el status HTTP de un 5xx (falla transitoria)", async () => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { status: 503, body: { error: "down" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await expect(resolveWithFakeTimers(skydropx.getSkydropxCredits())).rejects.toMatchObject({
        name: "SkydropxRequestError",
        status: 503,
      });
    });
  });
});
