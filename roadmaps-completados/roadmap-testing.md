# ROADMAP — Testing automatizado del backend (Fase H.1)

Expansión ejecutable de la **Fase H.1** de [roadmap-hardening.md](roadmap-hardening.md), desglosada
en **partes independientes** (una función/feature por entrega) para irla cubriendo de a poco. No se
persigue 100% de cobertura: se cubre **lo que más cuesta romper en silencio** — descuento atómico de
stock, idempotencia de webhooks, recálculo de totales y auth — y se deja fuera, a propósito, lo que
cambia seguido o tiene bajo ROI de prueba.

> **Cómo usarlo:** marca `[x]` cada tarea al completarla. Las partes tienen un orden recomendado
> (0 → 10), pero salvo la Parte 0 (infra, prerequisito de todo) no están encadenadas: puedes hacer la
> de auth antes que la de checkout si lo prefieres.

---

## Decisiones de diseño (fijadas)

- **Herramientas:** `jest` + `ts-jest` + `supertest`. Decidido en H.1: es el combo que domina las
  vacantes de Node/Express y el que cualquiera que audite el repo reconoce
  (`request(app).post('/api/orders')`). Se prioriza esa señal sobre la fricción de configurar
  `ts-jest` con `strict`.
- **Tests fuera de `src/`** (en `tests/`): `tsc` compila `src/`→`dist/`; un test dentro de `src/`
  acabaría en el build de producción. Fuera, `ts-jest` los transpila en memoria y `tsc` los ignora.
- **BD real de test (Postgres), nunca sqlite:** el código depende de features Postgres-específicas
  (`ENUM`, `JSONB`, `literal('stock - N')`).
- **Se mockean SIEMPRE los 3 sistemas externos** que cuestan dinero o mandan correos reales:
  **Stripe, Skydropx (`fetch`/servicio), Resend (`sendEmail`)**. La **BD no se mockea**.
- **Tres niveles de prueba**, cada comportamiento en el que le toca:
  1. **Unit puro** (sin BD): importar y llamar la función. `cart`, `forecast`, `formatMoney`, `date`.
  2. **Integración HTTP** (`request(app)...` + Postgres de test real): el flujo completo
     ruta→middleware→controller→service→BD. `auth`, `checkout`.
  3. **Servicio + SDK mockeado** (concurrencia/idempotencia que no pasa por HTTP): llamar el service
     directo con `Promise.all` y BD real, con los SDK externos mockeados. `webhooks`.

**No se testea el controller aislado con mocks de todo** — la lógica vive en los services (nivel 1/3)
y el flujo HTTP se prueba de punta a punta con Supertest (nivel 2).

---

## Estructura

```
backend/
├─ jest.config.ts            preset ts-jest, setupFiles, testMatch tests/**
├─ tsconfig.jest.json        extiende tsconfig base; rootDir "." + types jest/node
├─ .env.test                 gitignored — llaves dummy + DATABASE_URL de test
├─ tests/
│  ├─ setup/
│  │  ├─ env.ts              carga .env.test (override) + NODE_ENV=test, antes de todo
│  │  ├─ db.ts               setupTestDatabase / truncateAll / closeTestDatabase
│  │  ├─ factories.ts        createProduct / createAdminUser / createOrder / createOrderItem
│  │  └─ mocks/{stripe,skydropx,resend}.ts   builders reutilizables de mocks
│  ├─ smoke/health.test.ts   import app + GET /health (valida el arranque en test)
│  ├─ unit/                  nivel 1 — sin BD
│  │  ├─ services/{cart,forecast}.test.ts
│  │  └─ utils/{formatMoney,date}.test.ts
│  └─ integration/           niveles 2/3 — Postgres de test
│     ├─ auth.test.ts
│     ├─ checkout.test.ts
│     ├─ webhooks.test.ts
│     └─ cancelOrder.test.ts
```

**Correr:** `pnpm test` (todo), `pnpm test:watch`, o `pnpm test <patrón>` (una parte). Las suites
unitarias (`unit/`, `smoke/health`) corren **sin Postgres**; solo las de `integration/` requieren la
BD de `.env.test` levantada (ver la nota en `db.ts`: `sync({ force: true })` BORRA y recrea tablas,
por eso `DATABASE_URL` debe apuntar a una BD dedicada de pruebas).

---

## Estado (de un vistazo)

| Parte | Qué cubre | Nivel | Estado |
|---|---|---|---|
| **0** | Infra (jest, ts-jest, supertest, setup, smoke) | — | ✅ Hecho |
| **0.5** | BD de test dedicada (crear el Postgres de pruebas) — prerequisito de 2-4 | — | ✅ Hecho |
| **1** | Servicios puros (`cart`, `forecast`, `formatMoney`, `date`) | Unit | ✅ Hecho |
| **2** | Auth (login anti-enumeración, reset code) | Integración | ✅ Hecho |
| **3** | Checkout (stock atómico, totales, refine shipping) | Integración | ✅ Hecho |
| **4** | Idempotencia de webhooks (pago, guía, estado de envío) | Servicio + mock | ✅ Hecho |
| **5** | Cancelación/reembolso manual + release de stock (opcional) | Servicio + mock | ✅ Hecho |
| **6** | Envío en vivo (`POST /api/shipping/rates`, fallback a tarifa plana) | Integración | ✅ Hecho |
| **7** | Cliente HTTP de Skydropx (OAuth, throttle, poll de cotización) | Unit (fetch mock) | ✅ Hecho |
| **8** | CRUD admin de productos + imágenes (Cloudinary mockeado) | Integración | ✅ Hecho |
| **9** | Marca y usuarios admin (brand, logo, adminUser, account) | Integración | ✅ Hecho |
| **10** | Agregaciones de dashboard y reports (invariantes, no cifras exactas) | Unit | ✅ Hecho |

---

## Partes

### Parte 0 — Infra (bootstrap) — ✅ Hecho

- [x] Instalar `jest` + `ts-jest` + `@types/jest` + `supertest` + `@types/supertest`; `pnpm test` →
  `jest` (+ `test:watch`).
- [x] `jest.config.ts` (preset ts-jest vía `transform`, `setupFiles`, `testMatch: tests/**`) +
  `tsconfig.jest.json` (extiende el base, `rootDir: "."`, `types: [jest, node]`).
