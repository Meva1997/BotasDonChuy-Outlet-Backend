import {
  SKYDROPX_BASE_URL,
  SKYDROPX_CARRIERS,
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
// presupuesto de pollQuotation (POLL_TIMEOUT_MS) — ese presupuesto solo se
// revisa ENTRE intentos, no dentro de uno.
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
  // Bandera de recolección de Skydropx (confirmada en el rate crudo del sandbox,
  // 2026-07-20): `true` = la paquetería pasa a recoger el paquete al domicilio de
  // origen; `false` = NO hay recolección, el dueño debe llevar el paquete a la
  // sucursal. Es información operativa que solo le sirve al dueño (ver
  // `requiresDropoff` en `NormalizedShippingRate`), nunca al comprador.
  pickup: boolean | null;
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
  // `true` cuando el servicio NO incluye recolección a domicilio: el dueño tiene
  // que llevar el paquete a la sucursal de la paquetería. Dato operativo para el
  // panel de admin, no para el checkout del cliente. Se persiste en la orden
  // (`Order.shippingRequiresDropoff`) desde la re-consulta autoritativa de
  // `getQuotationRate` en `createOrder` — nunca desde un valor que mande el cliente.
  requiresDropoff: boolean;
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

/**
 * `GET /api/v1/quotations/{id}` NO devuelve la dirección de destino cotizada
 * (verificado contra sandbox real: el objeto solo trae `address_template_to_id`,
 * `null` salvo que se usen templates de dirección) — así que no hay forma de
 * re-validar contra Skydropx que el `quotationId`/`rateId` que llega en
 * `POST /api/orders` corresponde a la MISMA dirección que el cliente puso en la
 * orden. Sin este chequeo, alguien podría cotizar barato a una dirección y pagar
 * ese envío mientras la orden se manda a otra distinta (más cara).
 *
 * Por eso `getShippingRates` recuerda aquí, en memoria, a qué dirección
 * correspondió cada `quotationId` que devolvimos al cliente, y `getQuotationRate`
 * exige que la dirección de la orden coincida exactamente. TTL de 24h (la
 * vigencia documentada de una cotización, ver roadmap-skydropx.md §8) con barrido
 * oportunista en cada inserción — no amerita un cron aparte, el volumen es uno
 * por cotización pedida. Si el proceso se reinicia entre cotizar y pagar, el
 * registro se pierde y `getQuotationRate` falla cerrado (null → 409 "vuelve a
 * cotizar") en vez de confiar ciegamente en un `quotationId` que ya no puede
 * verificar.
 */
const QUOTATION_ADDRESS_TTL_MS = 24 * 60 * 60 * 1000;
const quotationDestinations = new Map<
  string,
  { address: SkydropxAddress; recordedAt: number }
>();

function rememberQuotationDestination(quotationId: string, address: SkydropxAddress): void {
  const now = Date.now();
  for (const [id, entry] of quotationDestinations) {
    if (now - entry.recordedAt > QUOTATION_ADDRESS_TTL_MS) quotationDestinations.delete(id);
  }
  quotationDestinations.set(quotationId, { address, recordedAt: now });
}

function sameAddress(a: SkydropxAddress, b: SkydropxAddress): boolean {
  return (
    a.postal_code === b.postal_code &&
    a.area_level1 === b.area_level1 &&
    a.area_level2 === b.area_level2 &&
    a.area_level3 === b.area_level3
  );
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
        // Restringe las paqueterías a cotizar cuando SKYDROPX_CARRIERS está
        // definido (menos proveedores = respuesta más rápida). Sin él, Skydropx
        // cotiza todas y el controlador recorta a las más baratas.
        ...(SKYDROPX_CARRIERS ? { requested_carriers: SKYDROPX_CARRIERS } : {}),
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
// Corte temprano: en cuanto haya esta cantidad de tarifas utilizables no hace
// falta seguir esperando a las paqueterías que sigan `pending` — le mostramos
// al cliente las que ya se resolvieron en vez de agotar el timeout completo por
// una sola que quedó colgada. Es la mayor ganancia de latencia del endpoint.
const MIN_READY_RATES = 3;
// Tope de opciones que se le devuelven al checkout (las más baratas). Garantiza
// una lista corta aun cuando SKYDROPX_CARRIERS no esté configurado y Skydropx
// cotice muchas paqueterías.
const MAX_RATES_RETURNED = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tarifa lista para mostrar: resuelta (no `pending`), exitosa y con montos. */
function isUsableRate(r: SkydropxRate): boolean {
  return r.status !== "pending" && r.success && r.amount != null && r.total != null;
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
    // Devolvemos si ya se resolvieron todas (is_completed / nada pending) o si
    // ya juntamos suficientes tarifas utilizables — no esperamos a las colgadas.
    if (last.is_completed || !stillPending) return last;
    if (last.rates.filter(isUsableRate).length >= MIN_READY_RATES) return last;
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
  rememberQuotationDestination(created.id, addressTo);
  const resolved = await pollQuotation(created.id);

  // Ordenadas de más barata a más cara y recortadas a MAX_RATES_RETURNED: el
  // checkout solo debe mostrar un puñado de opciones (3-5), y las de hasta
  // arriba son las que al cliente le interesan.
  const rates = resolved.rates
    .filter(isUsableRate)
    .map(normalizeRate)
    .sort((a, b) => a.total - b.total)
    .slice(0, MAX_RATES_RETURNED);

  return { quotationId: resolved.id, rates };
}

/**
 * Detecta si un rate NO incluye recolección a domicilio (el dueño debe llevar el
 * paquete a la sucursal). Señal combinada a propósito: `pickup === false` es el
 * campo estructurado de Skydropx, pero en el sandbox algunos servicios llamados
 * literalmente "Sin recolección" venían con `pickup: true` (valores de plantilla
 * en rates `success: false`), así que se refuerza con el nombre del servicio. El
 * costo de un falso negativo (no avisarle al dueño de un envío que él tiene que
 * llevar) es que el paquete nunca sale, así que se prefiere sobre-avisar.
 */
function rateRequiresDropoff(r: SkydropxRate): boolean {
  return r.pickup === false || /sin\s+recolecci[oó]n/i.test(r.provider_service_name ?? "");
}

function normalizeRate(r: SkydropxRate): NormalizedShippingRate {
  return {
    rateId: r.id,
    carrier: r.provider_display_name,
    service: r.provider_service_name,
    amount: parseFloat(r.amount!),
    total: parseFloat(r.total!),
    days: r.days,
    requiresDropoff: rateRequiresDropoff(r),
  };
}

/**
 * Re-consulta una cotización ya existente y devuelve la tarifa `rateId` elegida,
 * normalizada — o `null` si esa tarifa ya no está disponible (cotización expirada,
 * rate inexistente, dejó de resolver con éxito, o `destinationAddress` no coincide
 * con la dirección para la que se cotizó, ver `rememberQuotationDestination`). Es
 * la fuente autoritativa del costo de envío en `createOrder` (Fase 8.4): el
 * cliente manda `quotationId`/`rateId`, pero el monto cobrado sale SIEMPRE de
 * aquí, nunca de un total que envíe el cliente — misma regla que `computeTotals`
 * aplica a `subtotal`/`savings`. El chequeo de dirección extiende esa misma regla
 * al destino: sin él, alguien podría cotizar barato a una dirección y pagar ese
 * envío mientras la orden se manda a otra.
 *
 * Un solo `GET` basta (sin poll): el cliente solo pudo elegir una tarifa que ya se
 * había resuelto (`success: true`), así que re-leerla no requiere esperar a que
 * ninguna paquetería siga `pending`.
 */
export async function getQuotationRate(
  quotationId: string,
  rateId: string,
  destinationAddress: SkydropxAddress,
): Promise<NormalizedShippingRate | null> {
  const remembered = quotationDestinations.get(quotationId);
  if (!remembered || !sameAddress(remembered.address, destinationAddress)) {
    return null;
  }

  const quotation = await skydropxRequest<SkydropxQuotationResponse>(
    `/api/v1/quotations/${quotationId}`,
  );
  const rate = quotation.rates.find((r) => r.id === rateId);
  if (!rate || !rate.success || rate.amount == null || rate.total == null) {
    return null;
  }
  return normalizeRate(rate);
}
