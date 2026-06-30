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
│   └── auth.controller.ts       # Login, forgot-password, me
├── middlewares/
│   ├── AppError.ts               # Clase de error con status code para respuestas controladas
│   ├── asyncHandler.ts            # Wrapper para controllers async (evita try/catch repetido)
│   ├── errorHandler.ts            # Middleware centralizado de manejo de errores
│   ├── rateLimit.ts               # authRateLimiter: 10 req / 15 min en rutas de auth
│   └── requireAuth.ts             # Verifica JWT Bearer, adjunta req.user; requireRole helper
├── routes/
│   ├── product.routes.ts        # Rutas /api/products
│   ├── adminProduct.routes.ts   # Rutas /api/admin/products (CRUD admin, requireAuth)
│   └── auth.routes.ts           # Rutas /api/auth
├── schemas/
│   ├── auth.ts                   # Esquema zod de login
│   ├── checkout.ts                # Esquema zod de envío/checkout
│   └── product.ts                 # Esquema zod de producto
├── services/
│   ├── cart.ts                    # computeTotals, computeShipping, SHIPPING_BY_TYPE
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