- [x] Gate `NODE_ENV !== "test"` en `src/app.ts`: `connectDB()`, `startPendingOrderSweeper()`,
  `app.listen(...)` y el apagado ordenado quedan encapsulados; Supertest importa `app` sin abrir
  puerto ni BD. `export default app` ya existía.
- [x] `.env.test` (gitignored) con llaves dummy que satisfacen el fail-fast de cada `config/*` +
  `DATABASE_URL` de test.
- [x] `tests/setup/`: `env.ts`, `db.ts` (`setupTestDatabase`/`truncateAll`/`closeTestDatabase`),
  `factories.ts`, `mocks/{stripe,skydropx,resend}.ts` (builders reutilizables).
- [x] Smoke: `unit/utils/formatMoney.test.ts` + `smoke/health.test.ts` (import de `app` + `GET
  /health`). `pnpm test` en verde; `pnpm build` intacto.

**Verificado:** `pnpm test` → 3 tests verdes; `pnpm build` → exit 0.

---

### Parte 0.5 — Base de datos de test dedicada — ✅ Hecho

> **Recordatorio para no olvidarlo:** las suites de **integración** (Partes 2, 3 y 4) corren contra
> un **Postgres real de pruebas**, no un mock — el código depende de features Postgres-específicas
> (`ENUM`, `JSONB`, `literal('stock - N')`) que sqlite/mocks no reproducen. Antes de arrancar la
> Parte 2 hay que **crear esa base de datos**, aún no existe.

- [x] Crear la BD de pruebas apuntada por `DATABASE_URL` en `.env.test`
  (hoy `botasdonchuy_test` en el Postgres local):

  ```bash
  createdb botasdonchuy_test          # o: psql -c 'CREATE DATABASE botasdonchuy_test;'
  ```

- [x] Confirmar que `.env.test` tiene el `DATABASE_URL` correcto (usuario/password/host/puerto de tu
  Postgres local) apuntando a **esa** BD dedicada.
- [x] Verificar la conexión: la primera suite de integración (`beforeAll(setupTestDatabase)`) hace
  `authenticate()` + `sync({ force: true })`. Si conecta y crea las tablas, la BD está lista.

> ⚠️ **Nunca apuntes `DATABASE_URL` de `.env.test` a la BD de desarrollo o producción.**
> `setupTestDatabase()` corre `sync({ force: true })`, que **BORRA y recrea todas las tablas** en
> cada corrida de suite. Debe ser una BD exclusiva para tests, desechable.

**Verificado:** el Postgres local no tiene un rol `postgres` (solo `alexmedina`, superuser, sin
password — igual que el `.env` de dev), así que `.env.test`'s `DATABASE_URL` se corrigió a
`postgres://alexmedina@localhost:5432/botasdonchuy_test` tras crear la BD con `createdb`. Un script
desechable ejercitando `setupTestDatabase()`/`closeTestDatabase()` (el mismo camino que usarán las
suites de integración) confirmó `authenticate()` + `sync({ force: true })` en verde. Esa corrida
reveló que `tests/setup/db.ts` solo importaba `models/associations` (que registra
Product/ProductSize/Order/OrderItem, no AdminUser/BrandSettings) — `\dt` mostraba 4 tablas en vez de
6. Se corrigió agregando el mismo set de imports de modelo que `src/app.ts` hace; una segunda corrida
confirmó las 6 tablas (`products`, `product_sizes`, `orders`, `order_items`, `adminusers`,
`brand_settings`). `pnpm test` (unit + smoke) sigue en verde.

**Verifica:** con la BD creada, `pnpm test auth` (Parte 2) conecta y corre en verde. Sin la BD, las
suites `unit/` y `smoke/` siguen pasando (no la necesitan), pero las de `integration/` fallan al
conectar — es la señal de que falta este paso.

---

### Parte 1 — Servicios puros (sin BD) — ✅ Hecho

- [x] `src/services/cart.ts`: `computeTotals` (subtotal / savings / total con precio de venta vs
  original) y `computeShipping` (tarifa plana). Casos: carrito vacío, con descuento, sin descuento,
  varias líneas.
- [x] `src/services/forecast.ts`: `computeForecast` en sus **3 ramas** — 1-2 meses
  (`simpleAverage`, confianza baja), 3 (`weightedTrend` + dirección de tendencia, media), 4+
  (`exponentialSmoothing` de Holt, alta); serie vacía → `0` / "Sin datos".
- [x] `src/utils/formatMoney.ts`: es-MX, 2 decimales, separador de miles, negativos.
- [x] `src/utils/date.ts`: `isoDay` / `isoMonth` / `formatShortDate` / `formatMonthLabel` **pinados
  a UTC**. Probar con una fecha cercana a medianoche que, en un host al oeste de UTC, retrocedería un
  día si no estuviera el `timeZone: "UTC"` (el bug real que motivó el pin).

**Verificado:** `pnpm test unit` → 4 suites / 36 tests en verde sin Postgres levantado
(`tests/unit/services/cart.test.ts`, `tests/unit/services/forecast.test.ts`,
`tests/unit/utils/formatMoney.test.ts` ampliado, `tests/unit/utils/date.test.ts` nuevo). Los casos de
`forecast`'s ramas 2 y 3 (`weightedTrend`, `exponentialSmoothing`) se calcularon a mano contra series
lineales/constantes para fijar el valor exacto esperado, no solo el signo de la tendencia. `pnpm test`
completo (37 tests, 5 suites) y `pnpm build` siguen en verde.

**Verifica:** `pnpm test unit` en verde sin Postgres levantado.

---

### Parte 2 — Auth (integración HTTP) — ✅ Hecho

- [x] `POST /api/auth/login`: password correcta → `{ token, user }`; **email desconocido y password
  incorrecta devuelven el MISMO `401` byte-idéntico** (anti-enumeración, `auth.controller.ts:40`).
- [x] `assertValidResetCode` (vía `POST /api/auth/verify-reset-code` y `reset-password`): código
  válido pasa; agota `RESET_CODE_MAX_ATTEMPTS` (5) y bloquea (quema el código); mensaje **idéntico**
  en los casos missing-user / wrong-code / expired.

