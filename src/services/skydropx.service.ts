import {
  SKYDROPX_BASE_URL,
  SKYDROPX_CLIENT_ID,
  SKYDROPX_CLIENT_SECRET,
  SHIP_FROM_CITY,
  SHIP_FROM_NEIGHBORHOOD,
  SHIP_FROM_POSTAL_CODE,
  SHIP_FROM_STATE,
} from "../config/skydropx";
import type { Parcel } from "./packing";

/**
 * Cliente HTTP compartido para la API de Skydropx Pro (Fase 8.1).
 *
 * Autenticación OAuth2 `client_credentials`: el token expira en 2h
 * (`expires_in: 7200`), así que se cachea en memoria y se renueva ~5 min antes
 * de expirar. Todas las llamadas (incluida la de token) pasan por `throttle()`
 * para respetar el límite documentado de 2 requests/segundo de la cuenta.
 *
 * Recordatorio: `.env` apunta a la cuenta SANDBOX por defecto (ver roadmap-skydropx.md
 * §1) — `POST /shipments` en desarrollo gasta saldo de prueba, no real. La cuenta de
 * producción no tiene sandbox propio, así que antes de lanzar hay que cambiar `.env`
 * a las credenciales `_PROD` y retomar la cautela con `POST /shipments`.
 * `getSkydropxCredits` es de solo lectura y gratis, útil para monitorear saldo (§8).
 */

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  created_at: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // renovar 5 min antes de expirar
const MIN_REQUEST_INTERVAL_MS = 500; // 2 req/s
// Acota cada fetch individual: sin esto, una conexión colgada (TCP/TLS sin
// respuesta ni error) bloquearía el request indefinidamente, sin importar el
// presupuesto de 8s de pollQuotation — ese presupuesto solo se revisa ENTRE
// intentos, no dentro de uno.
const REQUEST_TIMEOUT_MS = 5000;

/** Error tipado de Skydropx: conserva el status HTTP para que el llamador pueda
 * distinguir una falla transitoria (red/5xx/timeout) de un request mal armado
 * de nuestro lado (4xx) en vez de tratarlas igual. */
export class SkydropxRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SkydropxRequestError";
  }
}

let cachedToken: CachedToken | null = null;
let refreshPromise: Promise<CachedToken> | null = null;

let lastRequestAt = 0;
let throttleQueue: Promise<void> = Promise.resolve();

/** Serializa las llamadas salientes con al menos 500ms entre cada una (2 req/s). */
function throttle(): Promise<void> {
  const next = throttleQueue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();
  });
  throttleQueue = next;
  return next;
}

