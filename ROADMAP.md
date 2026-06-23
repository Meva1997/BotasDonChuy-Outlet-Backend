# ROADMAP — Backend Botas Don Chuy Outlet

Hoja de ruta de implementación del backend. **Este es el documento de "¿qué hago ahora?"**: cuando no sepas por dónde seguir, abre este archivo, busca la primera casilla `[ ]` sin marcar en orden de fases, y eso es lo siguiente.

> **Cómo usarlo:** marca `[x]` cada tarea al completarla. Las fases están **ordenadas por dependencia**: no saltes a la Fase 3 sin terminar la 0 y la 1, porque te van a faltar cimientos. Así es como se organiza un equipo: backlog dividido en milestones, cada uno desbloquea al siguiente.

---

## Stack real (IMPORTANTE)

Este backend usa **Express 5 + Sequelize 6 + PostgreSQL + TypeScript**.

> ⚠️ El documento `frontend/BACKEND.md` describe el contrato de datos completo, **pero está escrito para Prisma**. **Ignora toda su columna/bloques de Prisma** (`schema.prisma`, `model X {}`). Lo único que se toma de ahí son: los **tipos de datos**, los **endpoints** y las **reglas de negocio**. La traducción a tablas/modelos se hace con **Sequelize** (ver Fase 1).

**Fuente de verdad de los tipos** (lo que el backend debe servir tal cual): el frontend.
- [frontend/db/mockProducts.ts](../frontend/db/mockProducts.ts) — `MockProduct`
- [frontend/components/admin/data/types.ts](../frontend/components/admin/data/types.ts) — `DashboardData`, `MonthlyReport`, `ReplenishmentRow`, etc.
- [frontend/lib/getProducts.ts](../frontend/lib/getProducts.ts) — `ProductsResult`, `ProductFilters`
- [frontend/schemas/checkout.ts](../frontend/schemas/checkout.ts) y [frontend/schemas/auth.ts](../frontend/schemas/auth.ts) — validaciones zod
- [frontend/lib/forecast.ts](../frontend/lib/forecast.ts) y [frontend/lib/cart.ts](../frontend/lib/cart.ts) — lógica de negocio pura
- [frontend/lib/brand.ts](../frontend/lib/brand.ts) — textos de marca semilla

**Principio rector:** el frontend hoy lee de mocks. El backend debe **reemplazar esos mocks sirviendo exactamente las mismas formas de datos**. Mientras los contratos (tipos) se respeten, ningún componente del frontend cambia.

---

## 1. Estado actual (de un vistazo)

| Pieza | Estado | Dónde |
|---|---|---|
| Express 5 + helmet + cors + body parsers | ✅ Hecho | [src/app.ts](src/app.ts) |
| Conexión Sequelize (postgres, pool 5) + `sync({ alter: true })` en dev | ✅ Hecho | [src/config/database.ts](src/config/database.ts) |
| Modelo `Product` | ✅ Hecho (con peros, ver ⚠️) | [src/models/Product.ts](src/models/Product.ts) |
| `GET /api/products` (filtros, paginación, `availableSizes`, oculta costo) | ✅ Hecho | [src/controllers/product.controller.ts](src/controllers/product.controller.ts) |
| `GET /api/products/:id` (filtra `visible`, 404) | ✅ Hecho | mismo archivo |
| `/health` | ✅ Hecho | [src/app.ts](src/app.ts) |
| jsonwebtoken, bcrypt, zod, express-rate-limit, cloudinary, multer, sequelize-cli | 🔨 Instalados, **sin cablear** | `package.json` |
| Carpetas `src/middlewares/`, `src/schemas/`, `src/services/` | 🔨 Vacías, listas | `src/` |
| Auth (login, JWT, `requireAuth`) | ❌ Falta | Fase 2 |
| Modelos `Order`, `OrderItem`, `AdminUser`, `BrandSettings` | ❌ Falta | Fase 1 |
| Seed de datos | ❌ Falta | Fase 1 |
| CRUD admin de productos | ❌ Falta | Fase 3 |
| Checkout (`POST /api/orders`) | ❌ Falta | Fase 4 |
| Dashboard, reportes, marca, usuarios | ❌ Falta | Fases 5–7 |
| Lógica `forecast` / `cart` portada al backend | ❌ Falta | Fase 0 |

### ⚠️ Deuda de contrato detectada (arreglar en Fase 0)

