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
- **Imágenes:** Cloudinary + multer / multer-storage-cloudinary
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
```

> En `NODE_ENV=development` los modelos se sincronizan automáticamente con
> `sequelize.sync({ alter: true })`.

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
| `POST`   | `/api/auth/forgot-password`   | —    | Solicita recuperación de contraseña (`{ ok: true }`) |
| `GET`    | `/api/auth/me`                | ✅   | Devuelve el usuario autenticado desde el token JWT |
| `GET`    | `/api/admin/products`         | ✅   | Lista **todos** los productos (incl. no visibles y `unitCost`) |
| `POST`   | `/api/admin/products`         | ✅   | Crea un producto (con tallas/stock)                |
| `PUT`    | `/api/admin/products/:id`     | ✅   | Actualiza parcialmente un producto                 |
| `DELETE` | `/api/admin/products/:id`     | ✅   | Elimina un producto (soft-delete si tiene pedidos) |
| `POST`   | `/api/orders`                 | —    | Checkout: crea un pedido desde el carrito          |
| `POST`   | `/api/webhooks/stripe`        | —    | Webhook de pagos (stub, listo para Stripe en Fase 8) |

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
`ProductSize`. `salePrice` no puede superar a `originalPrice`. El `DELETE` hace **soft-delete**
(`deletedAt` + `visible: false`) si el producto está referenciado por algún pedido, o
**hard-delete** (con sus `ProductSize` por CASCADE) si no lo está — la respuesta indica
`{ ok, softDeleted }`.

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

La orden nace en `status: "pending"` / `paymentStatus: "unpaid"`. Respuesta `201`:
`{ order, clientSecret }` (`clientSecret` es `null` hasta activar Stripe en Fase 8). Errores:
`400` (body/cliente inválido), `409` (sin stock o producto no disponible, con el ítem en el mensaje).

### Pagos (seam de Stripe, Fase 8)

El cobro real con Stripe está **cableado pero inerte**: `src/services/payment.service.ts` define
`createPaymentIntentForOrder` (hoy devuelve `null`) y `markOrderPaidFromWebhook`, y
`POST /api/webhooks/stripe` es un stub que marca la orden como `paid` por `paymentIntentId`. Al
activar Stripe se rellenan esas funciones, se verifica la firma del webhook sobre el cuerpo crudo
(`express.raw`) y se libera el stock de órdenes `pending` abandonadas. El paquete `stripe` aún no
se instala.

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
│   └── swagger.ts               # Spec OpenAPI base (swagger-jsdoc) servida en /api/docs
├── controllers/
│   ├── product.controller.ts    # Lógica de productos (listar, obtener por id)
│   ├── auth.controller.ts       # Login, forgot-password, me
│   └── order.controller.ts      # Checkout (POST /api/orders) + webhook de pagos
├── middlewares/
│   ├── AppError.ts               # Clase de error con status code para respuestas controladas
│   ├── asyncHandler.ts            # Wrapper para controllers async (evita try/catch repetido)
│   ├── errorHandler.ts            # Middleware centralizado de manejo de errores
│   ├── rateLimit.ts               # authRateLimiter: 10 req / 15 min en rutas de auth
│   └── requireAuth.ts             # Verifica JWT Bearer, adjunta req.user; requireRole helper
├── routes/
│   ├── product.routes.ts        # Rutas /api/products
│   ├── adminProduct.routes.ts   # Rutas /api/admin/products (CRUD admin, requireAuth)
│   ├── auth.routes.ts           # Rutas /api/auth
│   ├── order.routes.ts          # Ruta /api/orders (checkout público)
│   └── webhook.routes.ts        # Ruta /api/webhooks/stripe (stub de pagos)
├── schemas/
│   ├── auth.ts                   # Esquema zod de login
│   ├── checkout.ts                # Esquema zod de envío/checkout
│   └── product.ts                 # Esquema zod de producto
├── services/
│   ├── cart.ts                    # computeTotals, computeShipping, SHIPPING_BY_TYPE
│   ├── orders.service.ts          # Checkout: stock atómico, totales, precios congelados
│   ├── payment.service.ts         # Seam de Stripe (inerte hasta Fase 8)
│   └── forecast.ts                # Función pura portada del frontend
├── utils/
│   └── password.ts                # Helpers de hash/verificación de contraseñas (bcrypt)
└── models/
    ├── Product.ts                # Modelo Product (bota | sombrero | ropa)
    ├── ProductSize.ts            # Stock por talla (productId, size, stock), único por (productId, size)
    ├── AdminUser.ts              # Usuarios del panel (id, name, email, passwordHash, role)
    ├── Order.ts                  # Pedidos (totales + datos de envío)
    ├── OrderItem.ts              # Renglones de pedido con precios congelados
    ├── BrandSettings.ts          # Configuración de marca (singleton)
    └── associations.ts           # Relaciones entre modelos (hasMany/belongsTo)
```