async function fetchAccessToken(): Promise<CachedToken> {
  await throttle();
  const response = await fetch(`${SKYDROPX_BASE_URL}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SKYDROPX_CLIENT_ID,
      client_secret: SKYDROPX_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new SkydropxRequestError(
      `Skydropx OAuth falló (${response.status}): ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as OAuthTokenResponse;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/** Token vigente, cacheado en memoria. Dedupe: dos refresh concurrentes comparten la misma llamada. */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.accessToken;
  }
  if (!refreshPromise) {
    refreshPromise = fetchAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  cachedToken = await refreshPromise;
  return cachedToken.accessToken;
}

/**
 * Request autenticado y limitado a 2 req/s contra la API de Skydropx Pro.
 * Reutilizable por los servicios de cotización/guías (Fase 8.3+).
 */
export async function skydropxRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const accessToken = await getAccessToken();
  await throttle();

  const response = await fetch(`${SKYDROPX_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new SkydropxRequestError(
      `Skydropx ${init.method ?? "GET"} ${path} falló (${response.status}): ${body}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export interface SkydropxCredits {
  data: { balance: number; currency: string };
}

/** GET /api/v1/finance/credits — saldo de la cuenta, para verificar Fase 8.1 y monitorear gasto (§8). */
export async function getSkydropxCredits(): Promise<SkydropxCredits> {
  return skydropxRequest<SkydropxCredits>("/api/v1/finance/credits");
}

/**
 * Cotización (Fase 8.3).
 *
 * El shape de `POST /api/v1/quotations` está documentado de forma inconsistente
 * (Context7 `/websites/pro_skydropx_es-mx_api-docs` mezcla ejemplos con `from`/
 * `to`/`parcel` planos y otros con `quotation: { address_from, address_to,
 * parcels }`). Se verificó contra la cuenta sandbox real (2026-07-17): el shape
 * envuelto en `quotation` con `area_level1/2/3` es el correcto — una cotización
 * de prueba Celaya→CDMX devolvió tarifas reales de DHL/Paquetexpress con este
 * formato exacto. Los campos de dirección usados aquí (`country_code`,
 * `postal_code`, `area_level1/2/3`) bastan para cotizar; `name`/`phone`/`street`
 * solo son necesarios para crear la guía (Fase 8.5).
 */
export interface SkydropxAddress {
  country_code: string;
  postal_code: string;
  area_level1: string;
  area_level2: string;
  area_level3: string;
}

interface SkydropxRate {
  id: string;
  success: boolean;
  status: string;
  provider_name: string;
  provider_display_name: string;
  provider_service_name: string;
  provider_service_code: string;
  currency_code: string | null;
  amount: string | null;
  total: string | null;
  days: number | null;
}

interface SkydropxQuotationResponse {
  id: string;
  is_completed: boolean;
  rates: SkydropxRate[];
}

export interface NormalizedShippingRate {
  rateId: string;
  carrier: string;
  service: string;
  amount: number;
  total: number;
  days: number | null;
}

/** Dirección de origen (tienda), tomada de `SHIP_FROM_*` (ver config/skydropx.ts). */
export function getOriginAddress(): SkydropxAddress {
  return {
    country_code: "MX",
    postal_code: SHIP_FROM_POSTAL_CODE,
    area_level1: SHIP_FROM_STATE,
    area_level2: SHIP_FROM_CITY,
    area_level3: SHIP_FROM_NEIGHBORHOOD,
  };
}

/** Dirección de destino a partir de los datos de envío del cliente (checkout). */
export function toSkydropxAddress(customer: {
  postalCode: string;
  state: string;
  city: string;
  neighborhood: string;
}): SkydropxAddress {
  return {
    country_code: "MX",
    postal_code: customer.postalCode,
    area_level1: customer.state,
    area_level2: customer.city,
    area_level3: customer.neighborhood,
  };
}

async function createQuotation(
  addressFrom: SkydropxAddress,
  addressTo: SkydropxAddress,
  parcel: Parcel,
): Promise<SkydropxQuotationResponse> {
  return skydropxRequest<SkydropxQuotationResponse>("/api/v1/quotations", {
    method: "POST",
    body: JSON.stringify({
      quotation: {
        address_from: addressFrom,
        address_to: addressTo,
        parcels: [parcel],
      },
    }),
  });
}

const POLL_INTERVAL_MS = 1000;
// Verificado contra sandbox: algunas tarifas quedan "pending" indefinidamente
// (timeouts internos del lado de Skydropx, ajenos a nosotros) sin que
// `is_completed` llegue a ser `true`. Por eso el poll no espera la resolución
// total: agota el presupuesto de tiempo y devuelve lo que ya se resolvió.
const POLL_TIMEOUT_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollQuotation(quotationId: string): Promise<SkydropxQuotationResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: SkydropxQuotationResponse;
  do {
    last = await skydropxRequest<SkydropxQuotationResponse>(
      `/api/v1/quotations/${quotationId}`,
    );
    // `rates` vacío significa "ninguna paquetería ha respondido todavía", no
    // "ya se resolvió" — `.some()` sobre un array vacío da `false`, así que sin
    // este chequeo explícito el primer poll (a menudo con `rates: []` recién
    // creada la cotización) se leería como "nada pendiente" y cortaría el poll
    // antes de que cualquier tarifa llegara.
    const stillPending =
      last.rates.length === 0 || last.rates.some((r) => r.status === "pending");
    if (last.is_completed || !stillPending) return last;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return last;
}

/**
 * Cotiza un envío: crea la cotización y hace poll hasta que se resuelva (o se
 * agote el timeout). Devuelve solo las tarifas exitosas (`success: true`,
 * `amount`/`total` no nulos) normalizadas — las que quedaron `no_coverage`,
 * `not_applicable` o `pending` tras el timeout se descartan. Puede devolver un
 * array vacío si ninguna paquetería cotizó a tiempo; el llamador decide si eso
 * amerita el fallback de tarifa plana.
 */
export async function getShippingRates(
  addressFrom: SkydropxAddress,
  addressTo: SkydropxAddress,
  parcel: Parcel,
): Promise<{ quotationId: string; rates: NormalizedShippingRate[] }> {
  const created = await createQuotation(addressFrom, addressTo, parcel);
  const resolved = await pollQuotation(created.id);

  const rates = resolved.rates
    .filter((r) => r.success && r.amount != null && r.total != null)
    .map((r) => ({
      rateId: r.id,
      carrier: r.provider_display_name,
      service: r.provider_service_name,
      amount: parseFloat(r.amount!),
      total: parseFloat(r.total!),
      days: r.days,
    }));

  return { quotationId: resolved.id, rates };
}