El modelo `Product` actual **no coincide** del todo con lo que el frontend espera. Hay que corregir:

1. **`unitCost` → `costoUnitario`.** El modelo expone el campo como `unitCost`, pero el frontend (`MockProduct`, tipos del admin) lo consume como **`costoUnitario`**. El JSON servido en rutas admin no haría match. Renombrar el campo (o exponerlo como `costoUnitario` en el `toJSON`).
2. **Precios enteros en MXN.** El frontend espera enteros (`salePrice: 1920`), el modelo los guarda como `DECIMAL(10,2)`. Los getters ya devuelven número, pero asegúrate de que sea **entero** (sin centavos) para igualar los mocks.
3. **`discountPercent` derivado.** Debe calcularse en el backend: `round((originalPrice - salePrice) / originalPrice * 100)`. No confiar en que lo mande el cliente.
4. **Decisión de stock por talla.** Hoy el front modela stock-por-talla con **repetición en el array** `sizes` (`[25, 25, 26]` = 2 piezas de la 25). Decidir antes de la Fase 1: mantener esa convención o introducir tabla `ProductSize { productId, size, stock }`. Afecta el descuento de stock en el checkout (Fase 4).

---

## 2. Mapa de fases

Construye en este orden. Cada fase desbloquea la siguiente.

### Fase 0 — Cimientos transversales

**Objetivo:** dejar listas las piezas que todas las demás fases van a usar, y saldar la deuda de contrato del `Product`.

**Por qué ahora:** sin middleware de errores, validación y la lógica de negocio portada, cada endpoint posterior tendría que reinventarlas. Y si no arreglas `costoUnitario`/precios primero, vas a propagar el bug por todo el admin.

**Tareas:**
- [ ] Arreglar deuda de contrato del `Product` (puntos 1–3 de arriba) en [src/models/Product.ts](src/models/Product.ts).
- [ ] Decidir el modelo de stock por talla (punto 4 de arriba) y documentar la decisión aquí.
- [ ] Middleware de manejo de errores centralizado en `src/middlewares/` (captura zod, Sequelize, y errores genéricos → JSON con `message` en español).
- [ ] Wrapper `asyncHandler` para no repetir try/catch en cada controller.
- [ ] Portar [frontend/lib/forecast.ts](../frontend/lib/forecast.ts) **tal cual** a `src/services/forecast.ts` (es función pura, no depende del front).
- [ ] Portar la lógica de [frontend/lib/cart.ts](../frontend/lib/cart.ts) (`computeTotals`, `computeShipping`, `SHIPPING_BY_TYPE`) a `src/services/cart.ts`.
- [ ] Crear esquemas zod en `src/schemas/` replicando [frontend/schemas/](../frontend/schemas/): `shippingSchema`, `loginSchema`, `productSchema` (extendido con `costoUnitario` + dimensiones + `code`).
- [ ] Esqueleto de `requireAuth` en `src/middlewares/` (placeholder; la lógica JWT real llega en Fase 2).

**Cómo verificar:** `GET /api/products/1` sigue respondiendo y los precios salen como enteros; el modelo expone `costoUnitario` (no `unitCost`) — confirmarlo solo en una ruta admin más adelante, en la pública sigue oculto.

---

### Fase 1 — Datos base (modelos restantes + seed)

**Objetivo:** tener todas las tablas y datos de arranque para poder construir y probar el resto.

**Por qué ahora:** no puedes construir login sin tabla `AdminUser`, ni dashboard sin órdenes/ventas. El seed te da datos reales contra los que probar cada endpoint.

**Tareas:**
- [ ] Modelo `AdminUser` (`id`, `name`, `email` unique, `passwordHash`, `role` enum `owner|admin|editor`, `createdAt`).
- [ ] Modelo `Order` (snapshot de totales + datos de envío; ver Fase/§4).
- [ ] Modelo `OrderItem` (un renglón por ítem, con precios **congelados**: `unitOriginalPrice`, `unitSalePrice`, `unitCosto`).
- [ ] Modelo `BrandSettings` (singleton: `brandName`, `heroText`, `tagline`, `cartNotice`, `footerNote`, `logoUrl`).
- [ ] (Si se decidió en Fase 0) Modelo `ProductSize`.
- [ ] Asociaciones Sequelize: `Order.hasMany(OrderItem)`, `OrderItem.belongsTo(Product)`.
- [ ] Registrar **todos** los modelos importándolos en [src/app.ts](src/app.ts) (si no se importan, `sync` no los crea).
- [ ] Script de seed (`src/seed.ts` + script en `package.json`):
  - 6 productos de [frontend/db/mockProducts.ts](../frontend/db/mockProducts.ts).
  - Histórico `MONTHLY_UNIT_SALES` de [frontend/db/mockData.ts](../frontend/db/mockData.ts) (como `Order`/`OrderItem` o tabla `MonthlySale`).
  - `AdminUser` semilla: `admin@botasdonchuy.mx`, rol `owner` (password hasheada con bcrypt).
  - `BrandSettings` con los defaults de [frontend/lib/brand.ts](../frontend/lib/brand.ts).

