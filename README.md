# BotasDonChuy-Outlet-Backend

API backend para la tienda **Botas Don Chuy Outlet** (botas, sombreros y ropa).
Construido con Express 5, TypeScript y Sequelize sobre PostgreSQL.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Sequelize 6 (PostgreSQL)
- **Seguridad:** Helmet, CORS, express-rate-limit, bcrypt, JSON Web Tokens
- **Validación:** Zod
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

## Endpoints

| Método | Ruta                 | Descripción                                        |
| ------ | -------------------- | -------------------------------------------------- |
| `GET`  | `/health`            | Healthcheck (status + timestamp)                   |
| `GET`  | `/api/products`      | Lista productos visibles (paginados y filtrables)  |
| `GET`  | `/api/products/:id`  | Devuelve un producto visible por `id`              |

### `GET /api/products`

Solo expone productos con `visible: true` y oculta el campo `unitCost`.

| Query param | Tipo   | Default | Descripción                                  |
| ----------- | ------ | ------- | -------------------------------------------- |
| `categoria` | string | —       | Filtra por `type` (`bota`, `sombrero`, `ropa`) |
| `talla`     | number | —       | Filtra productos que incluyan esa talla      |
| `page`      | number | `1`     | Página (se ajusta al rango `[1, totalPages]`) |
| `perPage`   | number | `9`     | Elementos por página                         |

Respuesta: `{ products, total, page, perPage, totalPages, availableSizes }`.

## Estructura

```
src/
├── app.ts                       # Punto de entrada: Express, middleware y arranque
├── config/
│   └── database.ts              # Conexión Sequelize a PostgreSQL
├── controllers/
│   └── product.controller.ts    # Lógica de productos (listar, obtener por id)
├── middlewares/
│   ├── AppError.ts               # Clase de error con status code para respuestas controladas
│   ├── asyncHandler.ts            # Wrapper para controllers async (evita try/catch repetido)
│   ├── errorHandler.ts            # Middleware centralizado de manejo de errores
│   └── requireAuth.ts             # Placeholder de auth (JWT real llega en Fase 2)
├── routes/
│   └── product.routes.ts        # Rutas /api/products
├── schemas/
│   ├── auth.ts                   # Esquema zod de login
│   ├── checkout.ts                # Esquema zod de envío/checkout
│   └── product.ts                 # Esquema zod de producto
├── services/
│   ├── cart.ts                    # computeTotals, computeShipping, SHIPPING_BY_TYPE
│   └── forecast.ts                # Función pura portada del frontend
└── models/
    └── Product.ts               # Modelo Product (bota | sombrero | ropa)
```
