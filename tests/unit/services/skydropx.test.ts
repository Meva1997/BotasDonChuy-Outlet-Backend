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
// Desde la Fase N.6 la cotización recibe un arreglo de bultos, no uno solo.
const parcels = [parcel];

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

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));

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

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));

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

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels), 15_000);

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

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));

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

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));
      const byId = Object.fromEntries(result.rates.map((r) => [r.rateId, r]));

      expect(byId["d1"].requiresDropoff).toBe(true);
      expect(byId["d2"].requiresDropoff).toBe(true);
      expect(byId["d3"].requiresDropoff).toBe(true);
      expect(byId["d4"].requiresDropoff).toBe(false);
    });
  });

  describe("envío multi-bulto (Fase N.6)", () => {
    const tresBultos = [
      { weight: 3, length: 40, width: 35, height: 25 },
      { weight: 5, length: 55, width: 40, height: 35 },
      { weight: 2, length: 40, width: 35, height: 25 },
    ];

    it("manda un elemento de `parcels` por bulto, no uno solo apilado", async () => {
      const createResp = { id: "qm1", is_completed: false, rates: [] };
      const pollResp = { id: "qm1", is_completed: true, rates: [rate("r1")] };
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: createResp },
        { body: pollResp },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, tresBultos));

      const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.quotation.parcels).toEqual(tresBultos);
    });

    it("cada tarifa reporta cuántos bultos ampara", async () => {
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: { id: "qm2", is_completed: false, rates: [] } },
        { body: { id: "qm2", is_completed: true, rates: [rate("r1"), rate("r2")] } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(
        skydropx.getShippingRates(addr, addr, tresBultos),
      );

      expect(result.rates).toHaveLength(2);
      expect(result.rates.every((r) => r.packageCount === 3)).toBe(true);
    });

    it("`getQuotationRate` recuerda el número de bultos de la cotización original", async () => {
      // La re-consulta autoritativa de `createOrder` tiene que devolver el mismo conteo que se
      // cotizó: es el que se congela en `Order.packageCount` y el que la guía va a declarar.
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: { id: "qm3", is_completed: false, rates: [] } },
        { body: { id: "qm3", is_completed: true, rates: [rate("r1")] } },
        { body: { id: "qm3", is_completed: true, rates: [rate("r1")] } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
      await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, tresBultos));

      const result = await resolveWithFakeTimers(skydropx.getQuotationRate("qm3", "r1", addr));

      expect(result).toMatchObject({ rateId: "r1", packageCount: 3 });
    });

    it("descarta las tarifas `multishipment` (una guía por bulto: el modelo solo guarda una)", async () => {
      // Un rate `multishipment` crea N guías y este modelo guarda un solo `skydropxShipmentId`
      // por pedido: N−1 quedarían cobradas y sin forma de rastrearlas ni entregarlas.
      const multi = rate("rm", { shipment_creation_type: "multishipment", total: "50.00" });
      const multipackage = rate("rp", { shipment_creation_type: "multipackage", total: "200.00" });
      const single = rate("rs", { shipment_creation_type: "single", total: "300.00" });
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: { id: "qm4", is_completed: false, rates: [] } },
        { body: { id: "qm4", is_completed: true, rates: [multi, multipackage, single] } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(
        skydropx.getShippingRates(addr, addr, tresBultos),
      );

      // La descartada era LA MÁS BARATA: sin el filtro el ordenamiento por precio la habría
      // puesto de primera y el checkout la habría mostrado como la opción recomendada.
      expect(result.rates.map((r) => r.rateId)).toEqual(["rp", "rs"]);
    });

    it("una tarifa sin `shipment_creation_type` sigue siendo utilizable", async () => {
      // El sandbox no siempre manda el campo; ausente no puede leerse como "multishipment" o
      // se descartarían todas las tarifas y la tienda dejaría de cotizar en vivo.
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { body: { id: "qm5", is_completed: false, rates: [] } },
        { body: { id: "qm5", is_completed: true, rates: [rate("r1")] } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));

      expect(result.rates.map((r) => r.rateId)).toEqual(["r1"]);
    });
  });

  describe("createShipment — bultos declarados (Fase N.6)", () => {
    const contacto = {
      name: "Quien sea",
      street1: "Calle 1",
      company: "Botas Don Chuy Outlet",
      phone: "4611234567",
      email: "a@b.com",
      reference: "Centro",
    };

    async function crearGuia(packageCount?: number) {
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        {
          body: {
            data: { id: "shp_1", attributes: { carrier_name: "DHL", workflow_status: "in_progress" } },
          },
        },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
      await resolveWithFakeTimers(
        skydropx.createShipment("r1", contacto, contacto, packageCount),
      );
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      const shipmentCall = calls.find(([url]) => String(url).includes("/api/v1/shipments"))!;
      return JSON.parse(shipmentCall[1].body as string);
    }

    it("declara un `package` por bulto, numerados desde 1", async () => {
      // Declarar menos bultos de los que se entregan es exactamente lo que la paquetería cobra
      // aparte al recibir el envío.
      const body = await crearGuia(3);
      expect(body.shipment.packages).toHaveLength(3);
      expect(body.shipment.packages.map((p: { package_number: string }) => p.package_number)).toEqual([
        "1",
        "2",
        "3",
      ]);
      // El resto del paquete no cambia: la clave SAT de Carta Porte va en cada uno.
      expect(body.shipment.packages.every((p: { consignment_note: string }) => p.consignment_note === "53102400")).toBe(true);
    });

    it("sin `packageCount` declara un solo bulto (pedidos previos a la fase)", async () => {
      const body = await crearGuia();
      expect(body.shipment.packages).toHaveLength(1);
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

    it("un fallo del propio OAuth lleva el path del token, no el de la llamada de negocio", async () => {
      const fetchMock = buildFetchMock([{ status: 401, body: { error: "invalid_client" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      // Distinguirlos importa: un 401 aquí son credenciales mal configuradas (arreglable), no
      // una petición de negocio rechazada.
      await expect(resolveWithFakeTimers(skydropx.getSkydropxCredits())).rejects.toMatchObject({
        name: "SkydropxRequestError",
        status: 401,
        path: "/api/v1/oauth/token",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // ni siquiera se intentó la llamada de negocio
    });
  });

  describe("ensureAccessToken", () => {
    it("deja el token en caché para que la llamada siguiente no lo renueve", async () => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { body: { data: { balance: 1 } } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await resolveWithFakeTimers(skydropx.ensureAccessToken());
      expect(fetchMock).toHaveBeenCalledTimes(1); // solo el OAuth

      await resolveWithFakeTimers(skydropx.getSkydropxCredits());
      expect(fetchMock).toHaveBeenCalledTimes(2); // reusó el token: solo la llamada de negocio
    });

    it("propaga el fallo del token para que `createShipment` no lo confunda con uno de la guía", async () => {
      // Es su razón de existir: resolver el token FUERA del try de `createShipment`, porque un
      // fallo de token nunca es "incierto" — el POST /shipments jamás salió.
      const fetchMock = buildFetchMock([{ status: 500, body: { error: "oauth down" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await expect(resolveWithFakeTimers(skydropx.ensureAccessToken())).rejects.toMatchObject({
        name: "SkydropxRequestError",
        path: "/api/v1/oauth/token",
      });
    });
  });

  describe("getQuotationRate — el destino debe coincidir con el que se cotizó", () => {
    const otraDireccion: SkydropxService.SkydropxAddress = {
      ...addr,
      postal_code: "01000",
      area_level2: "Ciudad de México",
    };

    /** Cotiza de verdad para que el servicio recuerde a qué dirección correspondió `q1`. */
    async function cotizar(fetchMock: ReturnType<typeof buildFetchMock>) {
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
      await resolveWithFakeTimers(skydropx.getShippingRates(addr, addr, parcels));
    }

    function quotationResponses(rates: unknown[]) {
      return [
        { body: oauthBody() },
        { body: { id: "q1", is_completed: false, rates: [] } },
        { body: { id: "q1", is_completed: true, rates } },
        { body: { id: "q1", is_completed: true, rates } }, // la re-consulta de getQuotationRate
      ];
    }

    it("devuelve la tarifa cuando la dirección de la orden es la misma", async () => {
      await cotizar(buildFetchMock(quotationResponses([rate("r1"), rate("r2")])));

      const result = await resolveWithFakeTimers(skydropx.getQuotationRate("q1", "r1", addr));

      expect(result).toMatchObject({ rateId: "r1", total: 120, amount: 100, carrier: "DHL" });
    });

    it("devuelve null si la orden se manda a OTRA dirección, sin consultar a Skydropx", async () => {
      // El fraude que esto tapa: cotizar barato a una dirección cercana y mandar el pedido a
      // otra más cara pagando el envío de la primera.
      const fetchMock = buildFetchMock(quotationResponses([rate("r1")]));
      await cotizar(fetchMock);
      const llamadasTrasCotizar = fetchMock.mock.calls.length;

      const result = await resolveWithFakeTimers(
        skydropx.getQuotationRate("q1", "r1", otraDireccion),
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(llamadasTrasCotizar); // falla cerrado, sin red
    });

    it("devuelve null para una cotización que no recordamos (proceso reiniciado)", async () => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      // Sin el registro en memoria no se puede verificar el destino, así que se falla cerrado
      // (el checkout responde 409 "vuelve a cotizar") en vez de confiar a ciegas.
      const result = await resolveWithFakeTimers(
        skydropx.getQuotationRate("q_desconocida", "r1", addr),
      );

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("devuelve null si el rate ya no está en la cotización", async () => {
      await cotizar(buildFetchMock(quotationResponses([rate("r1")])));

      const result = await resolveWithFakeTimers(skydropx.getQuotationRate("q1", "r_inexistente", addr));

      expect(result).toBeNull();
    });

    it("devuelve null si el rate dejó de ser utilizable (sin montos o fallido)", async () => {
      await cotizar(
        buildFetchMock(
          quotationResponses([rate("r_sin_monto", { amount: null, total: null, success: true })]),
        ),
      );

      const result = await resolveWithFakeTimers(skydropx.getQuotationRate("q1", "r_sin_monto", addr));

      expect(result).toBeNull();
    });
  });

  describe("createShipment", () => {
    const contacto: SkydropxService.SkydropxContact = {
      name: "Don Chuy",
      street1: "Calle Falsa 123",
      company: "Botas Don Chuy",
      phone: "4610000000",
      email: "tienda@test.com",
      reference: "Portón café",
    };

    const respuestaOk = {
      body: {
        data: {
          id: "shipment_123",
          type: "shipment",
          attributes: { carrier_name: "DHL", workflow_status: "in_progress" },
        },
      },
    };

    it("devuelve el id de la guía y la paquetería, con los dos campos que Skydropx no documenta", async () => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }, respuestaOk]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const result = await resolveWithFakeTimers(
        skydropx.createShipment("rate_1", contacto, contacto),
      );

      expect(result).toEqual({ shipmentId: "shipment_123", carrierName: "DHL" });

      // Los dos hallazgos que costaron 422s contra el sandbox: `consignment_note` NO es texto
      // libre (es la clave SAT de Carta Porte) y `package_type` es obligatorio pese a
      // documentarse opcional. Si alguien los "limpia" por parecer mágicos, se rompe la guía.
      // `buildFetchMock` se declara sin parámetros, así que sus `calls` no vienen tipadas.
      const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.shipment.rate_id).toBe("rate_1");
      expect(body.shipment.packages[0]).toEqual({
        package_number: "1",
        package_type: "4G",
        consignment_note: "53102400",
      });
    });

    it("un 422 se propaga tal cual: Skydropx la rechazó, no creó ni cobró nada", async () => {
      const fetchMock = buildFetchMock([
        { body: oauthBody() },
        { status: 422, body: { error: "rate no disponible" } },
      ]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      // NO se envuelve como incierto: es seguro reintentar y liberar el centinela.
      await expect(
        resolveWithFakeTimers(skydropx.createShipment("rate_1", contacto, contacto)),
      ).rejects.toMatchObject({ name: "SkydropxRequestError", status: 422 });
    });

    it.each([
      ["un 408 (timeout del lado de Skydropx)", 408],
      ["un 429 (rate limit: pudo procesarse igual)", 429],
      ["un 500", 500],
      ["un 502", 502],
    ])("%s deja la guía en duda: puede haberse creado y cobrado", async (_caso, status) => {
      const fetchMock = buildFetchMock([{ body: oauthBody() }, { status, body: { error: "x" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await expect(
        resolveWithFakeTimers(skydropx.createShipment("rate_1", contacto, contacto)),
      ).rejects.toMatchObject({ name: "SkydropxShipmentUncertainError" });
    });

    it.each([
      ["ECONNREFUSED", "ECONNREFUSED"],
      ["ENOTFOUND", "ENOTFOUND"],
      ["EAI_AGAIN", "EAI_AGAIN"],
    ])("un %s NO es incierto: la petición nunca salió del proceso", async (_caso, code) => {
      const fetchMock = jest
        .fn()
        // El OAuth sí resuelve (se pide fuera del try, y su fallo nunca sería incierto).
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => oauthBody(),
          text: async () => "",
        } as unknown as Response)
        .mockImplementationOnce(async () => {
          const err = new TypeError("fetch failed") as Error & { cause?: { code: string } };
          err.cause = { code };
          throw err;
        });
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const error = await resolveWithFakeTimers(
        skydropx.createShipment("rate_1", contacto, contacto).catch((e: Error) => e),
      );

      // Se propaga el error crudo: liberar el centinela y reintentar es seguro aquí.
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).name).not.toBe("SkydropxShipmentUncertainError");
    });

    it("un socket cortado a media petición SÍ es incierto (a diferencia de ECONNREFUSED)", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => oauthBody(),
          text: async () => "",
        } as unknown as Response)
        .mockImplementationOnce(async () => {
          const err = new Error("socket hang up") as Error & { cause?: { code: string } };
          err.cause = { code: "ECONNRESET" };
          throw err;
        });
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      await expect(
        resolveWithFakeTimers(skydropx.createShipment("rate_1", contacto, contacto)),
      ).rejects.toMatchObject({ name: "SkydropxShipmentUncertainError" });
    });

    it("un timeout del AbortSignal es incierto y conserva la causa original", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => oauthBody(),
          text: async () => "",
        } as unknown as Response)
        .mockImplementationOnce(async () => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          throw err;
        });
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      const error = (await resolveWithFakeTimers(
        skydropx.createShipment("rate_1", contacto, contacto).catch((e: Error) => e),
      )) as Error & { reason?: Error };

      expect(error.name).toBe("SkydropxShipmentUncertainError");
      expect(error.message).toContain("rate_1");
      // La causa se conserva para que la alerta `fatal` diga qué pasó realmente.
      expect(error.reason).toBeInstanceOf(Error);
    });

    it("un fallo al pedir el token no se disfraza de guía incierta", async () => {
      const fetchMock = buildFetchMock([{ status: 503, body: { error: "oauth down" } }]);
      (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

      // El token se resuelve fuera del try justo para esto: si se marcara incierto, el pedido
      // quedaría bloqueado como "quizá cobrada" cuando la petición nunca salió.
      await expect(
        resolveWithFakeTimers(skydropx.createShipment("rate_1", contacto, contacto)),
      ).rejects.toMatchObject({ name: "SkydropxRequestError", path: "/api/v1/oauth/token" });
    });
  });

  describe("verifySkydropxWebhookSignature", () => {
    const secret = process.env.SKYDROPX_WEBHOOK_SECRET!;
    const body = Buffer.from(JSON.stringify({ data: { type: "packages" } }));

    function firmar(payload: Buffer, key = secret): string {
      return require("crypto").createHmac("sha512", key).update(payload).digest("hex");
    }

    it("acepta una firma HMAC-SHA512 válida sobre el cuerpo crudo", () => {
      expect(skydropx.verifySkydropxWebhookSignature(body, `HMAC ${firmar(body)}`)).toBe(true);
    });

    it("acepta el esquema en minúsculas y con espacios de sobra", () => {
      expect(skydropx.verifySkydropxWebhookSignature(body, `  hmac   ${firmar(body)}  `)).toBe(true);
    });

    it("rechaza una firma calculada con otro secreto", () => {
      expect(
        skydropx.verifySkydropxWebhookSignature(body, `HMAC ${firmar(body, "secreto-ajeno")}`),
      ).toBe(false);
    });

    it("rechaza una firma válida pero de otro cuerpo (manipulación del payload)", () => {
      const otroCuerpo = Buffer.from(JSON.stringify({ data: { type: "shipments" } }));

      expect(skydropx.verifySkydropxWebhookSignature(body, `HMAC ${firmar(otroCuerpo)}`)).toBe(false);
    });

    it("rechaza header ausente, vacío o con otro esquema", () => {
      expect(skydropx.verifySkydropxWebhookSignature(body, undefined)).toBe(false);
      expect(skydropx.verifySkydropxWebhookSignature(body, "")).toBe(false);
      expect(skydropx.verifySkydropxWebhookSignature(body, `Bearer ${firmar(body)}`)).toBe(false);
      expect(skydropx.verifySkydropxWebhookSignature(body, "HMAC")).toBe(false);
    });

    it("rechaza una firma de longitud distinta sin lanzar", () => {
      // `crypto.timingSafeEqual` LANZA si los buffers no miden igual; por eso la longitud se
      // compara antes. Sin ese chequeo esto sería un 500 en vez de un 400.
      expect(() =>
        skydropx.verifySkydropxWebhookSignature(body, "HMAC abc123"),
      ).not.toThrow();
      expect(skydropx.verifySkydropxWebhookSignature(body, "HMAC abc123")).toBe(false);
    });

    it("rechaza una firma que no es hex sin descartar caracteres inválidos", () => {
      // Se comparan las cadenas tal cual: decodificar con Buffer.from(x,"hex") descartaría lo
      // inválido y podría hacer coincidir longitudes por accidente.
      const firmaValida = firmar(body);
      const noHex = "z".repeat(firmaValida.length);

      expect(skydropx.verifySkydropxWebhookSignature(body, `HMAC ${noHex}`)).toBe(false);
    });
  });
});