**Cómo verificar:** correr el seed; en psql, `SELECT count(*) FROM products;` → 6, y existe el `AdminUser` con email semilla.

---

### Fase 2 — Auth (desbloquea TODO el admin)

**Objetivo:** login real con JWT. Sin esto, ninguna ruta `/api/admin/*` se puede proteger ni el front puede entrar al panel.

**Por qué ahora:** el frontend ya tiene `/login` con `useMutation` mockeado esperando `api.post("/auth/login")`. Es el puente entre el front y todo el panel.

**Tareas:**
- [ ] `POST /api/auth/login` — valida con `loginSchema`, compara bcrypt, devuelve `{ token, user: { id, name, email, role } }`. `401` si credenciales inválidas.
- [ ] `POST /api/auth/forgot-password` — devuelve `{ ok: true }` **siempre** (no revelar si el correo existe).
- [ ] `GET /api/auth/me` `[auth]` — devuelve `{ user }` del token.
- [ ] `requireAuth` real: verifica `Authorization: Bearer <token>`, decodifica JWT, adjunta `req.user`. `401` si inválido/expirado.
- [ ] Check de rol (helper `requireRole('owner')`) para crear/eliminar admins.
- [ ] Rate-limit (express-rate-limit) en `/api/auth/login` y `/forgot-password`.

**Contrato exacto:**
```json
POST /api/auth/login  →  { "token": "<jwt>", "user": { "id": "...", "name": "Don Chuy", "email": "...", "role": "owner" } }
```

**Cómo verificar:** `curl -X POST /api/auth/login` con el usuario semilla → token. Repetir con password mala → `401`. En el front: cambiar la `mutationFn` de `LoginForm` por `api.post("/auth/login", credentials)` y entrar al panel.

---

### Fase 3 — Catálogo admin (CRUD de productos)

**Objetivo:** que Don Chuy pueda crear/editar/borrar productos desde el panel. **Incluye `costoUnitario`.**

**Por qué ahora:** ya tienes auth para protegerlo y el modelo `Product` corregido. Reemplaza el flujo de `ProductForm.tsx` / `ProductSection.tsx`.

**Tareas:**
- [ ] `GET /api/admin/products` `[auth]` — todos los productos (incluye `visible=false` y `costoUnitario`).
- [ ] `POST /api/admin/products` `[auth]` — valida con `productSchema`; parsea `sizes` string `"25, 26"` → `int[]`; calcula `discountPercent`; valida `salePrice ≤ originalPrice`.
- [ ] `PUT /api/admin/products/:id` `[auth]` — update parcial.
- [ ] `DELETE /api/admin/products/:id` `[auth]` — considerar soft-delete si hay pedidos que lo referencian.

> **Nota:** el `ProductForm` del front aún **no captura** `costoUnitario` ni dimensiones. Al cablear, hay que agregar esos inputs al form o asignar defaults por categoría — si no, los márgenes/reposición salen mal.

**Cómo verificar:** `POST` un producto con token → `201` con `discountPercent` calculado; sin token → `401`. `GET /api/products` público sigue **sin** `costoUnitario`.

---

### Fase 4 — Checkout (`POST /api/orders`)

**Objetivo:** convertir el carrito del cliente en un pedido persistido, con totales recalculados en el servidor.

**Por qué ahora:** cierra el ciclo de compra del storefront. Reusa el `cart` service de la Fase 0 y los modelos `Order`/`OrderItem` de la Fase 1.

