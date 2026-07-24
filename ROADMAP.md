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
| Auth (login, JWT, `requireAuth`) | ✅ Hecho | [src/routes/auth.routes.ts](src/routes/auth.routes.ts) |
| Modelos `Order`, `OrderItem`, `AdminUser`, `BrandSettings` | ✅ Hecho | [src/models/](src/models/) |
| Seed de datos | ✅ Hecho | [src/seed.ts](src/seed.ts) |
| CRUD admin de productos | ✅ Hecho | [src/routes/adminProduct.routes.ts](src/routes/adminProduct.routes.ts) |
| Checkout (`POST /api/orders`) | ✅ Hecho | [src/services/orders.service.ts](src/services/orders.service.ts) |
| Dashboard (`GET /api/admin/dashboard`, `GET /api/admin/orders`) | ✅ Hecho | [src/services/dashboard.service.ts](src/services/dashboard.service.ts) |
| Reportes (`/api/admin/reports/monthly`, `/replenishment`) | ✅ Hecho | [src/services/reports.service.ts](src/services/reports.service.ts) |
| Marca, usuarios | ✅ Hecho | Fase 7 |
| Imágenes de producto + logo de marca (Cloudinary) | ✅ Hecho | Fase 3 (ver Imágenes) |
| Lógica `forecast` / `cart` portada al backend | ✅ Hecho | [src/services/forecast.ts](src/services/forecast.ts) / [src/services/cart.ts](src/services/cart.ts) |
| Emails transaccionales — forgot-password (código 5 dígitos) + confirmación de pedido, Resend | ✅ Hecho | Fase 9 |

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
- [x] `POST /api/auth/login` — valida con `loginSchema`, compara bcrypt, devuelve `{ token, user: { id, name, email, role } }`. `401` si credenciales inválidas.
- [x] `POST /api/auth/forgot-password` — devuelve `{ ok: true }` **siempre** (no revelar si el correo existe).
- [x] `GET /api/auth/me` `[auth]` — devuelve `{ user }` del token.
- [x] `requireAuth` real: verifica `Authorization: Bearer <token>`, decodifica JWT, adjunta `req.user`. `401` si inválido/expirado.
- [x] Check de rol (helper `requireRole('owner')`) para crear/eliminar admins.
- [x] Rate-limit (express-rate-limit) en `/api/auth/login` y `/forgot-password`.

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
- [x] `GET /api/admin/products` `[auth]` — todos los productos (incluye `visible=false` y `unitCost`).
- [x] `POST /api/admin/products` `[auth]` — valida con `productSchema`; parsea `sizes` string `"25, 26"` → `int[]`; calcula `discountPercent`; valida `salePrice ≤ originalPrice`.
- [x] `PUT /api/admin/products/:id` `[auth]` — update parcial.
- [x] `DELETE /api/admin/products/:id` `[auth]` — soft-delete si hay pedidos que lo referencian; hard-delete (con CASCADE en ProductSize) si no.

> **Nota (✅ resuelta):** el `ProductForm` del front ya captura `unitCost` y las dimensiones (`weightKg`, `lengthCm`, `widthCm`, `heightCm`), con defaults por categoría vía `DEFAULT_DIMENSIONS` — ver [frontend/components/admin/products/ProductForm.tsx](../frontend/components/admin/products/ProductForm.tsx).

