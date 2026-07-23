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
| **2** | Auth (login anti-enumeración, reset code) | Integración | 🔴 Pendiente |
| **3** | Checkout (stock atómico, totales, refine shipping) | Integración | 🔴 Pendiente |
| **4** | Idempotencia de webhooks (pago, guía, estado de envío) | Servicio + mock | 🔴 Pendiente |
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

### Parte 2 — Auth (integración HTTP) — 🔴 Pendiente

- [ ] `POST /api/auth/login`: password correcta → `{ token, user }`; **email desconocido y password
  incorrecta devuelven el MISMO `401` byte-idéntico** (anti-enumeración, `auth.controller.ts:40`).
- [ ] `assertValidResetCode` (vía `POST /api/auth/verify-reset-code` y `reset-password`): código
  válido pasa; agota `RESET_CODE_MAX_ATTEMPTS` (5) y bloquea (quema el código); mensaje **idéntico**
  en los casos missing-user / wrong-code / expired.

**Ref:** `src/controllers/auth.controller.ts`, `src/utils/resetCode.ts`. Usa la factory
`createAdminUser` (hash bcrypt real). Primera suite con BD → `beforeAll(setupTestDatabase)`,
`afterEach(truncateAll)`, `afterAll(closeTestDatabase)`.

**Verifica:** `pnpm test auth` en verde.

---

### Parte 3 — Checkout (integración HTTP, Stripe mockeado) — 🔴 Pendiente

- [ ] **Descuento atómico de stock:** dos `POST /api/orders` **concurrentes** (`Promise.all`) por el
  último par talla/producto (stock 1) → **una `201` y una `409`** (el `literal('stock - N')` +
  `Op.gte` de `orders.service.ts:126`); el stock final queda en 0.
- [ ] **Totales autoritativos:** un total/precio que mande el cliente en el body se **ignora**; la
  respuesta recalcula server-side desde el `cart` service.
- [ ] **Refine `quotationId`/`rateId`:** ambos-o-ninguno — uno sin el otro → `400`
  (`createOrderSchema.refine()`, `schemas/checkout.ts:104`).

**Ref:** `src/services/orders.service.ts` (`createOrder`), `src/controllers/order.controller.ts`.
Mockear `createPaymentIntentForOrder` (`payment.service.ts:49`) para no llamar a Stripe.

**Verifica:** `pnpm test checkout` en verde. Prueba negativa: quitar el `Op.gte` del `UPDATE` →
el test de concurrencia debe ponerse en rojo (dos `201`).

---

### Parte 4 — Idempotencia de webhooks (servicio directo + SDK mockeado) — 🔴 Pendiente

- [ ] `markOrderPaidFromWebhook`: **dos llamadas concurrentes** → un solo `affected === 1` y **un
  solo correo** (`sendEmail` mockeado). Prueba negativa: comentar el `WHERE`/`Op.ne: "paid"`
  (`payment.service.ts:90`) → el test detecta el doble envío.
- [ ] `createShipmentForOrder`: el **guard centinela `"creating"`** (`payment.service.ts:179`) — dos
  concurrentes → **una sola** llama a Skydropx (`createShipment`/`fetch` mockeado, no gastar saldo);
  si la creación falla, el centinela se libera a `null`.
- [ ] `applyShipmentUpdateFromWebhook` (`payment.service.ts:498`): un evento **fuera de orden** no
  retrocede `Order.status` (`advanceOrderStatus` avanza solo hacia adelante); una orden `cancelled`
  no se reactiva.

**Ref:** `src/services/payment.service.ts`. Mockear `config/stripe`, `skydropx.service` (o `fetch`)
y `email.service`. Requiere BD de test (los guards son `UPDATE` condicionales reales).

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
- [ ] **Parte 2** — Auth (login anti-enumeración, reset code)
- [ ] **Parte 3** — Checkout (stock atómico, totales, refine shipping)
- [ ] **Parte 4** — Idempotencia de webhooks (pago, guía, estado de envío)
- [ ] **Parte 5** — Cancelación/reembolso manual + release de stock (opcional)