**Tareas:**
- [ ] `POST /api/orders` (público) — body `{ items: [{ productId, size, quantity }], customer, shippingCarrier }`.
  - [ ] Validar `customer` con `shippingSchema`.
  - [ ] Cargar cada `Product`, **verificar stock por talla** (según decisión de Fase 0).
  - [ ] **Recalcular** `subtotal`, `savings`, `shipping`, `total` con el service de cart (NUNCA confiar en montos del cliente).
  - [ ] **Congelar** precios en cada `OrderItem`, descontar stock, persistir.
  - [ ] `409` con detalle del ítem si no hay stock; `400` si validación falla; `201` con `{ order }`.

**Cómo verificar:** `POST /api/orders` con 1 ítem → `201`, totales correctos, stock descontado en la BD. Forzar stock insuficiente → `409`.

---

### Fase 5 — Dashboard

**Objetivo:** alimentar el panel de datos del admin. Reemplaza `MOCK_DASHBOARD`.

**Por qué ahora:** ya hay órdenes (Fase 4) y productos (Fase 3) para agregar métricas reales.

**Tareas:**
- [ ] `GET /api/admin/dashboard` `[auth]` → `DashboardData` (ver tipo exacto en [frontend/components/admin/data/types.ts](../frontend/components/admin/data/types.ts)):
  - `kpis` y `profitKpis`: **`value` ya formateado en es-MX** (`"$245,506"`, `"58%"`) — el front lo pinta tal cual.
  - `revenueByPeriod`: las **tres** series `"7" | "30" | "90"` juntas (el front alterna en cliente).
  - `recentSales` (`SaleRow[]`) y `inventory` (`InventoryRow[]`, con `valorInventario = stock × costoUnitario`).
- [ ] `GET /api/admin/orders` `[auth]` → `Order[]` con items, para la vista de ventas detalladas.

**Cómo verificar:** `GET /api/admin/dashboard` con token → JSON con las 3 series de revenue y KPIs como strings formateados. Cablear `DataSection` del front contra el endpoint.

---

### Fase 6 — Reportes (ventas + reposición)

**Objetivo:** las dos pestañas de Reportes, que comparten una sola fuente (ventas-por-mes-por-producto).

**Por qué ahora:** depende de tener histórico de ventas (seed/órdenes) y del `forecast` service de la Fase 0.

**Tareas:**
- [ ] `GET /api/admin/reports/monthly` `[auth]` → `MonthlyReport[]` — agrupa ventas por mes; `revenue = unitsSold × salePrice`; **marcar `partial: true` el mes en curso**.
- [ ] `GET /api/admin/reports/replenishment` `[auth]` → `ReplenishmentRow[]` — **se computa on-the-fly** (no se persiste):
  - Por producto, sobre meses **completos** (excluir `partial`), extraer `unitsSold` → `computeForecast(monthlySales)`.
  - Calcular `diasCobertura`, `suggestedOrder = max(0, forecast × 2 − stock)`, `costoEstimadoPedido`, `ingresoMensual`, `margenMensual`, `priority` (`urgente` <15 días · `pronto` <45 · `ok`).
  - **Orden:** por urgencia de cobertura primero; dentro de cada nivel, por `margenMensual` desc.

> **Métricas derivadas (% del total, promedios, tendencia vs mes anterior) las calcula el FRONT.** El backend solo manda los meses crudos y las filas de reposición. No pre-agregar de más.

**Cómo verificar:** `GET /api/admin/reports/monthly` → el mes actual sale con `partial: true`. `replenishment` → las filas urgentes salen primero. Cablear `ReportesSection`.

---

### Fase 7 — Marca y usuarios

**Objetivo:** editar la identidad de la tienda y administrar usuarios del panel.

**Por qué ahora:** funcionalidad de configuración, no bloquea el flujo de compra; va al final del core.

**Tareas:**
- [ ] `GET /api/admin/brand` — **lectura pública** (la tienda pinta estos textos). Devuelve `BrandSettings`.
- [ ] `PUT /api/admin/brand` `[auth]` — acepta updates **parciales** (`MarcaSection` autoguarda campo por campo).
- [ ] `GET /api/admin/users` `[auth]` → `AdminUser[]` **sin `passwordHash`**.
- [ ] `POST /api/admin/users` `[auth]` (**solo `owner`**) — hashea password temporal.
- [ ] `DELETE /api/admin/users/:id` `[auth]` (**solo `owner`**).
- [ ] `PUT /api/admin/account` `[auth]` — cambiar correo/contraseña propios (verificar `currentPassword`, exigir `newPassword === confirmPassword` y ≥ 8 chars).

