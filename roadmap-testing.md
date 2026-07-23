# ROADMAP — Testing automatizado del backend (Fase H.1)

Expansión ejecutable de la **Fase H.1** de [roadmap-hardening.md](roadmap-hardening.md), desglosada
en **partes independientes** (una función/feature por entrega) para irla cubriendo de a poco. No se
persigue 100% de cobertura: se cubre **lo que más cuesta romper en silencio** — descuento atómico de
stock, idempotencia de webhooks, recálculo de totales y auth — y se deja fuera, a propósito, lo que
cambia seguido o tiene bajo ROI de prueba.

> **Cómo usarlo:** marca `[x]` cada tarea al completarla. Las partes tienen un orden recomendado
> (0 → 5), pero salvo la Parte 0 (infra, prerequisito de todo) no están encadenadas: puedes hacer la
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
│     └─ webhooks.test.ts
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
| **5** | Cancelación/reembolso manual + release de stock (opcional) | Servicio + mock | 🔴 Pendiente |

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

### Parte 5 — Cancelación/reembolso manual + release de stock (opcional / stretch) — 🔴 Pendiente

- [ ] `releaseOrderStock` (`orders.service.ts:248`): idempotente — solo actúa mientras
  `status === "pending"`, **nunca** restockea una orden `paid` (el webhook `canceled` y el sweeper no
  pueden doble-restockear).
- [ ] `cancelOrderByAdmin` (`orders.service.ts:299`): `pending` → restock; `paid` → **refund**
  (Stripe mockeado) **antes** de restockear + `paymentStatus: "refunded"`; `shipped` / `delivered` /
  `cancelled` → `409`.

**Ref:** `src/services/orders.service.ts`. Mockear `stripe.refunds.create` / `paymentIntents.cancel`.

**Verifica:** `pnpm test` (o el patrón de la suite) en verde.

---

## Fuera de alcance (documentado a propósito)

No se cubren en este roadmap por bajo ROI / alta volatilidad; se pueden agregar después si el tráfico
lo justifica:

- **Dashboard / Reports** (`dashboard.service.ts`, `reports.service.ts`): agregación en memoria que
  cambia seguido; probar cifras exactas es frágil.
- **Swagger**, **CRUD admin trivial** (brand, users), **Cloudinary/multer** (subida de imágenes).
- **El cliente HTTP de Skydropx en sí** (OAuth, throttle, poll): se puede añadir una suite dedicada
  con `fetch` mockeado (`buildFetchMock`) si aparece un bug ahí, pero no es prioridad H.1.

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
- [ ] **Parte 5** — Cancelación/reembolso manual + release de stock (opcional)