**Ref:** `src/controllers/auth.controller.ts`, `src/utils/resetCode.ts`. Usa la factory
`createAdminUser` (hash bcrypt real). Primera suite con BD → `beforeAll(setupTestDatabase)`,
`afterEach(truncateAll)`, `afterAll(closeTestDatabase)`.

**Verificado:** `tests/integration/auth.test.ts` (6 tests) — login con password correcta; login con
email desconocido y password incorrecta comparados **byte a byte** (`toEqual` sobre el `body`
completo, no solo el string del mensaje); `verify-reset-code` con código válido (y que no lo
consume); mensaje idéntico entre correo inexistente / código incorrecto / código expirado; los
`RESET_CODE_MAX_ATTEMPTS` (5) intentos fallidos queman el código (`resetPasswordCodeHash` vuelve a
`null` en BD) y el código original ya quemado sigue devolviendo el mismo mensaje; `reset-password`
con código válido actualiza la contraseña (login posterior con la nueva password) y la quema (un
segundo uso del mismo código falla). Los códigos de prueba se fijan directo en la fila
(`user.update({ resetPasswordCodeHash: hashResetCode(code), ... })`) en vez de pasar por
`forgot-password` + Resend, para no depender del mock de email en esta parte. `authRateLimiter`
(10 req/15 min, instancia única compartida por las 4 rutas de `auth.routes.ts`) se mockea con
`jest.mock("express-rate-limit", ...)` — la suite hace bastantes más de 10 requests y el propio
rate limiter la haría fallar con 429 antes de ejercitar la lógica real; probar el rate limit no es
parte de esta entrega. Prueba negativa manual: reemplazar el 401 de "email desconocido" en
`auth.controller.ts` por un mensaje distinto puso el test de anti-enumeración en rojo, confirmando
que el `toEqual` sobre el body completo sí detecta la fuga (revertido después). De paso se corrigió
un bug preexistente en `tests/setup/factories.ts` (Parte 1): importaba `Product`/`ProductSize`/
`AdminUser`/`Order`/`OrderItem` como default export cuando los modelos solo exportan la clase con
`export class` (named export) — nunca se había ejercitado porque la Parte 1 no toca la BD.
`pnpm test` (43 tests, 6 suites) y `pnpm build` en verde.

**Verifica:** `pnpm test auth` en verde.

---

### Parte 3 — Checkout (integración HTTP, Stripe mockeado) — ✅ Hecho

- [x] **Descuento atómico de stock:** dos `POST /api/orders` **concurrentes** (`Promise.all`) por el
  último par talla/producto (stock 1) → **una `201` y una `409`** (el `literal('stock - N')` +
  `Op.gte` de `orders.service.ts:126`); el stock final queda en 0.
- [x] **Totales autoritativos:** un total/precio que mande el cliente en el body se **ignora**; la
  respuesta recalcula server-side desde el `cart` service.
- [x] **Refine `quotationId`/`rateId`:** ambos-o-ninguno — uno sin el otro → `400`
  (`createOrderSchema.refine()`, `schemas/checkout.ts:104`).

**Ref:** `src/services/orders.service.ts` (`createOrder`), `src/controllers/order.controller.ts`.
Mockear `createPaymentIntentForOrder` (`payment.service.ts:49`) para no llamar a Stripe.

**Verificado:** `tests/integration/checkout.test.ts` (4 tests) — dos `POST /api/orders`
concurrentes contra un producto con stock 1 en talla 25 dan exactamente una `201` y una `409`
(mensaje "se agotó"), y el stock final en BD queda en `0`; un pedido con precios/totales
falsificados en el body (`unitSalePrice`, `price`, `total`, `subtotal`, `savings` a nivel raíz —
todos campos que el schema no reconoce y por tanto descarta) devuelve el `subtotal`/`savings`/
`shipping`/`total` recalculados desde los precios reales del producto en BD; `quotationId` sin
`rateId` (y viceversa) devuelven `400`. `payment.service.ts` se mockea **completo** (no solo
`createPaymentIntentForOrder`) para que sus otros imports (Resend/Skydropx/Sentry) no se carguen
en esta suite. Prueba negativa manual: quitar el `Op.gte` del `WHERE` del `UPDATE` atómico
(`orders.service.ts`) hizo que las dos peticiones concurrentes devolvieran `201` — el test de
stock atómico lo detectó y se puso en rojo (revertido después).

