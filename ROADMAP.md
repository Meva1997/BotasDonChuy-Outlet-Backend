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

El modelo `Product` ya está alineado con el frontend en nombre de campo y formato de precio. Estado actual:

1. **`unitCost` (✅ alineado).** El modelo expone el campo como `unitCost` y el frontend ya lo consume como **`unitCost`** (`MockProduct`, tipos del admin, mocks). El JSON de rutas admin hace match. **Sin acción en el backend.** (Antes el front usaba `costoUnitario`; se renombró en el front para coincidir con el modelo.)
2. **Precios con decimales (✅ alineado).** Los precios se guardan como `DECIMAL(10,2)` y **pueden tener centavos** (`salePrice: 1920.50`). El front ya es decimal-safe y los formatea con 2 decimales. **No forzar enteros** — servir el número tal cual (no string).
3. **`discountPercent` derivado (✅ cerrado).** Convertido a campo `VIRTUAL` en [src/models/Product.ts](src/models/Product.ts): se calcula con `round((originalPrice - salePrice) / originalPrice * 100)` al leer, nunca se guarda ni se puede mandar desde el cliente. La columna física se elimina del `sync({ alter: true })` en el próximo arranque en dev.
4. **Decisión de stock por talla (✅ cerrada, revertida en Fase 1).** Se introdujo el modelo `ProductSize` (`productId`, `size`, `stock`, único por `(productId, size)`) como fuente de verdad real del stock por talla — ver [src/models/ProductSize.ts](src/models/ProductSize.ts) y la asociación `Product.hasMany(ProductSize, { as: "productSizes" })` en [src/models/associations.ts](src/models/associations.ts). Razón del cambio: descontar stock removiendo una ocurrencia de un array Postgres no es atómico (requiere leer-filtrar-reescribir), lo que abre condiciones de carrera en checkouts concurrentes (Fase 4); con `ProductSize` el descuento es un `UPDATE ... SET stock = stock - 1 WHERE stock > 0` atómico. **El contrato público no cambia:** `Product.sizes` (repetido, p. ej. `[25, 25, 26]`) y `Product.stock` (total) ahora son campos `VIRTUAL` derivados de `productSizes` cuando se incluye la asociación (ver `product.controller.ts`), así que el frontend sigue recibiendo exactamente la misma forma de datos sin tocar `ProductInfo.tsx`, `cartStore.ts` ni `Cart.tsx`.

---

## 2. Mapa de fases

Construye en este orden. Cada fase desbloquea la siguiente.

### Fase 0 — Cimientos transversales

**Objetivo:** dejar listas las piezas que todas las demás fases van a usar, y saldar la deuda de contrato del `Product`.

**Por qué ahora:** sin middleware de errores, validación y la lógica de negocio portada, cada endpoint posterior tendría que reinventarlas. El nombre `unitCost` y los precios decimales ya están alineados (puntos 1–2); falta cerrar `discountPercent` derivado y decidir el stock por talla.

**Tareas:**
- [x] Cerrar el `discountPercent` derivado (punto 3 de arriba) en [src/models/Product.ts](src/models/Product.ts). Los puntos 1–2 (`unitCost` + precios decimales) ya están alineados.
- [x] Decidir el modelo de stock por talla (punto 4 de arriba) y documentar la decisión aquí.
- [x] Middleware de manejo de errores centralizado en `src/middlewares/` (captura zod, Sequelize, y errores genéricos → JSON con `message` en español).
- [x] Wrapper `asyncHandler` para no repetir try/catch en cada controller.
- [x] Portar [frontend/lib/forecast.ts](../frontend/lib/forecast.ts) **tal cual** a `src/services/forecast.ts` (es función pura, no depende del front).
- [x] Portar la lógica de [frontend/lib/cart.ts](../frontend/lib/cart.ts) (`computeTotals`, `computeShipping`, `SHIPPING_BY_TYPE`) a `src/services/cart.ts`.
- [x] Crear esquemas zod en `src/schemas/` replicando [frontend/schemas/](../frontend/schemas/): `shippingSchema`, `loginSchema`, `productSchema` (extendido con `unitCost` + dimensiones + `code`).
- [x] Esqueleto de `requireAuth` en `src/middlewares/` (placeholder; la lógica JWT real llega en Fase 2).

**Cómo verificar:** `GET /api/products/1` sigue respondiendo y los precios salen como número (con decimales si los hay, p. ej. `1920.5`); el modelo expone `unitCost` — confirmarlo solo en una ruta admin más adelante, en la pública sigue oculto.

---

### Fase 1 — Datos base (modelos restantes + seed)

**Objetivo:** tener todas las tablas y datos de arranque para poder construir y probar el resto.

