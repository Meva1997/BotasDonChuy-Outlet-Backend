# BotasDonChuy-Outlet-Backend

API backend para la tienda **Botas Don Chuy Outlet** (botas, sombreros y ropa).
Construido con Express 5, TypeScript y Sequelize sobre PostgreSQL.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Sequelize 6 (PostgreSQL)
- **Seguridad:** Helmet, CORS, express-rate-limit, bcrypt, JSON Web Tokens
- **Validación:** Zod
- **Documentación API:** Swagger UI (OpenAPI 3.0) vía swagger-jsdoc + swagger-ui-express
- **Imágenes:** Cloudinary + multer (subida en memoria → `upload_stream`)
- **Gestor de paquetes:** pnpm

## Requisitos

- Node.js 18+
- [pnpm](https://pnpm.io/) (`packageManager: pnpm@11.8.0`)
- Una base de datos PostgreSQL

## Instalación

```bash
pnpm install
```

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto (no se versiona):

```env
PORT=4000
NODE_ENV=development
DATABASE_URL=postgres://usuario:password@host:5432/basededatos
CORS_ORIGIN=http://localhost:3000

# Auth
JWT_SECRET=un_secreto_largo_y_seguro
JWT_EXPIRES_IN=7d

# Cloudinary
CLOUDINARY_CLOUD_NAME=tu_cloud_name
CLOUDINARY_API_KEY=tu_api_key
CLOUDINARY_API_SECRET=tu_api_secret

# Stripe (test/sandbox) — ambas son OBLIGATORIAS: el server no arranca sin ellas
STRIPE_SECRET_KEY=sk_test_...           # o una restricted key rk_test_... con permiso de PaymentIntents
STRIPE_WEBHOOK_SECRET=whsec_...         # de `stripe listen` (local) o del endpoint del dashboard
STRIPE_CURRENCY=mxn                      # opcional (default mxn)
PENDING_ORDER_TTL_MINUTES=30            # opcional: antigüedad para reciclar órdenes pending
PENDING_ORDER_SWEEP_INTERVAL_MINUTES=10 # opcional: cada cuánto corre el barrido

# Resend (emails transaccionales) — ambas OBLIGATORIAS: el server no arranca sin ellas
RESEND_API_KEY=re_...                    # del dashboard de Resend
EMAIL_FROM=Botas Don Chuy <onboarding@resend.dev>  # sin dominio verificado, usar onboarding@resend.dev
FRONTEND_URL=http://localhost:3000       # opcional: base para links dentro de los correos
```

> En `NODE_ENV=development` los modelos se sincronizan automáticamente con
> `sequelize.sync({ alter: true })`.

> **Stripe (solo test/sandbox por ahora).** El PaymentIntent y el webhook son reales, con
> llaves de test. Para obtener el `STRIPE_WEBHOOK_SECRET` en local y probar los eventos, ver
> [Probar Stripe en local](#probar-stripe-en-local).

## Scripts

| Comando      | Descripción                                          |
| ------------ | ---------------------------------------------------- |
| `pnpm dev`   | Servidor en desarrollo con recarga (`ts-node-dev`)   |
| `pnpm build` | Compila TypeScript a `dist/` (`tsc`)                 |
| `pnpm start` | Ejecuta la build de producción (`node dist/app.js`)  |
| `pnpm seed`  | Llena la base de datos con productos, histórico de ventas, usuario admin semilla y configuración de marca (`src/seed.ts`) |

## Endpoints

| Método   | Ruta                          | Auth | Descripción                                        |
| -------- | ----------------------------- | ---- | -------------------------------------------------- |
| `GET`    | `/health`                     | —    | Healthcheck (status + timestamp)                   |
| `GET`    | `/api/products`               | —    | Lista productos visibles (paginados y filtrables)  |
| `GET`    | `/api/products/:id`           | —    | Devuelve un producto visible por `id`              |
| `POST`   | `/api/auth/login`             | —    | Login con email/password; devuelve JWT y usuario   |
| `POST`   | `/api/auth/forgot-password`   | —    | Envía un código de 5 dígitos por correo (`{ ok: true }` siempre) |
| `POST`   | `/api/auth/verify-reset-code` | —    | Verifica el código de recuperación (desbloquea el reset en el front) |
| `POST`   | `/api/auth/reset-password`    | —    | Restablece la contraseña con el código (un solo uso) |
| `GET`    | `/api/auth/me`                | ✅   | Devuelve el usuario autenticado desde el token JWT |
| `GET`    | `/api/admin/products`         | ✅   | Lista **todos** los productos (incl. no visibles y `unitCost`) |
| `POST`   | `/api/admin/products`         | ✅   | Crea un producto (con tallas/stock)                |
| `PUT`    | `/api/admin/products/:id`     | ✅   | Actualiza parcialmente un producto                 |
| `DELETE` | `/api/admin/products/:id`     | ✅   | Elimina un producto (soft-delete si tiene pedidos) |
| `POST`   | `/api/admin/products/:id/images` | ✅ | Sube de 1 a 3 imágenes del producto a Cloudinary |
| `DELETE` | `/api/admin/products/:id/images` | ✅ | Borra una imagen del producto (por `publicId`) de Cloudinary |
| `POST`   | `/api/orders`                 | —    | Checkout: crea un pedido desde el carrito          |
| `GET`    | `/api/admin/dashboard`        | ✅   | Métricas agregadas del panel (KPIs, ingresos, ventas recientes, inventario) |
| `GET`    | `/api/admin/orders`           | ✅   | Lista paginada de pedidos con sus items (incl. `unitCost`) |
| `GET`    | `/api/admin/reports/monthly`  | ✅   | Ventas por mes por producto (`MonthlyReport[]`; mes en curso con `partial`) |
| `GET`    | `/api/admin/reports/replenishment` | ✅ | Reposición sugerida (`ReplenishmentRow[]`; pronóstico + cobertura + margen) |
| `GET`    | `/api/admin/brand`            | —    | Identidad de marca (lectura pública, crea el singleton con defaults si falta) |
| `PUT`    | `/api/admin/brand`            | ✅   | Actualiza parcialmente la identidad de marca (textos, no el logo) |
| `POST`   | `/api/admin/brand/logo`       | ✅   | Sube el logo de la tienda a Cloudinary (reemplaza el anterior) |
| `DELETE` | `/api/admin/brand/logo`       | ✅   | Quita el logo de la tienda (y lo borra de Cloudinary) |
| `GET`    | `/api/admin/users`            | ✅   | Lista los usuarios del panel (sin `passwordHash`) |
| `POST`   | `/api/admin/users`            | ✅   | Crea un usuario del panel con contraseña temporal |
| `DELETE` | `/api/admin/users/:id`        | ✅   | Elimina un usuario (bloquea autoeliminación y al último `owner`) |
| `PUT`    | `/api/admin/account`          | ✅   | Actualiza el correo y/o la contraseña de la cuenta propia |
| `POST`   | `/api/webhooks/stripe`        | 🔑   | Webhook de Stripe (firma verificada; lo invoca Stripe, no de uso manual) |

### `GET /api/products`

Solo expone productos con `visible: true` y oculta el campo `unitCost`.

| Query param | Tipo   | Default | Descripción                                  |
| ----------- | ------ | ------- | -------------------------------------------- |
| `categoria` | string | —       | Filtra por `type` (`bota`, `sombrero`, `ropa`) |
| `talla`     | number | —       | Filtra productos que incluyan esa talla      |
| `page`      | number | `1`     | Página (se ajusta al rango `[1, totalPages]`) |
| `perPage`   | number | `9`     | Elementos por página                         |

Respuesta: `{ products, total, page, perPage, totalPages, availableSizes }`. `Product.sizes`
(repetido por talla) y `Product.stock` (total) son campos `VIRTUAL` derivados de la tabla
`ProductSize` cuando se incluye esa asociación.

### `/api/admin/products` (CRUD admin, requiere JWT)

Todas las rutas están protegidas con `requireAuth`. A diferencia de `/api/products`, exponen
también los productos no visibles y el campo `unitCost`. El body de `POST`/`PUT` se valida con
zod (`productSchema` / `productUpdateSchema`): `sizes` acepta un string `"25,25,26"` o un array
de números (cada repetición = una unidad de stock para esa talla) y se materializa en filas de
`ProductSize`. `salePrice` no puede superar a `originalPrice`. **Las imágenes no se setean por
`POST`/`PUT`**: se gestionan por los endpoints dedicados de imágenes (ver más abajo). El `DELETE`
hace **soft-delete** (`deletedAt` + `visible: false`) si el producto está referenciado por algún
pedido — sus imágenes permanecen en Cloudinary para conservar el histórico —, o **hard-delete**
(con sus `ProductSize` por CASCADE y borrando sus imágenes de Cloudinary) si no lo está — la
respuesta indica `{ ok, softDeleted }`.

### `POST /api/orders` (checkout público)

Convierte el carrito del cliente en un pedido persistido. Body:
`{ items: [{ productId, size, quantity }], customer, shippingCarrier? }`, validado con
`createOrderSchema` (zod). El backend es la **autoridad de precios y stock**:

- **Recalcula los totales** (`subtotal`, `savings`, `shipping`, `total`) en el servidor con el
  service `cart` — el cliente nunca envía montos.
- **Verifica y descuenta el stock por talla de forma atómica** dentro de una transacción, con un
  `UPDATE ... SET stock = stock - N WHERE stock >= N`. Si dos clientes compran la última unidad
  casi al mismo tiempo, solo uno recibe `201`; el otro recibe `409` y esa talla queda en stock 0.
  Cualquier fallo a media transacción revierte todo (sin descuentos parciales).
- **Congela los precios** (`unitOriginalPrice`, `unitSalePrice`, `unitCost`) y el nombre en cada
  `OrderItem`, para que el histórico no cambie si el producto se reprecia. El `unitCost` (costo
  interno) se guarda congelado pero **se excluye de la respuesta pública** — solo lo ven las rutas
  admin autenticadas.
- Renglones duplicados del mismo `(productId, size)` se agregan; el descuento se hace en orden
  determinista por `(productId, size)` para evitar deadlocks entre checkouts concurrentes.
- **Topes anti-abuso** (zod): máximo `99` unidades por artículo y `50` artículos por pedido (`400`
  si se exceden). El límite **real** de existencias por talla lo impone el descuento atómico: pedir
  más unidades de las que hay en esa talla (o una talla inexistente) devuelve `409`.

La orden nace en `status: "pending"` / `paymentStatus: "unpaid"`, se le crea un **PaymentIntent real
de Stripe** y se guarda su `paymentIntentId` (`paymentStatus: "processing"`). Respuesta `201`:
`{ order, clientSecret }` — el `clientSecret` sirve para que el cliente confirme el pago. Errores:
`400` (body/cliente inválido), `409` (sin stock o producto no disponible, con el ítem en el mensaje).

### `GET /api/admin/dashboard` y `GET /api/admin/orders` (panel admin)

`GET /api/admin/dashboard` calcula todo en memoria a partir de `Order`/`OrderItem`/`Product`
(sin tablas de agregación): solo cuentan las órdenes con `status: "paid"`.

- `kpisByPeriod` / `profitKpisByPeriod`: igual patrón que `revenueByPeriod` — las tres ventanas
  `"7" | "30" | "90"` juntas, cada una comparada contra su propio periodo anterior (p. ej. "30"
  compara `hoy-29d..hoy` vs los 30 días previos) para el `trend`. El frontend alterna en cliente
  (`DataSection`), sin query params. Valores monetarios formateados en `es-MX` (`"$13,531.00"`).
  `GASTOS FIJOS` es una constante mensual hardcodeada (`$2,000.00`, no existe un modelo de gastos)
  prorrateada a la ventana seleccionada (`$2,000 × ventana/30`).
- `revenueByPeriod`: las tres series `"7" | "30" | "90"` juntas, un punto por día (incluye días en
  `$0`, no se omiten). El agrupamiento y el formateo de fechas son **ambos en UTC** (`timeZone:
  "UTC"` explícito), para que el resultado no dependa de la zona horaria del host donde corre el
  servidor.
- `recentSales`: últimas 20 órdenes pagadas.
- `inventory`: todos los productos no borrados (incluye `visible: false`); `valorInventario = stock
  × unitCost`.

`GET /api/admin/orders` devuelve una página de órdenes (`page`/`perPage`, `perPage` por defecto
`20`) con sus `items`, más recientes primero, sin excluir `unitCost` (a diferencia de las rutas
públicas). Responde con `{ orders, total, page, perPage, totalPages }`.

### `GET /api/admin/reports/monthly` y `/replenishment` (reportes)

Ambos se calculan **en memoria** (sin tablas de agregación) desde una sola carga compartida de
órdenes `status: "paid"` (con `items`) + productos no borrados (con `productSizes`). El backend sirve
solo las filas crudas; las métricas derivadas (% del total, promedios, tendencia vs mes anterior) las
calcula el frontend.

- `GET /api/admin/reports/monthly` → `MonthlyReport[]`: agrupa unidades por `(mes UTC, productId)` y,
  para **cada** mes del rango `[mes de la orden más antigua … mes en curso]` (inclusive, sin huecos —
  los meses sin ventas salen en `$0`), arma `byProduct` sobre **todos** los productos
  (`revenue = unitsSold × salePrice`, precio **actual**; ordenado desc por `unitsSold`) y `byCategory`
  (agrupado por `type`, ordenado desc por ingreso). El mes en curso sale con `partial: true`. Las
  claves/etiquetas de mes están fijadas a **UTC** (`"2026-01"` / `"Enero 2026"`).
- `GET /api/admin/reports/replenishment` → `ReplenishmentRow[]`: se computa on-the-fly. Por producto,
  toma la serie mensual de `unitsSold` de los meses **completos** (excluye el mes `partial`) y la pasa
  a `computeForecast` (`src/services/forecast.ts`); calcula `diasCobertura` (`999` = sin ventas),
  `suggestedOrder = max(0, round(forecast × 2) − stock)`, `ingresoMensual`, `margenMensual`,
  `costoEstimadoPedido` y `priority` (`urgente` <15 días · `pronto` <45 · `ok`). Las filas se ordenan
  por urgencia de cobertura y, dentro de cada nivel, por `margenMensual` desc.

### Pagos con Stripe (Fase 8 — solo test/sandbox)

El cobro con Stripe está **activo** (solo Stripe; Skydropx sigue diferido). `src/config/stripe.ts`
exige `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (el server no arranca sin ellas).

- **PaymentIntent real:** `createPaymentIntentForOrder` (`src/services/payment.service.ts`) crea el
  PaymentIntent con el `total` en centavos y `metadata.orderId`; `POST /api/orders` guarda el
  `paymentIntentId` y devuelve el `clientSecret`.
- **Webhook firmado:** `POST /api/webhooks/stripe` se monta con `express.raw` (antes del
  `express.json()` global) y verifica la firma `Stripe-Signature` con `constructEvent`. Firma
  inválida → `400`; evento verificado → `200`. Maneja `payment_intent.succeeded` → `paid`,
  `payment_intent.payment_failed` → `failed` (sigue `pending`, permite reintento) y
  `payment_intent.canceled` → restock + `cancelled`.
- **Restock idempotente:** `orders.service.releaseOrderStock` revierte el descuento de stock (con
  lock de la fila de la orden, solo mientras esté `pending`).
- **Barrido:** `src/services/pendingOrderSweeper.ts` corre cada `PENDING_ORDER_SWEEP_INTERVAL_MINUTES`,
  reconcilia las órdenes `pending` viejas contra Stripe y libera su stock (o las marca `paid` si el
  PaymentIntent ya se pagó y se perdió el webhook).
- **Correo de confirmación (Fase 9.3):** al pasar a `paid`, `markOrderPaidFromWebhook` dispara el
  correo de confirmación (Resend) con el resumen del pedido. La transición a `paid` es un **UPDATE
  atómico condicional** (`WHERE paymentStatus != 'paid'`): garantiza que el correo se envíe **una sola
  vez** aunque el webhook y el barrido lleguen a la vez (con un `idempotencyKey` de Resend como segundo
  respaldo). El envío es **fire-and-forget** (no bloquea la respuesta `200` del webhook) y nunca tumba
  el evento si Resend falla.

#### Probar Stripe en local

El webhook verifica la firma `Stripe-Signature` contra `STRIPE_WEBHOOK_SECRET`. En local ese
secreto lo genera la **Stripe CLI**, que además hace de túnel: recibe los eventos de Stripe y los
reenvía a tu `localhost`.

1. **Instala la Stripe CLI** (una sola vez):

   ```bash
   brew install stripe/stripe-cli/stripe   # macOS (Homebrew)
   ```

2. **Levanta dos terminales** — el backend y el túnel de webhooks:

   ```bash
   # Terminal 1 — backend
   pnpm dev

   # Terminal 2 — túnel de webhooks (reenvía eventos a la ruta local)
   stripe listen --forward-to localhost:4000/api/webhooks/stripe
   ```

   > Si tu `STRIPE_SECRET_KEY` es una **restricted key** (`rk_test_…`), añade
   > `--api-key rk_test_…` (necesita el permiso *Debugging Tools · Write*). Con `stripe login`
   > (sesión completa) no hace falta el flag.

3. **Copia el `whsec_…`** que imprime `stripe listen` al arrancar y pégalo en `.env` como
   `STRIPE_WEBHOOK_SECRET`. Es **estable** para la cuenta (no rota al reiniciar `stripe listen`),
   así que solo se pega una vez.

4. **Dispara eventos de prueba** sin cobrar de verdad:

   ```bash
   stripe trigger payment_intent.succeeded        # → la orden pasa a "paid"
   stripe trigger payment_intent.payment_failed   # → paymentStatus "failed" (sigue pending)
   stripe trigger payment_intent.canceled         # → restock + "cancelled"
   ```

   Desde el frontend, la tarjeta de prueba es `4242 4242 4242 4242` (cualquier fecha futura y CVC).

> ⚠️ **Deja `stripe listen` corriendo en paralelo a `pnpm dev` durante todo el desarrollo.**
> Sin el túnel, un pago se cobra en Stripe (test) pero la orden se queda en
> `paymentStatus: "processing"` / `status: "pending"` porque el evento
> `payment_intent.succeeded` nunca llega al webhook local. No es un bug: es el síntoma de
> que falta el túnel. La orden **no se pierde** — el barrido (`pendingOrderSweeper.ts`) la
> reconcilia contra Stripe y la marca `paid` en su siguiente pasada, pero recién tras el TTL:
> corre cada `PENDING_ORDER_SWEEP_INTERVAL_MINUTES` (10 por defecto) sobre órdenes con más de
> `PENDING_ORDER_TTL_MINUTES` (30) de antigüedad, así que la recuperación automática tarda
> ~30–40 min y exige que el backend siga levantado. Con `stripe listen` activo, en cambio, la
> orden pasa a `paid` en segundos.

### `/api/admin/brand`, `/api/admin/users` y `/api/admin/account` (marca y usuarios)

- `GET /api/admin/brand` es **pública** (la tienda pinta estos textos); usa `findOrCreate` sobre el
  singleton `id: 1` para no depender de que `pnpm seed` ya haya corrido. `PUT /api/admin/brand`
  (requiere JWT) acepta updates parciales — cada campo se guarda por separado, como hace
  `MarcaSection` en el frontend.
- `GET /api/admin/users` (requiere JWT, cualquier rol) lista los usuarios del panel sin
  `passwordHash`. `POST /api/admin/users` (requiere JWT, cualquier rol — `owner` y `admin` tienen
  los mismos permisos) crea un usuario con contraseña temporal hasheada. `DELETE
  /api/admin/users/:id` bloquea con `400` la autoeliminación y la eliminación del único `owner`
  restante (evita quedarse sin acceso al panel).
- `PUT /api/admin/account` (requiere JWT) actualiza la cuenta propia del usuario autenticado:
  siempre verifica `currentPassword` (defensa en profundidad ante un JWT filtrado) y acepta `email`
  y/o `newPassword`/`confirmPassword` de forma independiente, para las dos acciones separadas de
  `ConfigSection` ("Actualizar Correo" / "Cambiar Contraseña"). No reemite el JWT tras un cambio de
  correo — el token vigente sigue mostrando el correo anterior hasta el siguiente login.

### Imágenes con Cloudinary (Fase 3)

Las imágenes de producto y el logo de marca viven en **Cloudinary**. `src/config/cloudinary.ts`
exige `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` (como `stripe.ts`,
carga su propio `.env` y el server **no arranca** sin ellas). Las subidas se reciben por
`multipart/form-data` con **multer en memoria** (sin tocar disco, máx **5 MB**, solo
PNG/JPEG/WEBP) y se suben con `upload_stream` (`src/services/image.service.ts`) — no se usa
`multer-storage-cloudinary` porque su versión peer-depende de multer/cloudinary 1.x.

- **Producto:** `POST /api/admin/products/:id/images` sube de 1 a 3 imágenes (campo `images`),
  respetando un tope de **3 en total** revalidado bajo lock de fila (`SELECT … FOR UPDATE`) contra
  adds concurrentes. `DELETE /api/admin/products/:id/images` borra una imagen por su `publicId`
  (en el body). La galería se guarda en la columna `Product.images` (`JSONB`, `[{ url, publicId }]`);
  `imageSrc` es un `VIRTUAL` de solo lectura que devuelve la URL de la **primera** imagen. Las rutas
  **públicas** ocultan el `publicId` de cada imagen (identificador interno de Cloudinary) — el
  storefront solo consume `url`/`imageSrc`.
- **Marca:** `POST /api/admin/brand/logo` sube el logo (campo `logo`) y **destruye el anterior**;
  `DELETE /api/admin/brand/logo` lo quita. `BrandSettings` guarda `logoUrl` + `logoPublicId`.
- **Consistencia BD ↔ Cloudinary:** las subidas de producto son **todo o nada** (si una de varias
  falla, se destruyen las que sí subieron); los borrados se **persisten en la BD antes** de destruir
  el asset (un fallo del `destroy` deja un huérfano en Cloudinary, nunca una referencia colgante que
  rompería la imagen en la tienda). Los errores de multer (tamaño/formato/campo inesperado) se mapean
  a `400` en el `errorHandler`.

## Documentación API (Swagger)

Con el servidor en marcha, la documentación interactiva está disponible en:

- **Swagger UI:** [`http://localhost:4000/api/docs`](http://localhost:4000/api/docs) — explora y
  prueba los endpoints desde el navegador.
- **OpenAPI JSON:** [`http://localhost:4000/api/docs.json`](http://localhost:4000/api/docs.json) —
  especificación cruda (útil para importar en Postman/Insomnia o validar).

Para probar rutas protegidas: haz `POST /api/auth/login`, copia el `token`, pulsa **Authorize**
(esquema `bearerAuth`) en la UI y pega el token; luego llama a `GET /api/auth/me`.

La especificación base vive en `src/config/swagger.ts` y cada endpoint se documenta con
anotaciones JSDoc `@openapi` sobre su router en `src/routes/*.ts`.

## Estructura

```
src/
├── app.ts                       # Punto de entrada: Express, middleware y arranque
├── seed.ts                      # Script de seed (productos, histórico, admin, marca)
├── config/
│   ├── database.ts              # Conexión Sequelize a PostgreSQL
│   ├── stripe.ts                # Cliente Stripe + llaves exigidas (test/sandbox)
│   ├── cloudinary.ts            # Cliente Cloudinary + llaves exigidas (fail-fast al arrancar)
│   ├── resend.ts                # Cliente Resend + RESEND_API_KEY/EMAIL_FROM exigidos (fail-fast)
│   └── swagger.ts               # Spec OpenAPI base (swagger-jsdoc) servida en /api/docs
├── controllers/
│   ├── product.controller.ts    # Lógica de productos (listar, obtener por id)
│   ├── auth.controller.ts       # Login, forgot-password, me
│   ├── order.controller.ts      # Checkout (POST /api/orders) + admin orders + webhook de pagos
│   ├── dashboard.controller.ts  # GET /api/admin/dashboard
│   ├── reports.controller.ts    # GET /api/admin/reports/monthly y /replenishment
│   ├── brand.controller.ts      # GET/PUT /api/admin/brand
│   └── adminUser.controller.ts  # /api/admin/users + PUT /api/admin/account
├── middlewares/
│   ├── AppError.ts               # Clase de error con status code para respuestas controladas
│   ├── asyncHandler.ts            # Wrapper para controllers async (evita try/catch repetido)
│   ├── errorHandler.ts            # Middleware centralizado de manejo de errores
│   ├── rateLimit.ts               # authRateLimiter: 10 req / 15 min en rutas de auth
│   ├── requireAuth.ts             # Verifica JWT Bearer, adjunta req.user; requireRole helper
│   └── upload.ts                  # multer en memoria (uploadProductImages / uploadLogo)
├── routes/
│   ├── product.routes.ts        # Rutas /api/products
│   ├── adminProduct.routes.ts   # Rutas /api/admin/products (CRUD admin, requireAuth)
│   ├── auth.routes.ts           # Rutas /api/auth
│   ├── order.routes.ts          # Ruta /api/orders (checkout público)
│   ├── adminOrder.routes.ts     # Ruta /api/admin/orders (requireAuth)
│   ├── adminDashboard.routes.ts # Ruta /api/admin/dashboard (requireAuth)
│   ├── adminReports.routes.ts   # Rutas /api/admin/reports/* (requireAuth)
│   ├── brand.routes.ts          # Ruta /api/admin/brand (GET pública, PUT requireAuth)
│   ├── adminUser.routes.ts      # Rutas /api/admin/users (requireAuth)
│   ├── account.routes.ts        # Ruta /api/admin/account (requireAuth)
│   └── webhook.routes.ts        # Ruta /api/webhooks/stripe (webhook de Stripe, firma verificada)
├── schemas/
│   ├── auth.ts                   # Esquema zod de login
│   ├── checkout.ts                # Esquema zod de envío/checkout
│   ├── product.ts                 # Esquema zod de producto
│   ├── brand.ts                   # Esquema zod de update parcial de BrandSettings
│   └── adminUser.ts               # Esquemas zod de alta de usuario y update de cuenta propia
├── services/
│   ├── cart.ts                    # computeTotals, computeShipping, SHIPPING_BY_TYPE
│   ├── orders.service.ts          # Checkout: stock atómico, totales, precios congelados; releaseOrderStock (restock)
│   ├── payment.service.ts         # Stripe: crea PaymentIntent, concilia pagos/fallos del webhook; manda el correo de confirmación al pasar a paid
│   ├── pendingOrderSweeper.ts     # Barrido de órdenes pending abandonadas (libera stock, reconcilia con Stripe)
│   ├── image.service.ts           # Cloudinary: sube buffer (upload_stream) y borra asset (destroy)
│   ├── email.service.ts           # sendEmail(...) sobre Resend; loguea pero nunca lanza
│   ├── email/templates/           # Plantillas HTML como funciones (passwordResetCode.ts, orderConfirmation.ts)
│   ├── dashboard.service.ts       # Agregación en memoria para GET /api/admin/dashboard
│   ├── reports.service.ts         # Reportes mensuales + reposición (usa forecast.ts)
│   └── forecast.ts                # Función pura portada del frontend
├── utils/
│   ├── password.ts                # Helpers de hash/verificación de contraseñas (bcrypt)
│   ├── date.ts                    # Helpers de fecha UTC (isoDay/isoMonth/formatShortDate/...)
│   ├── productSizesInclude.ts     # Include reusado para resolver los VIRTUAL stock/sizes de Product
│   └── resetCode.ts               # Genera/hashea el código de recuperación de 5 dígitos
└── models/
    ├── Product.ts                # Modelo Product (bota | sombrero | ropa)
    ├── ProductSize.ts            # Stock por talla (productId, size, stock), único por (productId, size)
    ├── AdminUser.ts              # Usuarios del panel (id, name, email, passwordHash, role)
    ├── Order.ts                  # Pedidos (totales + datos de envío)
    ├── OrderItem.ts              # Renglones de pedido con precios congelados
    ├── BrandSettings.ts          # Configuración de marca (singleton)
    └── associations.ts           # Relaciones entre modelos (hasMany/belongsTo)
```