**Hallazgo de infraestructura:** al sumar una segunda suite de integración, `pnpm test` sin
`--runInBand` empezó a fallar de forma intermitente (`sync({ force: true })`/`TRUNCATE` de dos
workers de Jest pisándose contra el mismo Postgres de test — errores tipo "el tipo ENUM ya
existe"/"relation does not exist"). La Parte 2 nunca lo mostró por ser la única suite de
integración hasta ahora. Se corrigió agregando `maxWorkers: 1` a `jest.config.ts`: serializa
todas las suites (las unitarias son rápidas, el costo es mínimo) y elimina la carrera — necesario
también de cara a las Partes 4 y 5, que suman más suites de integración. `pnpm test` (47 tests, 7
suites) y `pnpm build` en verde.

**Verifica:** `pnpm test checkout` en verde. Prueba negativa: quitar el `Op.gte` del `UPDATE` →
el test de concurrencia debe ponerse en rojo (dos `201`).

---

### Parte 4 — Idempotencia de webhooks (servicio directo + SDK mockeado) — ✅ Hecho

- [x] `markOrderPaidFromWebhook`: **dos llamadas concurrentes** → un solo `affected === 1` y **un
  solo correo** (`sendEmail` mockeado). Prueba negativa: comentar el `WHERE`/`Op.ne: "paid"`
  (`payment.service.ts:90`) → el test detecta el doble envío.
- [x] `createShipmentForOrder`: el **guard centinela `"creating"`** (`payment.service.ts:179`) — dos
  concurrentes → **una sola** llama a Skydropx (`createShipment`/`fetch` mockeado, no gastar saldo);
  si la creación falla, el centinela se libera a `null`.
- [x] `applyShipmentUpdateFromWebhook` (`payment.service.ts:498`): un evento **fuera de orden** no
  retrocede `Order.status` (`advanceOrderStatus` avanza solo hacia adelante); una orden `cancelled`
  no se reactiva.

**Ref:** `src/services/payment.service.ts`. Mockear `config/stripe`, `skydropx.service` (o `fetch`)
y `email.service`. Requiere BD de test (los guards son `UPDATE` condicionales reales).

**Verificado:** `tests/integration/webhooks.test.ts` (7 tests) — llama directo a las funciones de
`payment.service.ts` (no vía HTTP) con `Promise.all` contra la BD de test real. Se mockean
`email.service` (`sendEmail`) y `skydropx.service` (`getQuotationRate`/`createShipment`/
`getShippingRates`, el resto vía `jest.requireActual` como documenta `tests/setup/mocks/skydropx.ts`)
— ninguno de los dos debe costar saldo real ni mandar un correo real. `alert.service.ts` reusa
`sendEmail` internamente, así que mockear `email.service` también cubre sus alertas sin un mock
aparte. Los efectos fire-and-forget (correo, guía) no se pueden `await` desde el test porque el
propio código no los espera (a propósito, para no bloquear el 200 del webhook) — se usa un
`waitFor(predicate)` local que hace polling con timers reales (nunca fake timers: la recarga de la
orden y los guards hacen I/O real contra Postgres) antes de aserta sobre `sendEmailMock`.
`markOrderPaidFromWebhook`: dos llamadas concurrentes con el mismo `paymentIntentId` dejan la orden
`paid` y disparan el correo de confirmación exactamente una vez; una orden `cancelled` que recibe un
evento tardío se queda `cancelled` (no se reactiva) y no manda correo. `createShipmentForOrder`: dos
llamadas concurrentes sobre la misma orden (con `skydropxQuotationId`/`skydropxRateId`) solo generan
**una** guía (`createShipment` mockeado llamado una vez, `skydropxShipmentId` queda con el id
devuelto); si `createShipment` rechaza, el centinela `"creating"` se libera a `null` (permite
reintento). `applyShipmentUpdateFromWebhook`: un evento `in_transit` sobre una orden ya `delivered`
no la retrocede a `shipped`; el mismo evento sobre una orden `cancelled` no la reactiva; dos eventos
concurrentes que traen el mismo `trackingNumber` por primera vez avanzan la orden a `shipped` y
disparan el correo "pedido enviado" una sola vez (guard `WHERE trackingNumber IS NULL`). Pruebas
negativas manuales: quitar el `WHERE status: "pending" / Op.ne: "paid"` de `markOrderPaidFromWebhook`
puso en rojo tanto el test de concurrencia (correo duplicado) como el de la orden cancelada (se
resucitó a `paid`); quitar el `WHERE skydropxShipmentId: null` del claim de `createShipmentForOrder`
puso en rojo el test del guard centinela (`createShipment` llamado dos veces) — ambas reversiones
confirmadas, `git diff` limpio sobre `payment.service.ts`. `pnpm test` (54 tests, 8 suites) y `pnpm
build` en verde.

**Verifica:** `pnpm test webhooks` en verde + las pruebas negativas en rojo al romper cada guard.

---

### Parte 5 — Cancelación/reembolso manual + release de stock (opcional / stretch) — ✅ Hecho

- [x] `releaseOrderStock` (`orders.service.ts:248`): idempotente — solo actúa mientras
  `status === "pending"`, **nunca** restockea una orden `paid` (el webhook `canceled` y el sweeper no
  pueden doble-restockear).
- [x] `cancelOrderByAdmin` (`orders.service.ts:299`): `pending` → restock; `paid` → **refund**
  (Stripe mockeado) **antes** de restockear + `paymentStatus: "refunded"`; `shipped` / `delivered` /
  `cancelled` → `409`.

**Ref:** `src/services/orders.service.ts`. Mockear `stripe.refunds.create` / `paymentIntents.cancel`.

**Verificado:** `tests/integration/cancelOrder.test.ts` (11 tests) — nivel 3 como la Parte 4: llama
directo a `orders.service.ts` (no vía HTTP) contra la BD de test real, con `config/stripe` mockeado
completo (`buildStripeMock`, el mismo builder ya usado en la Parte 3) para que ningún test toque
Stripe de verdad; `sendAlertEmail` no necesitó mock propio — sin `ALERT_EMAIL_TO` en `.env.test` ya
es un no-op que solo loguea, igual que en la Parte 4. `releaseOrderStock`: repone el stock y deja la
orden `cancelled`/`failed` cuando estaba `pending`; una segunda llamada no repone doble (ya no está
`pending`); una orden `paid` no se toca. `cancelOrderByAdmin` — `pending`: repone stock, cancela, y
llama `paymentIntents.cancel` best-effort (un rechazo del mock no bloquea la cancelación). `paid`:
llama `refunds.create` con `{ payment_intent }` + `idempotencyKey: refund-order-${id}` **antes** de
restockear, y persiste `refundId`/`refundedAt`/`paymentStatus: "refunded"`; un `refunds.create`
rechazado lanza `AppError` `502` **sin** restockear ni cambiar `status`/`paymentStatus` (siguen
`paid`); dos `cancelOrderByAdmin` concurrentes sobre la misma orden `paid` (mock de
`refunds.create` devolviendo el mismo `id` a ambas llamadas, simulando cómo respondería Stripe real
ante la misma `idempotencyKey`) solo restockean **una vez** — lo protege el `FOR UPDATE` +
recheck `status === "paid"` dentro de la transacción, no el mock en sí. `shipped` / `delivered` /
`cancelled` (parametrizado con `it.each`) devuelven `409` y no tocan stock ni Stripe. Prueba
negativa manual: reemplazar el recheck `if (!locked || locked.status !== "paid") return;` por
`if (!locked) return;` (quitando el chequeo de `status`) hizo que el test de concurrencia
restockeara 4 unidades en vez de 2 — se puso en rojo, confirmando que el guard es real; revertido
después (`git diff` limpio sobre `orders.service.ts`). `pnpm test` (65 tests, 9 suites) y `pnpm
build` en verde.

**Verifica:** `pnpm test cancelOrder` en verde. Prueba negativa: quitar el recheck de `status` en el
`FOR UPDATE` del branch `paid` de `cancelOrderByAdmin` → el test de concurrencia debe ponerse en rojo
(stock restockeado más de una vez).

---

### Parte 6 — Envío en vivo (integración HTTP, Skydropx mockeado) — ✅ Hecho

- [x] `POST /api/shipping/rates`: cuando `getShippingRates` (Skydropx) rechaza o tarda, la respuesta
  sigue siendo `200` con la tarifa plana de `cart.ts`'s `computeShipping` como fallback — la tienda
  nunca debe dejar de cotizar porque la paquetería esté caída.
- [x] Un producto en el carrito con `weightKg`/`lengthCm`/`widthCm`/`heightCm` en `0` (fila legado
  previa a la validación `.positive()`) salta **directo** al fallback de tarifa plana sin llamar a
  Skydropx (`buildParcel` armaría una caja subdimensionada pero "válida" si no se saltara).
- [x] `shippingRateLimiter` (20 req/min, `src/middlewares/rateLimit.ts`) — mismo patrón que
  `authRateLimiter` en la Parte 2: mockear `express-rate-limit` para que la suite no choque con el
  límite real al hacer varias requests.

**Ref:** `src/controllers/shipping.controller.ts`, `src/services/cart.ts` (`computeShipping`),
`src/services/packing.ts` (`buildParcel`). Mockear `skydropx.service` completo (`getShippingRates`)
— no llamar a Skydropx real ni siquiera al sandbox.

**Verificado:** `tests/integration/shippingRates.test.ts` (7 tests) — nivel 2 como la Parte 3:
`request(app).post("/api/shipping/rates")` contra la BD de test real, con `skydropx.service`
mockeado vía `jest.mock(..., () => ({ ...jest.requireActual(...), getShippingRates: jest.fn() }))`
(mismo patrón documentado en `tests/setup/mocks/skydropx.ts`) — así `getOriginAddress`/
`toSkydropxAddress` (funciones puras, sin red) siguen siendo las reales y solo la llamada de red se
sustituye. `express-rate-limit` se mockea igual que en la Parte 2 (Auth). Casos cubiertos: un
`getShippingRates` que rechaza con un `Error` genérico (red caída) y uno que rechaza con
`SkydropxRequestError(status: 503)` (falla transitoria del lado de Skydropx) devuelven ambos `200`
con `quotationId: null` y un único rate `rateId: null` / `carrier: "Estándar"`; una respuesta
resuelta con `rates: []` (ninguna tarifa utilizable a tiempo) cae al mismo fallback; una respuesta
con tarifas utilizables se devuelve tal cual (`quotationId` real, los rates normalizados intactos,
sin pasar por el fallback) y `getShippingRates` se llama exactamente una vez. Un producto con
`weightKg: 0` y, por separado, uno con `lengthCm`/`widthCm`/`heightCm` en `0` saltan al fallback
**sin invocar** `getShippingRates` en absoluto (`toHaveBeenCalledTimes(0)`), confirmando que el
chequeo de dimensiones corta antes de intentar cotizar en vivo. Un producto `visible: false` en el
carrito devuelve `409` (`assertProductAvailable`) sin llegar a llamar a Skydropx. Los casos de `4xx`
(`isClientError`, que además reporta a Sentry) no se probaron por separado — el fallback es
idéntico al de un `5xx`/red y ya está cubierto por el caso `SkydropxRequestError`; lo que distingue
esa rama es solo el nivel de log/Sentry, fuera del alcance de esta parte (comportamiento HTTP
observable). `pnpm test` (72 tests, 10 suites) y `pnpm build` en verde.

**Verifica:** `pnpm test shippingRates` en verde.

---

### Parte 7 — Cliente HTTP de Skydropx (unit, `fetch` mockeado) — ✅ Hecho

- [x] OAuth `client_credentials`: el `access_token` se cachea en memoria y se renueva ~5 min antes de
  expirar (`expires_in: 7200`).
- [x] Throttle compartido de 2 req/s a nivel de módulo (todas las llamadas salientes, incluida la de
  token).
- [x] Poll de cotización (`pollQuotation`): corte temprano al juntar `MIN_READY_RATES` (3) tarifas
  utilizables; timeout de `POLL_TIMEOUT_MS` (8s) si ninguna tarifa llega a completarse; un
  `rates: []` en la primera lectura (cotización recién creada) se trata como "sigue pendiente", **no**
  como resuelto (`.some()` sobre array vacío da `false` — el caso que motivó el chequeo explícito).
- [x] `isUsableRate` / normalización: `amount`/`total` llegan como **strings** y requieren
  `parseFloat`; el resultado queda ordenado ascendente y recortado a `MAX_RATES_RETURNED` (5).
- [x] `requiresDropoff` combinado: `pickup === false` **o** el regex `/sin\s+recolecci[oó]n/i` sobre
  `provider_service_name` (la señal estructurada sola no basta — sandbox tuvo casos con `pickup:
  true` en un servicio literalmente llamado "Sin recolección").
- [x] `SkydropxRequestError` conserva el `status` HTTP, para distinguir un `4xx` (bug de integración
  nuestro) de un `5xx`/falla de red (transitorio).

**Ref:** `src/services/skydropx.service.ts`. Usar `buildFetchMock` (ya scaffolded en
`tests/setup/mocks/skydropx.ts`) para encolar las respuestas JSON de OAuth/cotización en el orden
que el cliente las pide — sin BD, sin HTTP real.

**Verificado:** `tests/unit/services/skydropx.test.ts` (10 tests) — nivel 1 puro: sin BD, mockeando
solo `global.fetch` (vía `buildFetchMock`) y usando **fake timers** de Jest (`jest.useFakeTimers()` +
`jest.advanceTimersByTimeAsync`) para no esperar en tiempo real el throttle (500ms) ni el poll (hasta
8s) — un helper local `resolveWithFakeTimers` avanza el reloj en pasos de 200ms hasta que la promesa
se resuelve o rechaza. Como el token cacheado y la cola de throttle son estado **a nivel de módulo**,
cada test hace `jest.resetModules()` + `require(...)` fresco en `beforeEach` para no arrastrar estado
del test anterior. Casos cubiertos: una segunda llamada no repite el fetch de OAuth (token cacheado);
justo antes del margen de 5 min de `TOKEN_REFRESH_MARGIN_MS` sigue usando el token cacheado, y justo
después pide uno nuevo; dentro de una sola llamada de negocio (oauth + request) y entre dos llamadas
consecutivas, el gap entre fetches consecutivos es siempre `>=500ms` (throttle). `getShippingRates`:
corta el poll en cuanto junta 3 tarifas utilizables sin esperar `is_completed` (un solo GET de poll);
un primer `rates: []` no se trata como resuelto y el poll continúa a un segundo GET; con una tarifa
que nunca junta el mínimo, el poll reintenta varias veces y al agotar el presupuesto de 8s devuelve la
única tarifa utilizable que sí resolvió, en vez de colgarse. Normalización: 6 tarifas con
`amount`/`total` en string se parsean a `number`, quedan ordenadas ascendente por `total` y recortadas
a las 5 más baratas (se descarta la más cara). `requiresDropoff`: `true` con `pickup: false`, `true`
con `pickup: true` cuando el nombre del servicio matchea "sin recolección" (con y sin acento), `false`
en un servicio normal. `SkydropxRequestError` conserva `status: 422` y `status: 503` en sendos casos.
Prueba negativa manual: quitar el chequeo explícito `last.rates.length === 0 ||` de `stillPending`
(`skydropx.service.ts`) puso en rojo el test del `rates: []` inicial (el poll cortaba después de un
solo GET en vez de dos) — confirmado y revertido, `git diff` limpio sobre `skydropx.service.ts`.
`pnpm test` (82 tests, 11 suites) y `pnpm build` en verde.

**Verifica:** `pnpm test skydropx` en verde. Prueba negativa: quitar el chequeo `rates.length === 0`
de `stillPending` en `pollQuotation` → el test del array vacío inicial debe ponerse en rojo.

---

### Parte 8 — CRUD admin de productos + imágenes (integración HTTP, Cloudinary mockeado) — ✅ Hecho

- [x] `adminCreateProduct`/`adminUpdateProduct`: `sizes` acepta tanto un string `"25,25,26"` como un
  array de números; las filas de `ProductSize` se escriben dentro de una `sequelize.transaction`.
- [x] `DELETE /api/admin/products/:id`: **soft-delete** (`deletedAt` + `visible:false`) cuando el
  producto está referenciado por un `OrderItem`; **hard-delete** (con cascade de `ProductSize`) en
  cualquier otro caso.
- [x] `POST /:id/images`: cap de 3 imágenes totales, re-verificado bajo row lock (`FOR UPDATE`) para
  que dos adds concurrentes no pasen ambos una cuenta ya obsoleta; subida **todo-o-nada**
  (`uploadAllOrCleanup` — si una falla, las que sí subieron se destruyen; si la transacción de BD
  falla después, también se limpian los assets recién subidos).
- [x] `DELETE /:id/images`: persiste el cambio en BD **antes** de destruir el asset en Cloudinary
  (best-effort) — nunca al revés, para no dejar una referencia colgante que rompa la imagen en la
  tienda.
- [x] Lecturas públicas (`toPublicProduct`): cada imagen pierde el `publicId` (id interno de
  Cloudinary) antes de salir en la respuesta.

**Ref:** `src/controllers/product.controller.ts`, `src/services/image.service.ts`,
`src/middlewares/upload.ts`. Mockear `cloudinary` (`uploader.upload_stream`/`destroy`) — nunca subir
un asset real.

**Verificado:** `tests/integration/adminProducts.test.ts` (14 tests) — nivel 2 (HTTP real vía
Supertest + Postgres de test), con `src/config/cloudinary` mockeado completo (`buildCloudinaryMock`/
`resetCloudinaryMock`/`failNextUpload`, nuevo en `tests/setup/mocks/cloudinary.ts`, mismo patrón que
`tests/setup/mocks/stripe.ts`): `uploader.upload_stream` devuelve un stream falso cuyo `.end()`
invoca el callback síncronamente con un `public_id`/`secure_url` incrementales, y `uploader.destroy`
resuelve `{ result: "ok" }` por defecto. Un JWT de prueba se firma con el nuevo helper
`signToken(user)` (`tests/setup/factories.ts`, mismo payload que `auth.controller.ts`) en vez de
pasar por `POST /api/auth/login`, reutilizable para la Parte 9. Casos cubiertos: `sizes` como string
`"25,25,26"` y como array `[27,27,27]` agrupan repeticiones en filas `ProductSize` correctas;
`adminUpdateProduct` con `sizes` reemplaza por completo las filas anteriores (no las mezcla). `DELETE
/:id`: soft-delete cuando hay un `OrderItem` (conserva `images`, `destroy` no se llama) vs.
hard-delete sin referencias (fila y `ProductSize` desaparecen, `destroy` se llama una vez por
imagen). `POST /:id/images`: sube y agrega una imagen; rechaza con `400` sin llamar a Cloudinary
cuando el total excedería el tope (chequeo temprano); **dos adds concurrentes** que juntos exceden el
tope (producto con 2 imágenes, cada request sube 1 más) dan exactamente un `201` (3 imágenes finales)
y un `400`, con `destroy` llamado una vez para limpiar el asset del que perdió la carrera — el mismo
patrón de concurrencia que la Parte 3, pero sobre el row lock de imágenes en vez del stock atómico;
subida **todo-o-nada** con `failNextUpload` simulando que la 2ª de 2 imágenes falla → `502`, la que sí
subió se destruye y la BD no cambia. `DELETE /:id/images`: persiste el borrado y solo después llama
`destroy` con el `publicId` correcto; un `publicId` que ya no está en la galería → `404` sin llamar a
`destroy`; un `destroy` que rechaza (Cloudinary caído) no revierte el cambio ya persistido (sigue
siendo best-effort). Lecturas públicas (`GET /api/products` y `GET /api/products/:id`): cada imagen
sale como `{ url }`, nunca con `publicId`. Prueba negativa manual: forzar `false &&` en el recheck
bajo `FOR UPDATE` de `adminAddProductImages` (`current.length + uploaded.length > MAX_IMAGES_PER_PRODUCT`)
puso en rojo el test de concurrencia (`[201, 201]` en vez de `[201, 400]`) — confirmado y revertido,
`git diff` limpio sobre `product.controller.ts`. `pnpm test` (96 tests, 12 suites) y `pnpm build` en
verde.

**Verifica:** `pnpm test adminProducts` en verde. Prueba negativa: neutralizar el recheck de tope bajo
`FOR UPDATE` en `adminAddProductImages` → el test de concurrencia debe ponerse en rojo (dos `201`).

---

### Parte 9 — Marca y usuarios admin (integración HTTP, Cloudinary mockeado) — ✅ Hecho

- [x] `GET /api/admin/brand` es **público** (sin JWT); `PUT /api/admin/brand` exige `requireAuth`.
- [x] `POST`/`DELETE /api/admin/brand/logo`: el nuevo asset se persiste **antes** de destruir el
  anterior (best-effort) — un `destroy` fallido nunca pierde el logo vigente.
- [x] `POST /api/admin/users`: email duplicado → `409` pre-chequeado (no depende solo del handler
  genérico de `UniqueConstraintError`); `tempPassword` exige la misma complejidad que `loginSchema`.
- [x] `DELETE /api/admin/users/:id`: `400` si el caller se borra a sí mismo; `400` si el target es el
  **último** `owner` restante — chequeado bajo `FOR UPDATE` sobre las filas `owner` (dos deletes
  concurrentes a dos owners distintos no deben dejar el panel en cero).
- [x] `PUT /api/admin/account`: `currentPassword` siempre requerida y verificada (incluso en un
  cambio solo de email); un email duplicado → `409` pre-chequeado.

**Ref:** `src/controllers/brand.controller.ts`, `src/controllers/adminUser.controller.ts`. Mockear
`cloudinary` para el logo — mismo patrón que la Parte 8.

**Verificado:** `tests/integration/adminBrandUsers.test.ts` (15 tests) — nivel 2 (HTTP real vía
Supertest + Postgres de test), con `src/config/cloudinary` mockeado igual que la Parte 8
(`buildCloudinaryMock`/`resetCloudinaryMock`, sin necesitar `failNextUpload` aquí). `GET
/api/admin/brand`: responde sin JWT y crea la fila `id: 1` con los defaults si no existía; `PUT` sin
JWT → `401`, con JWT actualiza el campo enviado. `POST /api/admin/brand/logo`: una segunda subida
persiste el `logoUrl`/`logoPublicId` nuevos y llama `destroy` con el `publicId` **anterior**; un
`destroy` que rechaza (Cloudinary caído) no revierte el logo nuevo ya persistido (best-effort real,
no solo documentado). `DELETE /api/admin/brand/logo` deja `logoUrl`/`logoPublicId` en `null` y
llama `destroy` con el `publicId` que tenía. `POST /api/admin/users`: email duplicado → `409`; una
`tempPassword` sin la complejidad de `loginSchema` → `400`; una creación válida no expone
`passwordHash` en la respuesta y el usuario puede loguearse de inmediato con esa misma
`tempPassword` (prueba end-to-end de que ambos schemas comparten la regla, no solo por lectura del
código). `DELETE /api/admin/users/:id`: `400` al intentar borrarse a sí mismo; `400` al intentar
borrar al único `owner` restante (no se borra la fila); un `admin` normal se borra sin problema;
**dos deletes concurrentes a dos owners distintos** (`Promise.all`) dejan exactamente un `200` y un
`400`, con `1` owner restante — nunca `[200, 200]` (que dejaría el panel en cero). `PUT
/api/admin/account`: un `currentPassword` incorrecto → `401` incluso en un cambio solo de email; el
correcto actualiza el email; un email ya usado por otro admin → `409`. Prueba negativa manual:
quitar `lock: t.LOCK.UPDATE` del `findAll` de owners en `deleteAdminUser`
(`adminUser.controller.ts`) puso el test de concurrencia en rojo (`[200, 200]` en vez de
`[200, 400]`, 0 owners restantes) — confirmado y revertido, `git diff` limpio sobre
`adminUser.controller.ts`. `pnpm test` (111 tests, 13 suites) y `pnpm build` en verde.

**Verifica:** `pnpm test adminBrandUsers` en verde. Prueba negativa: quitar el `lock: t.LOCK.UPDATE`
del `findAll` de owners en `deleteAdminUser` → el test de concurrencia debe ponerse en rojo
(`[200, 200]`, 0 owners restantes).

---

### Parte 10 — Agregaciones de dashboard y reports (unit, funciones puras) — ✅ Hecho

> A diferencia de las partes anteriores, aquí no se persiguen cifras exactas contra un dataset fijo
> (la agregación cambia seguido y un snapshot de números se vuelve frágil/costoso de mantener) — se
> prueban **invariantes estructurales y casos borde** con fixtures pequeños y deliberados de
> `Order`/`OrderItem`/`Product`.

- [x] `dashboard.service.ts`: solo las órdenes `status: "paid"` cuentan como venta (no
  `paymentStatus`, que el seed deja en `"unpaid"`); cada ventana (`"7"|"30"|"90"`) compara contra su
  propia ventana previa de igual longitud; `GASTOS_FIJOS` se prorratea por `windowDays/30`.
- [x] `revenueByPeriod`: incluye días en `$0` (nunca se saltan); el day-bucketing (`isoDay`) queda
  pinneado a UTC — un caso cerca de medianoche en un host al oeste de UTC no debe recorrer un día
  (el bug real que motivó el pin, igual que en la Parte 1).
- [x] `reports.service.ts`'s `monthRange`: sin huecos entre el mes de la primera orden pagada y el
  mes UTC actual; clamp al mes actual cuando `from` queda después de `to`.
- [x] `byProduct` de cada mes: incluye todo producto vivo (`unitsSold: 0` si no vendió ese mes) más
  un producto descontinuado **solo** en los meses donde realmente vendió.
- [x] `replenishment`: la serie que alimenta `computeForecast` usa solo meses completos, excepto el
  caso de **cero** meses completos (primer mes de la tienda), donde usa el mes parcial como único
  dato; `effectiveForecast` actúa como piso cuando `forecastNextMonth` redondea a `0`; los meses en
  `$0` **antes** de la primera venta del producto se recortan de la serie (los de después se
  conservan).
- [x] `loadReportData`: cachea la promesa por `REPORT_CACHE_TTL_MS` (60s); un fetch que rechaza limpia
  el cache de inmediato en vez de repetir el error hasta que expire el TTL.

**Ref:** `src/services/dashboard.service.ts`, `src/services/reports.service.ts`. Sin BD real ni HTTP
— se llaman las funciones directo con arrays de `Order`/`Product` construidos a mano (o con las
factories de `tests/setup/factories.ts` sin persistirlas).

**Verificado:** `tests/unit/services/dashboard.test.ts` (6 tests) + `tests/unit/services/reports.test.ts`
(10 tests) — nivel 1 puro: sin BD (`Order.build`/`Product.build`/`OrderItem.build`/`ProductSize.build`
en vez de `.create()`, nunca tocan Postgres) y sin HTTP, mockeando solo `Order.findAll`/`Product.findAll`
(`jest.spyOn`) para interceptar las dos únicas queries que hace cada servicio. `getDashboardData` llama
`Order.findAll` dos veces dentro del mismo `Promise.all` (historial + recientes); como `Promise.all`
evalúa el array en orden, `mockResolvedValueOnce` encolado dos veces basta para diferenciarlas sin
inspeccionar los argumentos de la llamada — excepto en el primer test, que si inspecciona
`mock.calls[n][0].where.status` para confirmar el invariante "solo cuentan las `paid`" (mockear la
query completa no puede probar el filtrado real de Postgres, así que se prueba que la query SE
CONSTRUYE con ese filtro, no que Postgres lo aplique — eso ya lo cubren las suites de integración).
`jest.useFakeTimers().setSystemTime(...)` fija `new Date()` para que el cálculo de ventanas/meses sea
determinista. El invariante de ventanas independientes se probó con una sola orden 10 días atrás: cae
en la ventana PREVIA de `"7"` (trend `-100%`) pero en la ventana ACTUAL de `"30"` (sin trend, ventana
previa vacía) — la misma orden clasificada distinto según el ancho de ventana es lo que demuestra que
cada una usa su propio corte, no uno compartido. Para reports, `loadReportData`'s cache es estado a
**nivel de módulo** (`cachedReportData`/`cacheExpiresAt`), así que cada `it` hace
`jest.resetModules()` + `require(...)` fresco de los modelos y del servicio en `beforeEach` (mismo
patrón que la Parte 7 usa para el token/throttle cacheados de Skydropx) — si no, el cache de un test
contaminaría el siguiente. El caso de "cero meses completos" y el de "recorte de ceros iniciales"
distinguen sus ramas por el **método de pronóstico** devuelto (`promedio-simple` vs
`suavizacion-exponencial`) en vez de solo el valor numérico, porque un cambio de rama es una señal más
dura de que la serie de entrada tenía el tamaño esperado; el caso de recorte necesita una orden de OTRO
producto en un mes más antiguo para fijar el inicio del rango de meses (`monthRange` arranca en la
orden pagada más antigua de TODA la tienda, no por producto) — sin eso, el propio producto bajo prueba
ya no arrastraría ceros iniciales que recortar. Pruebas negativas manuales: quitar
`.slice(firstSale)` en `reports.service.ts` (usar la serie sin recortar) puso en rojo el test de
recorte (`forecastMethod` pasó de `promedio-simple` a `suavizacion-exponencial`, la serie de 4 puntos
sin recortar activa la rama de suavización); forzar `previousWindowStart` a un offset fijo de 30 días
(ignorando `windowDays`) en `dashboard.service.ts` puso en rojo el test de ventanas independientes
(el trend de `"7"` esperado en `-100%` desapareció) — ambas confirmadas y revertidas,
`git diff` limpio sobre `src/`. `pnpm test` (127 tests, 15 suites) y `pnpm build` en verde.

**Verifica:** `pnpm test dashboard reports` en verde. Pruebas negativas: quitar `.slice(firstSale)` en
`getReplenishmentReport` (`reports.service.ts`) → el test de recorte de ceros iniciales debe ponerse en
rojo (cambia de método de pronóstico); fijar `previousWindowStart` a un offset constante de 30 días en
`buildKpisForWindow` (`dashboard.service.ts`) → el test de ventanas independientes debe ponerse en rojo.

---

## Fuera de alcance (documentado a propósito)

No se cubre en este roadmap por bajo ROI — es configuración declarativa sin lógica propia que
probar:

- **Swagger** (`swagger-jsdoc`/`swagger-ui-express`, `src/config/swagger.ts` + los bloques
  `@openapi`): genera un spec OpenAPI a partir de anotaciones; no hay comportamiento en tiempo de
  ejecución que valga la pena ejercitar con un test.

## Siguiente paso tras cerrar H.1

Con `pnpm test` corriendo una suite real, la **Fase H.6** (CI en GitHub Actions) solo tendrá que
levantar un Postgres de servicio y llamar `pnpm install && pnpm build && pnpm test` en cada PR, más
branch protection en `main`.

## Checklist maestro

- [x] **Parte 0** — Infra (jest/ts-jest/supertest, setup, gate en app.ts, smoke verde)
- [x] **Parte 0.5** — BD de test dedicada (crear el Postgres de pruebas; prerequisito de las Partes 2-4)
- [x] **Parte 1** — Servicios puros (`cart`, `forecast`, `formatMoney`, `date`)
- [x] **Parte 2** — Auth (login anti-enumeración, reset code)
- [x] **Parte 3** — Checkout (stock atómico, totales, refine shipping)
- [x] **Parte 4** — Idempotencia de webhooks (pago, guía, estado de envío)
- [x] **Parte 5** — Cancelación/reembolso manual + release de stock (opcional)
- [x] **Parte 6** — Envío en vivo (`POST /api/shipping/rates`, fallback a tarifa plana)
- [x] **Parte 7** — Cliente HTTP de Skydropx (OAuth, throttle, poll de cotización)
- [x] **Parte 8** — CRUD admin de productos + imágenes (Cloudinary mockeado)
- [x] **Parte 9** — Marca y usuarios admin (brand, logo, adminUser, account)
- [x] **Parte 10** — Agregaciones de dashboard y reports (invariantes, no cifras exactas)