**Por qué ahora:** no puedes construir login sin tabla `AdminUser`, ni dashboard sin órdenes/ventas. El seed te da datos reales contra los que probar cada endpoint.

**Tareas:**
- [x] Modelo `AdminUser` (`id`, `name`, `email` unique, `passwordHash`, `role` enum `owner|admin`, `createdAt`).
- [x] Modelo `Order` (snapshot de totales + datos de envío; ver Fase/§4).
- [x] Modelo `OrderItem` (un renglón por ítem, con precios **congelados**: `unitOriginalPrice`, `unitSalePrice`, `unitCosto`).
- [x] Modelo `BrandSettings` (singleton: `brandName`, `heroText`, `tagline`, `cartNotice`, `footerNote`, `logoUrl`).
- [x] Modelo `ProductSize` (`productId`, `size`, `stock`) — ver decisión revertida en Fase 0, punto 4.
- [x] Asociación `Product.hasMany(ProductSize, { as: "productSizes" })` / `ProductSize.belongsTo(Product)` en [src/models/associations.ts](src/models/associations.ts).
- [x] Asociaciones Sequelize: `Order.hasMany(OrderItem)`, `OrderItem.belongsTo(Product)`.
- [x] Registrar **todos** los modelos importándolos en [src/app.ts](src/app.ts) (si no se importan, `sync` no los crea).
- [x] Script de seed (`src/seed.ts` + script en `package.json`):
  - 6 productos de [frontend/db/mockProducts.ts](../frontend/db/mockProducts.ts).
  - Histórico `MONTHLY_UNIT_SALES` de [frontend/db/mockData.ts](../frontend/db/mockData.ts), modelado como `Order`/`OrderItem` reales (un pedido `paid` por mes, `createdAt` fijado a ese mes) en vez de una tabla `MonthlySale` nueva.
  - `AdminUser` semilla: `mevadev97@gmail.com`, rol `admin` (password `password` hasheada con bcrypt; `owner` y `admin` tienen los mismos permisos, así que el rol semilla no importa).
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

**Objetivo:** que Don Chuy pueda crear/editar/borrar productos desde el panel. **Incluye `unitCost`.**

**Por qué ahora:** ya tienes auth para protegerlo y el modelo `Product` corregido. Reemplaza el flujo de `ProductForm.tsx` / `ProductSection.tsx`.

**Tareas:**
- [ ] `GET /api/admin/products` `[auth]` — todos los productos (incluye `visible=false` y `unitCost`).
- [ ] `POST /api/admin/products` `[auth]` — valida con `productSchema`; parsea `sizes` string `"25, 26"` → `int[]`; calcula `discountPercent`; valida `salePrice ≤ originalPrice`.
- [ ] `PUT /api/admin/products/:id` `[auth]` — update parcial.
- [ ] `DELETE /api/admin/products/:id` `[auth]` — considerar soft-delete si hay pedidos que lo referencian.

> **Nota:** el `ProductForm` del front aún **no captura** `unitCost` ni dimensiones. Al cablear, hay que agregar esos inputs al form o asignar defaults por categoría — si no, los márgenes/reposición salen mal.

**Cómo verificar:** `POST` un producto con token → `201` con `discountPercent` calculado; sin token → `401`. `GET /api/products` público sigue **sin** `unitCost`.

---

### Fase 4 — Checkout (`POST /api/orders`)

**Objetivo:** convertir el carrito del cliente en un pedido persistido, con totales recalculados en el servidor.

**Por qué ahora:** cierra el ciclo de compra del storefront. Reusa el `cart` service de la Fase 0 y los modelos `Order`/`OrderItem` de la Fase 1.

**Tareas:**
- [ ] `POST /api/orders` (público) — body `{ items: [{ productId, size, quantity }], customer, shippingCarrier }`.
  - [ ] Validar `customer` con `shippingSchema`.
  - [ ] Cargar cada `Product`, **verificar stock por talla** contra la fila `ProductSize` correspondiente.
  - [ ] **Recalcular** `subtotal`, `savings`, `shipping`, `total` con el service de cart (NUNCA confiar en montos del cliente).
  - [ ] **Congelar** precios en cada `OrderItem`, descontar stock **atómicamente** sobre `ProductSize.stock` (`UPDATE ... SET stock = stock - 1 WHERE stock > 0`, dentro de una transacción), persistir.
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
  - `recentSales` (`SaleRow[]`) y `inventory` (`InventoryRow[]`, con `valorInventario = stock × unitCost`).
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

**Cómo verificar:** `PUT /api/admin/brand` con un solo campo → persiste; `POST /api/admin/users` con token de `admin` → `403`.

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