**Cómo verificar:** `PUT /api/admin/brand` con un solo campo → persiste; `POST /api/admin/users` con token de `editor` → `403`.

---

### Fase 8 — Después (diferido)

No bloquean el lanzamiento; hacerlos cuando el volumen lo justifique.

- [ ] **Skydropx** — `POST /api/shipping/rates`: construir payload `POST {SKYDROPX_BASE_URL}/api/v1/quotations` con las dimensiones del producto; normalizar respuesta a `ShippingRate[]`. Mapeo `ShippingData → Skydropx` en [frontend/BACKEND.md](../frontend/BACKEND.md) §5.4. Hasta entonces, el front calcula envío localmente (`computeShipping`).
- [ ] **Stripe** — `POST /api/orders` crea el pedido en `pending`, se genera el PaymentIntent, y un webhook `POST /api/webhooks/stripe` lo pasa a `paid`.

---

## 3. Tabla de contratos (cheatsheet)

Resumen rápido. El tipo de cada respuesta vive en el frontend (columna "Tipo").

| Método | Ruta | Auth | Request → Response | Tipo (front) |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | `{email,password}` → `{token,user}` | `loginSchema` |
| POST | `/api/auth/forgot-password` | — | `{email}` → `{ok}` | `forgotPasswordSchema` |
| GET | `/api/auth/me` | ✅ | → `{user}` | — |
| GET | `/api/products` | — | filtros → `ProductsResult` | `getProducts.ts` ✅ hecho |
| GET | `/api/products/:id` | — | → `Product` (sin costo) | ✅ hecho |
| POST | `/api/orders` | — | snapshot → `{order}` | `CartTotals` + `ShippingData` |
| GET | `/api/admin/products` | ✅ | → `Product[]` (con costo) | `MockProduct` |
| POST/PUT/DELETE | `/api/admin/products/:id?` | ✅ | `productSchema` → `Product` | — |
| GET | `/api/admin/dashboard` | ✅ | → `DashboardData` | `types.ts` |
| GET | `/api/admin/orders` | ✅ | → `Order[]` | — |
| GET | `/api/admin/reports/monthly` | ✅ | → `MonthlyReport[]` | `types.ts` |
| GET | `/api/admin/reports/replenishment` | ✅ | → `ReplenishmentRow[]` | `types.ts` |
| GET | `/api/admin/brand` | — | → `BrandSettings` | `MarcaData` |
| PUT | `/api/admin/brand` | ✅ | parcial → `BrandSettings` | — |
| GET/POST/DELETE | `/api/admin/users/:id?` | ✅ (owner) | → `AdminUser[]` (sin hash) | — |
| PUT | `/api/admin/account` | ✅ | `{currentPassword,newPassword,confirmPassword}` → `{ok}` | — |

---

## 4. Modelos Sequelize pendientes (referencia breve)

Detalle completo de campos en [frontend/BACKEND.md](../frontend/BACKEND.md) §3 (ignorar el bloque Prisma; traducir a `Model.init` de Sequelize como ya se hizo con `Product`).

- **`AdminUser`** — `id` (uuid), `name`, `email` (unique), `passwordHash`, `role` (ENUM `owner|admin|editor`, default `admin`), `createdAt`.
- **`Order`** — `id` (uuid), `status` (ENUM `pending|paid|shipped|delivered|cancelled`), `subtotal`/`savings`/`shipping`/`total` (int), datos de cliente (`customerName`, `customerEmail`, `customerPhone`, `street`, `neighborhood`, `city`, `state`, `postalCode`, `references?`), `shippingCarrier?`, `createdAt`. `hasMany(OrderItem)`.
- **`OrderItem`** — `id` (uuid), `orderId` (FK), `productId` (FK), `nameSnapshot`, `size` (int), `quantity` (int), y precios **congelados**: `unitOriginalPrice`, `unitSalePrice`, `unitCosto`.
- **`BrandSettings`** — singleton (`id=1`): `brandName`, `heroText`, `tagline`, `cartNotice`, `footerNote`, `logoUrl?`, `updatedAt`.
- **`ProductSize`** (opcional, según decisión Fase 0) — `productId`, `size`, `stock`.

> **Stock por talla:** hoy el front cuenta `product.sizes.filter(s => s === size).length` en `ProductInfo`, `Cart` y `cartStore`. Si cambias a `ProductSize`, hay que actualizar esos tres lugares **o** seguir exponiendo `sizes` como `number[]` derivado (repetición) para no romper el front.