**Imágenes de producto y logo de marca (Cloudinary).** Implementado más tarde en la cronología real
(rama `feature/fase-3-imagenes-cloudinary`, PR #12, mergeada **después** de la Fase 8) pero se agrupa
aquí porque extiende temáticamente el CRUD de productos (y, para el logo, la identidad de marca de la
Fase 7):
- [x] `src/config/cloudinary.ts` (hard-require de `CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`) +
  `src/middlewares/upload.ts` (multer en memoria, solo PNG/JPEG/WEBP, máx. 5 MB) +
  `src/services/image.service.ts` (`upload_stream`/`destroy`).
- [x] `POST /api/admin/products/:id/images` `[auth]` — sube de 1 a 3 imágenes, tope de 3 en total
  revalidado bajo lock de fila (`SELECT ... FOR UPDATE`); subida **todo o nada** (si falla una, se
  destruyen las que sí subieron).
- [x] `DELETE /api/admin/products/:id/images` `[auth]` — borra una imagen por `publicId`; persiste el
  cambio en BD antes de destruir el asset en Cloudinary (nunca al revés).
- [x] `POST /api/admin/brand/logo` `[auth]` / `DELETE /api/admin/brand/logo` `[auth]` — sube o quita
  el logo de marca, destruyendo el anterior en Cloudinary tras persistir el nuevo.

**Cómo verificar:** `POST` un producto con token → `201` con `discountPercent` calculado; sin token → `401`. `GET /api/products` público sigue **sin** `unitCost`. `POST /api/admin/products/:id/images` con 1-3 archivos → `201` con las imágenes agregadas a `Product.images` (máx. 3 en total).

---

### Fase 4 — Checkout (`POST /api/orders`)

**Objetivo:** convertir el carrito del cliente en un pedido persistido, con totales recalculados en el servidor.

**Por qué ahora:** cierra el ciclo de compra del storefront. Reusa el `cart` service de la Fase 0 y los modelos `Order`/`OrderItem` de la Fase 1.

**Tareas:**
- [x] `POST /api/orders` (público) — body `{ items: [{ productId, size, quantity }], customer, shippingCarrier }`.
  - [x] Validar `customer` con `shippingSchema` (vía `createOrderSchema`).
  - [x] Cargar cada `Product`, **verificar stock por talla** contra la fila `ProductSize` correspondiente.
  - [x] **Recalcular** `subtotal`, `savings`, `shipping`, `total` con el service de cart (NUNCA confiar en montos del cliente).
  - [x] **Congelar** precios en cada `OrderItem`, descontar stock **atómicamente** sobre `ProductSize.stock` (`UPDATE ... SET stock = stock - N WHERE stock >= N`, dentro de una transacción), persistir.
  - [x] `409` con detalle del ítem si no hay stock; `400` si validación falla; `201` con `{ order, clientSecret }`.

> **Stripe (Fase 8, ✅ hecho):** la orden nace en `pending` con el stock **reservado** al crearla.
> Columnas `paymentIntentId`/`paymentStatus` en `Order`; `src/services/payment.service.ts` crea un
> PaymentIntent real y `POST /api/webhooks/stripe` verifica la firma del evento y reconcilia el pago
> (`succeeded`/`payment_failed`/`canceled`). Ver Fase 8 para el detalle completo.

**Cómo verificar:** `POST /api/orders` con 1 ítem → `201`, totales correctos, stock descontado en la BD. Forzar stock insuficiente → `409`.

---

### Fase 5 — Dashboard

**Objetivo:** alimentar el panel de datos del admin. Reemplaza `MOCK_DASHBOARD`.

**Por qué ahora:** ya hay órdenes (Fase 4) y productos (Fase 3) para agregar métricas reales.

**Tareas:**
- [x] `GET /api/admin/dashboard` `[auth]` → `DashboardData` (ver tipo exacto en [frontend/components/admin/data/types.ts](../frontend/components/admin/data/types.ts)):
  - `kpis` y `profitKpis`: **`value` ya formateado en es-MX** (`"$245,506"`, `"58%"`) — el front lo pinta tal cual.
  - `revenueByPeriod`: las **tres** series `"7" | "30" | "90"` juntas (el front alterna en cliente).
  - `recentSales` (`SaleRow[]`) y `inventory` (`InventoryRow[]`, con `valorInventario = stock × unitCost`).
- [x] `GET /api/admin/orders` `[auth]` → `Order[]` con items, para la vista de ventas detalladas.

**Cómo verificar:** `GET /api/admin/dashboard` con token → JSON con las 3 series de revenue y KPIs como strings formateados. Cablear `DataSection` del front contra el endpoint.

---

### Fase 6 — Reportes (ventas + reposición)

**Objetivo:** las dos pestañas de Reportes, que comparten una sola fuente (ventas-por-mes-por-producto).

**Por qué ahora:** depende de tener histórico de ventas (seed/órdenes) y del `forecast` service de la Fase 0.

**Tareas:**
- [x] `GET /api/admin/reports/monthly` `[auth]` → `MonthlyReport[]` — agrupa ventas por mes; `revenue = unitsSold × salePrice`; **marcar `partial: true` el mes en curso**.
- [x] `GET /api/admin/reports/replenishment` `[auth]` → `ReplenishmentRow[]` — **se computa on-the-fly** (no se persiste):
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
- [x] `GET /api/admin/brand` — **lectura pública** (la tienda pinta estos textos). Devuelve `BrandSettings`.
- [x] `PUT /api/admin/brand` `[auth]` — acepta updates **parciales** (`MarcaSection` autoguarda campo por campo). El logo (`logoUrl`/`logoPublicId`) **no** se toca aquí — se gestiona con `POST`/`DELETE /api/admin/brand/logo` (Cloudinary, ver Fase 3).
- [x] `GET /api/admin/users` `[auth]` → `AdminUser[]` **sin `passwordHash`**.
- [x] `POST /api/admin/users` `[auth]` — hashea password temporal. **Decisión (Fase 7):** no restringido a `owner`; `owner` y `admin` tienen los mismos permisos en esta ruta (consistente con la nota de Fase 1 de que ambos roles son equivalentes hoy), a diferencia de la redacción original de esta tarea.
- [x] `DELETE /api/admin/users/:id` `[auth]` — mismo criterio que arriba (no restringido a `owner`); en cambio bloquea con `400` la autoeliminación y la eliminación del último `owner` restante (guardas de integridad, no de rol).
- [x] `PUT /api/admin/account` `[auth]` — cambiar correo/contraseña propios (verificar `currentPassword`, exigir `newPassword === confirmPassword` y ≥ 8 chars).

**Cómo verificar:** `PUT /api/admin/brand` con un solo campo → persiste; `POST /api/admin/users` con token de `admin` → `201` (mismos permisos que `owner`, ver decisión arriba); sin token → `401`.

---

### Fase 8 — Después (diferido)

**Objetivo:** funcionalidad que no bloquea el lanzamiento del core; se implementa cuando el volumen de pedidos lo justifique.

**Por qué ahora (o después):** Stripe ya quedó resuelto en sandbox junto con el checkout (Fase 4); Skydropx queda diferido porque hoy el front calcula el envío localmente (`computeShipping`) y no bloquea la compra.

**Tareas:**
- [x] **Skydropx** (✅ hecho — ver [roadmap-skydropx.md](roadmap-skydropx.md)) — cotización en vivo (`POST /api/shipping/rates`, con fallback a `computeShipping`), órdenes con tarifa real, guía automática al pagar y webhook de estado de envío; Swagger documentado (Fase 8.7).
  > **Nota de integración con Fase 9 (emails):** cuando Skydropx quede cableado y `Order` gane columnas de guía/rastreo (p. ej. `trackingNumber`/`trackingUrl`/`carrier`), lo natural es un email adicional "tu pedido fue enviado" reusando `src/services/email.service.ts` y el layout base de la Fase 9 — **no** un servicio de correo aparte. Por eso el email de confirmación de pedido de la Fase 9 debe construirse con una plantilla que **no dé por hecho** que nunca habrá datos de envío (aunque hoy no los tenga), para no tener que rediseñarla cuando Skydropx llegue.
- [x] **Stripe** (✅ hecho, solo test/sandbox) — `POST /api/orders` crea el pedido en `pending` y genera un PaymentIntent real (`src/services/payment.service.ts`); `POST /api/webhooks/stripe` verifica la firma sobre el cuerpo crudo (`express.raw`) y maneja `payment_intent.succeeded` → `paid`, `payment_intent.payment_failed` → `failed` y `payment_intent.canceled` → restock + `cancelled`. Un barrido (`src/services/pendingOrderSweeper.ts`) libera el stock de órdenes `pending` abandonadas reconciliándolas contra Stripe. Llaves exigidas: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.

**Cómo verificar:** Stripe ya cubierto en la verificación de la Fase 4 (checkout → PaymentIntent → webhook). Skydropx queda pendiente de implementación.

---

### Fase 9 — Emails transaccionales (Resend)

**Objetivo:** que `forgot-password` deje de ser un stub (`{ ok: true }` sin enviar nada) y que el cliente reciba un correo de confirmación cuando su pedido pasa a `paid`.

**Por qué ahora (y por qué no antes):** depende de Auth (Fase 2, para el flujo de reset) y de Checkout + Stripe (Fase 4/8, para saber cuándo un pedido está pagado). No bloquea nada del core — es la primera pieza de "Después" que sí tiene impacto directo en el usuario final, a diferencia de Skydropx que hoy el front ya resuelve localmente.

**Por qué Resend y no Nodemailer/SendGrid:** SDK simple (`resend.emails.send(...)`), no requiere gestionar SMTP propio, y el plan gratuito alcanza para el volumen de esta tienda. **Confirmado con la documentación oficial (Context7, `/websites/resend`):**
- **Plan gratis:** 100 emails/día y 3,000 emails/mes (transaccional; envíos + recibidos cuentan juntos; cada destinatario en `to`/`cc`/`bcc` cuenta como un email separado). Sin límite diario en planes de pago.
- **⚠️ Restricción crítica mientras no se verifique un dominio propio:** usando el remitente de pruebas `onboarding@resend.dev`, la API **solo permite enviar al correo de la cuenta de Resend** (error `403 validation_error` a cualquier otro destinatario). Esto es suficiente para desarrollar y probar `forgot-password`/confirmación contra tu propio correo, **pero no sirve para producción** — para que un cliente real reciba su confirmación de pedido hace falta verificar un dominio propio (registros DNS SPF/DKIM en Resend) y usar un remitente de ese dominio (p. ej. `pedidos@botasdonchuy.com`). Ver tarea de dominio más abajo — es un paso manual, no de código.
- El SDK soporta `idempotencyKey` (expira a las 24h) para evitar duplicados si el mismo evento se procesa dos veces — clave para el email de confirmación, que puede dispararse tanto desde el webhook de Stripe como desde el barrido de `pending` (Fase 8).

**Tareas:**

**9.1 — Cimientos**
- [x] Instalar `resend` (`pnpm add resend`).
- [x] `src/config/resend.ts`: mismo patrón que `src/config/stripe.ts`/`cloudinary.ts` — `dotenv.config()` propio al inicio del módulo, **hard-require** de `RESEND_API_KEY` (throw al arrancar si falta) y `EMAIL_FROM` (p. ej. `"Botas Don Chuy <pedidos@botasdonchuy.com>"`, o `onboarding@resend.dev` mientras no haya dominio verificado). Exporta el cliente `resend` ya inicializado.
- [x] `src/services/email.service.ts`: función base `sendEmail({ to, subject, html, idempotencyKey? })` que envuelve `resend.emails.send(...)`, hace `try/catch` y **loguea pero no lanza** en caso de error de Resend (un email fallido nunca debe tumbar el request que lo dispara — ni el login/checkout ni el webhook de Stripe). Las plantillas HTML viven en `src/services/email/templates/` (funciones que devuelven un string, no un motor de plantillas nuevo — no hace falta esa dependencia extra para 2 correos).
- [x] Documentar en `.env`/README las nuevas variables: `RESEND_API_KEY`, `EMAIL_FROM`, `FRONTEND_URL`.

**9.2 — `forgot-password` real + verificación de código + `reset-password`**

> **Desviación del diseño original (decidida con el usuario):** en vez de un **link con token**
> (`/reset-password?token=...`), se usa un **código de 5 dígitos numéricos** que el usuario teclea
> en el frontend. Esto añade un endpoint intermedio `POST /api/auth/verify-reset-code` que valida
> el código y desbloquea la página de reset en el front. El token largo con `crypto.randomBytes` se
> sustituye por `crypto.randomInt(0,100000)` (hash sha256 igual). Columnas: `resetPasswordCodeHash`
> en vez de `resetPasswordTokenHash`, más `resetPasswordAttempts` (anti-fuerza-bruta: el espacio de
> 5 dígitos es pequeño). Expiración 15 min, un solo uso, invalidado tras 5 intentos fallidos.

- [x] Migrar `AdminUser`: agregar `resetPasswordCodeHash` (nullable), `resetPasswordExpiresAt` (nullable) y `resetPasswordAttempts` (default 0). El código **nunca se guarda en claro** — se genera con `crypto.randomInt`, se manda por correo, y solo su hash (sha256) se persiste. Excluir las 3 columnas de `GET /api/admin/users`.
- [x] `POST /api/auth/forgot-password`: si el `email` existe, genera el código, lo guarda hasheado con expiración de 15 min, y llama a `email.service` para mandar el correo con el código. **Sigue devolviendo `{ ok: true }` siempre** (exista o no el correo).
- [x] `POST /api/auth/verify-reset-code` (nuevo, público, `authRateLimiter`): valida `{ email, code }` con `verifyResetCodeSchema`. Confirma que el código coincide y no expiró ni agotó intentos; **no consume el código** (solo desbloquea el front). `400` genérico si falla.
- [x] `POST /api/auth/reset-password` (nuevo, público, `authRateLimiter`): valida `{ email, code, newPassword, confirmPassword }` con `resetPasswordSchema` (misma complejidad que `loginSchema`/`tempPassword`). **Revalida** el código, hashea la nueva password, limpia el código (de un solo uso) y devuelve `{ ok: true }`.

**9.3 — Email de confirmación de pedido**
- [x] Disparar el envío **dentro de `markOrderPaidFromWebhook`** (`src/services/payment.service.ts`), no en un lugar nuevo — es el único punto por el que un pedido pasa a `paid`, tanto desde el webhook `payment_intent.succeeded` como desde la reconciliación del `pendingOrderSweeper`, así que ya hereda la idempotencia que ese servicio necesita.
- [x] **Idempotencia real, no solo la del SDK:** `markOrderPaidFromWebhook` hace la transición a `paid` con un **UPDATE atómico condicional** (`Order.update({...}, { where: { id, paymentStatus: { [Op.ne]: "paid" } } })`) y solo envía el correo cuando `affectedCount === 1`. El `WHERE paymentStatus != 'paid'` serializa a nivel de BD el webhook y el barrido concurrentes (un guard en memoria no bastaría: dos llamadas podrían leer `processing` antes de que cualquiera escriba y ambas enviarían). Además, `idempotencyKey: order-confirmation/${order.id}` en `resend.emails.send` como segundo cinturón (24h). El envío se aísla en `sendOrderConfirmationEmail(order)` y se dispara **fire-and-forget** (`void`, sin `await`) para no bloquear la respuesta `200` del webhook con la API de Resend (un Resend lento haría que Stripe excediera su timeout y reintentara en bucle).
- [x] Plantilla de confirmación (`src/services/email/templates/orderConfirmation.ts`): resumen de `OrderItem`s (nombre, talla, cantidad, precio — **usar los precios congelados del `OrderItem`, nunca `Product` actual**), `subtotal`/`savings`/`shipping`/`total` de la orden, y datos de envío (`street`, `city`, etc.). **No incluir `unitCost`** (el correo lo ve el cliente). Todos los campos de texto controlados por cliente/producto (nombre, dirección, `nameSnapshot`, paquetería) pasan por un `escapeHtml` local antes de interpolarse en el HTML.
- [x] Como nota a futuro (ver bloque de Skydropx en Fase 8): dejar la plantilla lista para agregar, más adelante, una sección de rastreo si `Order` gana esos campos — no bloquea esta fase, solo evita tener que reescribir la plantilla dos veces.

**Cómo verificar:** con `RESEND_API_KEY` de prueba y **sin** dominio verificado — `POST /api/auth/forgot-password` con tu propio correo (el de la cuenta de Resend) → llega el email con el link; con otro correo distinto no debe tronar el request (el error 403 de Resend se traga y loguea). Confirmar un pedido de prueba vía Stripe test mode → llega el correo de confirmación; reenviar el mismo evento de webhook (Stripe permite reintentar desde el dashboard) → **no** se duplica el correo.

---

## 3. Tabla de contratos (cheatsheet)

Resumen rápido. El tipo de cada respuesta vive en el frontend (columna "Tipo").

| Método | Ruta | Auth | Request → Response | Tipo (front) |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | `{email,password}` → `{token,user}` | `loginSchema` |
| POST | `/api/auth/forgot-password` | — | `{email}` → `{ok}` | `forgotPasswordSchema` |
| POST | `/api/auth/verify-reset-code` | — | `{email,code}` → `{ok}` | `verifyResetCodeSchema` (Fase 9, nuevo) |
| POST | `/api/auth/reset-password` | — | `{email,code,newPassword,confirmPassword}` → `{ok}` | `resetPasswordSchema` (Fase 9, nuevo) |
| GET | `/api/auth/me` | ✅ | → `{user}` | — |
| GET | `/api/products` | — | filtros → `ProductsResult` | `getProducts.ts` ✅ hecho |
| GET | `/api/products/:id` | — | → `Product` (sin costo) | ✅ hecho |
| POST | `/api/orders` | — | snapshot → `{order}` | `CartTotals` + `ShippingData` |
| GET | `/api/admin/products` | ✅ | → `Product[]` (con costo) | `MockProduct` |
| POST/PUT/DELETE | `/api/admin/products/:id?` | ✅ | `productSchema` → `Product` | — |
| POST/DELETE | `/api/admin/products/:id/images` | ✅ | multipart `images` / `{publicId}` → `Product` | — |
| GET | `/api/admin/dashboard` | ✅ | → `DashboardData` | `types.ts` |
| GET | `/api/admin/orders` | ✅ | → `Order[]` | — |
| GET | `/api/admin/reports/monthly` | ✅ | → `MonthlyReport[]` | `types.ts` |
| GET | `/api/admin/reports/replenishment` | ✅ | → `ReplenishmentRow[]` | `types.ts` |
| GET | `/api/admin/brand` | — | → `BrandSettings` | `MarcaData` |
| PUT | `/api/admin/brand` | ✅ | parcial → `BrandSettings` | — |
| POST/DELETE | `/api/admin/brand/logo` | ✅ | multipart `logo` → `BrandSettings` | — |
| GET/POST/DELETE | `/api/admin/users/:id?` | ✅ | → `AdminUser[]` (sin hash) | — |
| PUT | `/api/admin/account` | ✅ | `{currentPassword,newPassword,confirmPassword}` → `{ok}` | — |
| POST | `/api/webhooks/stripe` | 🔑 | evento firmado de Stripe → `{received}` | — |

---

## 4. Modelos Sequelize (referencia breve)

Todos implementados. Detalle completo de campos en [frontend/BACKEND.md](../frontend/BACKEND.md) §3
(ignorar el bloque Prisma — los tipos de dato son orientativos; la traducción real a `Model.init` de
Sequelize, incluidos los `id` como `INTEGER autoIncrement` en vez de `uuid`, ya se hizo con `Product`).

- **`AdminUser`** — `id` (integer autoincrement), `name`, `email` (unique), `passwordHash`, `role` (ENUM `owner|admin`, default `admin`), `createdAt`. **Fase 9** agrega `resetPasswordCodeHash` (nullable), `resetPasswordExpiresAt` (nullable) y `resetPasswordAttempts` (default 0) para el flujo real de `forgot-password`/`reset-password` con código de 5 dígitos — el código nunca se guarda en claro, solo su hash sha256.
- **`Order`** — `id` (integer autoincrement), `status` (ENUM `pending|paid|shipped|delivered|cancelled`), `subtotal`/`savings`/`shipping`/`total` (decimal), datos de cliente (`customerName`, `customerEmail`, `customerPhone`, `street`, `neighborhood`, `city`, `state`, `postalCode`, `references?`), `shippingCarrier?`, `createdAt`. `hasMany(OrderItem)`. **Fase 8** agrega `paymentIntentId` (nullable) y `paymentStatus` (ENUM `unpaid|processing|paid|failed`) para el ciclo real de Stripe.
- **`OrderItem`** — `id` (integer autoincrement), `orderId` (FK), `productId` (FK), `nameSnapshot`, `size` (int), `quantity` (int), y precios **congelados**: `unitOriginalPrice`, `unitSalePrice`, `unitCost`.
- **`BrandSettings`** — singleton (`id=1`): `brandName`, `heroText`, `tagline`, `cartNotice`, `footerNote`, `logoUrl?`, `updatedAt`. **Fase 3** agrega `logoPublicId` (nullable) junto a `logoUrl` para poder destruir el asset anterior en Cloudinary.
- **`ProductSize`** (✅ implementado en Fase 1) — `productId`, `size`, `stock`. Único por `(productId, size)`. Fuente de verdad real del stock por talla.
- **`Product.images`** (✅ implementado en Fase 3) — columna `JSONB` (`[{ url, publicId }]`, hasta 3), la galería de Cloudinary. `imageSrc` sigue siendo un `VIRTUAL` de solo lectura (`images[0]?.url`).

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
- **`RESEND_API_KEY` solo en el servidor** (Fase 9), igual que las demás. El código de `reset-password` (5 dígitos, `crypto.randomInt(0,100000)` — ver la desviación de diseño en Fase 9.2) se manda por correo y **solo su hash sha256** se persiste en `AdminUser` (nunca en claro), con expiración de 15 min, un solo uso y bloqueo tras 5 intentos fallidos (`resetPasswordAttempts`). Un fallo al enviar un email (Resend caído, 403 por dominio no verificado, etc.) **nunca** debe tumbar el request que lo dispara (`forgot-password`, checkout, webhook) — se loguea y se continúa.

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
- [x] `POST /api/auth/login`
- [x] `POST /api/auth/forgot-password`
- [x] `GET /api/auth/me`
- [x] `requireAuth` + `requireRole` + rate-limit

**Fase 3 — Catálogo admin**
- [x] `GET /api/admin/products`
- [x] `POST /api/admin/products`
- [x] `PUT /api/admin/products/:id`
- [x] `DELETE /api/admin/products/:id`
- [x] Imágenes de producto (Cloudinary): `POST`/`DELETE /api/admin/products/:id/images`
- [x] Logo de marca (Cloudinary): `POST`/`DELETE /api/admin/brand/logo`

**Fase 4 — Checkout**
- [x] `POST /api/orders` (recalcular totales, stock por talla, congelar precios)

**Fase 5 — Dashboard**
- [x] `GET /api/admin/dashboard`
- [x] `GET /api/admin/orders`

**Fase 6 — Reportes**
- [x] `GET /api/admin/reports/monthly`
- [x] `GET /api/admin/reports/replenishment`

**Fase 7 — Marca y usuarios**
- [x] `GET/PUT /api/admin/brand`
- [x] `GET/POST/DELETE /api/admin/users`
- [x] `PUT /api/admin/account`

**Fase 8 — Después**
- [x] Skydropx `POST /api/shipping/rates` (cotización, guía automática, webhook — ver [roadmap-skydropx.md](roadmap-skydropx.md))
- [x] Stripe PaymentIntent + webhook (solo test/sandbox; firma verificada + barrido de `pending`)

**Fase 9 — Emails transaccionales (Resend)**
- [x] Cimientos: `src/config/resend.ts`, `src/services/email.service.ts`, plantillas
- [x] `POST /api/auth/forgot-password` real (deja de ser stub) + `POST /api/auth/verify-reset-code` + `POST /api/auth/reset-password` (código de 5 dígitos, ver desviación en Fase 9.2)
- [x] Email de confirmación de pedido al pasar a `paid`
- [ ] Dominio verificado en Resend (manual, fuera del código) antes de enviar a clientes reales

**Pendiente manual (fuera de código)**
- [x] Branch protection en `main` (ver [roadmap-hardening.md](roadmap-hardening.md) Fase H.6): el
  check **`Build & Test`** (`.github/workflows/ci.yml`) es obligatorio antes de mergear a `main`
  (`required_status_checks.strict: true`), con force-push y borrado de la rama bloqueados. Requirió
  hacer el repo **público** — GitHub Free no permite branch protection en repos privados.

**Ya hecho ✅**
- [x] Express + Sequelize + PostgreSQL + `/health`
- [x] Modelo `Product`
- [x] `GET /api/products` (filtros, paginación, oculta costo)
- [x] `GET /api/products/:id`