- **`AdminUser`** — `id` (uuid), `name`, `email` (unique), `passwordHash`, `role` (ENUM `owner|admin`, default `admin`), `createdAt`.
- **`Order`** — `id` (uuid), `status` (ENUM `pending|paid|shipped|delivered|cancelled`), `subtotal`/`savings`/`shipping`/`total` (int), datos de cliente (`customerName`, `customerEmail`, `customerPhone`, `street`, `neighborhood`, `city`, `state`, `postalCode`, `references?`), `shippingCarrier?`, `createdAt`. `hasMany(OrderItem)`.
- **`OrderItem`** — `id` (uuid), `orderId` (FK), `productId` (FK), `nameSnapshot`, `size` (int), `quantity` (int), y precios **congelados**: `unitOriginalPrice`, `unitSalePrice`, `unitCosto`.
- **`BrandSettings`** — singleton (`id=1`): `brandName`, `heroText`, `tagline`, `cartNotice`, `footerNote`, `logoUrl?`, `updatedAt`.
- **`ProductSize`** (✅ implementado en Fase 1) — `productId`, `size`, `stock`. Único por `(productId, size)`. Fuente de verdad real del stock por talla.

> **Stock por talla:** el front sigue contando `product.sizes.filter(s => s === size).length` en `ProductInfo`, `Cart` y `cartStore` — **sin tocar esos archivos**, porque `Product.sizes` (repetido) y `Product.stock` (total) son ahora campos `VIRTUAL` derivados de `productSizes` en el backend. El descuento real al confirmar un pedido (Fase 4) debe operar sobre `ProductSize.stock` con un `UPDATE` atómico (`stock = stock - 1 WHERE stock > 0`), no sobre el array derivado.

---

## 5. Reglas de negocio a portar (funciones puras)

Son funciones que **reciben números y devuelven números** — cópialas para que front y back den el mismo resultado. Van en `src/services/` (Fase 0).

- **Forecast** — [frontend/lib/forecast.ts](../frontend/lib/forecast.ts): `computeForecast(monthlySales: number[])`. Auto-escala: 1–2 meses promedio simple, 3 ponderado+tendencia, 4+ Holt (α=0.4, β=0.3). **Copiar el archivo completo.**
- **Totales del carrito** — [frontend/lib/cart.ts](../frontend/lib/cart.ts): `subtotal = Σ(originalPrice × qty)`, `savings = Σ((original − sale) × qty)`, `total = subtotal − savings + shipping`.
- **Envío (tarifa plana)** — `SHIPPING_BY_TYPE = { bota: 160, sombrero: 130, ropa: 100 }`, fallback 150; se cobra la tarifa del ítem más caro de enviar. Origen: Celaya, GTO, CP 38000.
- **Reposición** — fórmula en `buildReplenishment()` (`db/mockData.ts`): cobertura primero, margen como desempate (ver Fase 6).

---

## 6. Notas de seguridad

- **`unitCost`, `margenMensual`, `costoTotal`, `valorInventario`, `costoEstimadoPedido` son sensibles.** Solo en rutas `/api/admin/*` autenticadas. Las públicas de catálogo **nunca** los incluyen (ya respetado en `product.controller.ts`).
- **Recalcular siempre los totales en el servidor** al crear pedidos. El cliente dice qué quiere; el backend decide cuánto cuesta.
- **Verificar y descontar stock por talla** en el servidor antes de confirmar, sobre `ProductSize.stock` con `UPDATE` atómico dentro de una transacción (el front valida, pero no es autoritativo).
- **Contraseñas con bcrypt** (nunca texto plano). `forgot-password` no revela si un correo existe.
- **CORS** restringido a `CORS_ORIGIN` (ya configurado).
- **Rate limiting** en `/api/auth/login` y `/forgot-password`.
- **JWT** con expiración; validar rol (crear/eliminar admins = solo `owner`).
- **Keys de Skydropx/Stripe/Cloudinary** solo en el servidor.

---

## 7. Checklist maestro

**Fase 0 — Cimientos**
- [x] Cerrar `discountPercent` derivado en el modelo (`unitCost` + precios decimales ya alineados con el front)
- [x] Decidir modelo de stock por talla
- [x] Middleware de errores + `asyncHandler`
- [x] Portar `forecast` y `cart` a `src/services/`
- [x] Esquemas zod en `src/schemas/`
- [x] Esqueleto `requireAuth`

**Fase 1 — Datos base**
- [x] Modelos `AdminUser`, `Order`, `OrderItem`, `BrandSettings`, `ProductSize`
- [x] Asociación `Product`↔`ProductSize` y registro en `app.ts`
- [x] Asociaciones `Order`↔`OrderItem` y registro en `app.ts`
- [x] Script de seed (productos, histórico, admin, brand)

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