---

## 5. Reglas de negocio a portar (funciones puras)

Son funciones que **reciben números y devuelven números** — cópialas para que front y back den el mismo resultado. Van en `src/services/` (Fase 0).

- **Forecast** — [frontend/lib/forecast.ts](../frontend/lib/forecast.ts): `computeForecast(monthlySales: number[])`. Auto-escala: 1–2 meses promedio simple, 3 ponderado+tendencia, 4+ Holt (α=0.4, β=0.3). **Copiar el archivo completo.**
- **Totales del carrito** — [frontend/lib/cart.ts](../frontend/lib/cart.ts): `subtotal = Σ(originalPrice × qty)`, `savings = Σ((original − sale) × qty)`, `total = subtotal − savings + shipping`.
- **Envío (tarifa plana)** — `SHIPPING_BY_TYPE = { bota: 160, sombrero: 130, ropa: 100 }`, fallback 150; se cobra la tarifa del ítem más caro de enviar. Origen: Celaya, GTO, CP 38000.
- **Reposición** — fórmula en `buildReplenishment()` (`db/mockData.ts`): cobertura primero, margen como desempate (ver Fase 6).

---

## 6. Notas de seguridad

- **`costoUnitario`, `margenMensual`, `costoTotal`, `valorInventario`, `costoEstimadoPedido` son sensibles.** Solo en rutas `/api/admin/*` autenticadas. Las públicas de catálogo **nunca** los incluyen (ya respetado en `product.controller.ts`).
- **Recalcular siempre los totales en el servidor** al crear pedidos. El cliente dice qué quiere; el backend decide cuánto cuesta.
- **Verificar stock por talla** en el servidor antes de confirmar (el front valida, pero no es autoritativo).
- **Contraseñas con bcrypt** (nunca texto plano). `forgot-password` no revela si un correo existe.
- **CORS** restringido a `CORS_ORIGIN` (ya configurado).
- **Rate limiting** en `/api/auth/login` y `/forgot-password`.
- **JWT** con expiración; validar rol (crear/eliminar admins = solo `owner`).
- **Keys de Skydropx/Stripe/Cloudinary** solo en el servidor.

---

## 7. Checklist maestro

**Fase 0 — Cimientos**
- [ ] Arreglar `unitCost → costoUnitario`, precios enteros, `discountPercent` derivado en el modelo
- [ ] Decidir modelo de stock por talla
- [ ] Middleware de errores + `asyncHandler`
- [ ] Portar `forecast` y `cart` a `src/services/`
- [ ] Esquemas zod en `src/schemas/`
- [ ] Esqueleto `requireAuth`

**Fase 1 — Datos base**
- [ ] Modelos `AdminUser`, `Order`, `OrderItem`, `BrandSettings` (+ `ProductSize`?)
- [ ] Asociaciones y registro en `app.ts`
- [ ] Script de seed (productos, histórico, admin, brand)

**Fase 2 — Auth**
- [ ] `POST /api/auth/login`
- [ ] `POST /api/auth/forgot-password`
- [ ] `GET /api/auth/me`
- [ ] `requireAuth` + `requireRole` + rate-limit

**Fase 3 — Catálogo admin**
- [ ] `GET /api/admin/products`
- [ ] `POST /api/admin/products`
- [ ] `PUT /api/admin/products/:id`
- [ ] `DELETE /api/admin/products/:id`

**Fase 4 — Checkout**
- [ ] `POST /api/orders` (recalcular totales, stock por talla, congelar precios)

**Fase 5 — Dashboard**
- [ ] `GET /api/admin/dashboard`
- [ ] `GET /api/admin/orders`

**Fase 6 — Reportes**
- [ ] `GET /api/admin/reports/monthly`
- [ ] `GET /api/admin/reports/replenishment`

**Fase 7 — Marca y usuarios**
- [ ] `GET/PUT /api/admin/brand`
- [ ] `GET/POST/DELETE /api/admin/users`
- [ ] `PUT /api/admin/account`

**Fase 8 — Después**
- [ ] Skydropx `POST /api/shipping/rates`
- [ ] Stripe PaymentIntent + webhook

**Ya hecho ✅**
- [x] Express + Sequelize + PostgreSQL + `/health`
- [x] Modelo `Product`
- [x] `GET /api/products` (filtros, paginación, oculta costo)
- [x] `GET /api/products/:id`
