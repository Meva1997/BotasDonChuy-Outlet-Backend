# BotasDonChuy-Outlet-Backend

API backend para la tienda **Botas Don Chuy Outlet** (botas, sombreros y ropa).
Construido con Express 5, TypeScript y Sequelize sobre PostgreSQL.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Sequelize 6 (PostgreSQL), migraciones versionadas con `sequelize-cli`
- **Seguridad:** Helmet, CORS, express-rate-limit, bcrypt, JSON Web Tokens
- **Validación:** Zod
- **Documentación API:** Swagger UI (OpenAPI 3.0) vía swagger-jsdoc + swagger-ui-express
- **Imágenes:** Cloudinary + multer (subida en memoria → `upload_stream`)
- **Hojas de cálculo:** exceljs (importación/restock masivo de productos desde `.xlsx`)
- **Pagos:** Stripe (PaymentIntents + webhook firmado, test/sandbox)
- **Envíos:** Skydropx Pro (cotización en vivo, guía automática, webhook de estado)
- **Emails transaccionales:** Resend
- **Logging y monitoreo:** pino (+ pino-pretty en dev) y Sentry (`@sentry/node`, opcional)
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
CORS_ORIGIN=http://localhost:3000,https://tu-dominio.com

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

# Skydropx (cotización en vivo + guía automática) — client id/secret, webhook secret y los 8 SHIP_FROM_* son OBLIGATORIOS
SKYDROPX_CLIENT_ID=...
SKYDROPX_CLIENT_SECRET=...
SKYDROPX_WEBHOOK_SECRET=...             # secreto HMAC del webhook de estado de envío (Fase 8.6); el server no arranca sin él
SKYDROPX_BASE_URL=https://sb-pro.skydropx.com   # opcional (default: sandbox; producción es pro.skydropx.com)
SKYDROPX_CARRIERS=dhl,paquetexpress    # opcional: slugs provider_name separados por coma, restringe qué paqueterías cotizar
SHIPMENT_RETRY_DELAY_MINUTES=15         # opcional: espera antes de reintentar una guía (y antigüedad de un centinela huérfano)
SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES=10 # opcional: cada cuánto corre el barrido de guías pendientes
SHIP_FROM_POSTAL_CODE=38000
SHIP_FROM_STATE=Guanajuato
SHIP_FROM_CITY=Celaya
SHIP_FROM_NEIGHBORHOOD=Centro
SHIP_FROM_STREET=...          # dirección de origen de la guía (Fase 8.5)
SHIP_FROM_EXTERNAL_NUMBER=...
SHIP_FROM_NAME=...
SHIP_FROM_PHONE=...

# Logging y monitoreo (Fase H.4) — todas opcionales, nada de esto bloquea el arranque
LOG_LEVEL=debug                         # opcional: nivel de pino (default info en prod, debug en dev)
SENTRY_DSN=https://...ingest.sentry.io/...  # opcional: si falta, Sentry queda deshabilitado (solo se loguea)
ALERT_EMAIL_TO=tu_correo@ejemplo.com     # opcional: destino de las alertas operativas (correo vía Resend)

# Despliegue detrás de un proxy — opcional, pero necesaria si hay uno (ver nota abajo)
TRUST_PROXY=1                            # saltos de proxy en los que confiar (1 = lo típico en un PaaS)

# Healthcheck (Fase O.5) — opcional
HEALTH_READY_TIMEOUT_MS=3000             # margen del chequeo de BD en /health/ready (default 3000)

# Cupones (Fase N.2) — opcional
MIN_CHARGE_MXN=10                        # total mínimo que acepta el checkout (default 10, el mínimo de Stripe en MXN)

# Avisos de venta al dueño (Fase N.4) — opcionales, pero SIN destinatario la fase queda apagada
OWNER_NOTIFICATION_EMAIL=duenio@ejemplo.com  # destino del aviso por venta y del resumen diario;
                                             # si falta, cae a ALERT_EMAIL_TO. Ponerlo aparte permite
                                             # filtrar "vendiste" de "algo se rompió".
DAILY_DIGEST_HOUR=8                      # hora local (Celaya) del resumen del día anterior (default 8; válido 1–23)
DAILY_DIGEST_CHECK_INTERVAL_MINUTES=15   # cada cuánto se revisa si ya toca mandarlo (default 15)
```

> **`TRUST_PROXY` cuando la API va detrás de un proxy** (Render, Railway, Fly, nginx,
> Cloudflare…). Sin ella, `req.ip` es la IP del proxy y **todos** los rate limiters de
> `src/middlewares/rateLimit.ts` dejan de contar por cliente: pasan a ser un único cupo
> compartido por toda la tienda (30 consultas/min de `GET /api/orders/lookup/:token` para
> todos los compradores juntos, no para cada uno). No viene activada por defecto a propósito:
> confiar en el `X-Forwarded-For` de un servidor expuesto directamente permitiría saltarse los
> límites rotando IPs inventadas, así que el valor correcto depende del despliegue. Acepta
> `1` (o el número de proxies encadenados — **empieza aquí**), `loopback`/`10.0.0.0/8`/una lista
> separada por comas (lo más estricto), o `true` (confía en toda la cadena; solo si el proxy
> garantiza reescribir el header). Sin definir, se conserva el default de Express.

> **El esquema nunca se sincroniza automáticamente**, ni siquiera en desarrollo. `connectDB()`
> solo autentica la conexión; todo cambio de esquema pasa por una migración versionada
> (`pnpm migrate`, ver [Migraciones](#migraciones)) — dev y prod comparten exactamente el mismo
> camino de cambios.

> **Stripe (solo test/sandbox por ahora).** El PaymentIntent y el webhook son reales, con
> llaves de test. Para obtener el `STRIPE_WEBHOOK_SECRET` en local y probar los eventos, ver
> [Probar Stripe en local](#probar-stripe-en-local).

## Scripts

| Comando               | Descripción                                          |
| ---------------------- | ---------------------------------------------------- |
| `pnpm dev`              | Servidor en desarrollo con recarga (`ts-node-dev`)   |
| `pnpm build`            | Compila TypeScript a `dist/` (`tsc`)                 |
| `pnpm start`            | Ejecuta la build de producción (`node dist/app.js`)  |
| `pnpm test`             | Corre la suite de tests con Jest (ver [Testing](#testing)) |
| `pnpm test:watch`       | Corre Jest en modo watch                             |
| `pnpm seed`             | Llena la base de datos con productos, histórico de ventas, usuario admin semilla y configuración de marca (`src/seed.ts`) |
| `pnpm migrate`          | Aplica las migraciones de esquema pendientes (`sequelize-cli db:migrate`) |
| `pnpm migrate:undo`     | Revierte la última migración aplicada (`db:migrate:undo`) |
| `pnpm migrate:undo:all` | Revierte **todas** las migraciones (`db:migrate:undo:all`) |
| `pnpm migrate:status`   | Lista qué migraciones están aplicadas y cuáles pendientes (`db:migrate:status`) |

## Migraciones

El esquema se versiona con `sequelize-cli`, driveado por `.sequelizerc` (registra
`ts-node/register` para que las migraciones se escriban en TypeScript como el resto del repo, y
apunta `migrations-path`/`seeders-path`/`models-path` a `src/migrations`/`src/seeders`/
`src/models`). La config de conexión del CLI vive en `src/config/sequelize-cli.js` (JS plano, no
compilado por `tsc` — como el CLI nunca importa `app.ts`, carga su propio `dotenv.config()`) y
resuelve `DATABASE_URL` igual que la app.

`src/migrations/` reconstruye el esquema actual como una migración `createTable` por tabla, en
orden de dependencias (`products` → `product_sizes` → `orders` → `order_items` → `adminusers` →
`brand_settings`), más las migraciones incrementales que fueron llegando después (p. ej.
`order-refund-fields`, que agrega `refunded` al enum `paymentStatus` y las columnas de reembolso).

```bash
pnpm migrate         # aplica las migraciones pendientes
pnpm migrate:status   # verifica qué quedó aplicado
```

> **Al agregar o modificar una columna/tabla**, escribe la migración correspondiente en
> `src/migrations/` — no hay `sync({ alter: true })` de respaldo que la replique en ningún
> ambiente, desarrollo incluido.

## Endpoints

| Método   | Ruta                          | Auth | Descripción                                        |
| -------- | ----------------------------- | ---- | -------------------------------------------------- |
| `GET`    | `/health`                     | —    | Liveness: el proceso vive (status + timestamp, no toca la BD) |
| `GET`    | `/health/ready`               | —    | Readiness: ¿puede atender? Consulta la BD → `200`/`503` |
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
| `POST`   | `/api/admin/products/import/preview` | ✅ | Previsualiza un `.xlsx` de alta/restock masivo (no escribe nada) |
| `POST`   | `/api/admin/products/import` | ✅ | Aplica las filas revisadas en el preview (JSON) |
| `POST`   | `/api/orders`                 | —    | Checkout: crea un pedido desde el carrito          |
| `GET`    | `/api/orders/lookup/:token`   | —    | Consulta pública del estado y rastreo de un pedido (token opaco del correo) |
| `POST`   | `/api/shipping/rates`         | —    | Cotiza tarifas de envío en vivo (Skydropx) para el carrito, con fallback a tarifa plana |
| `POST`   | `/api/coupons/validate`       | —    | Valida un cupón para el carrito y devuelve el descuento, **sin canjearlo** |
| `GET`    | `/api/admin/coupons`          | ✅   | Lista los cupones (con usos consumidos y conteo vivo de canjes) |
| `POST`   | `/api/admin/coupons`          | ✅   | Crea un cupón de descuento |
| `PUT`    | `/api/admin/coupons/:id`      | ✅   | Edita un cupón (`active: false` lo cancela; `code` y usos no se editan) |
| `DELETE` | `/api/admin/coupons/:id`      | ✅   | Borra un cupón (lo desactiva si ya lo usó algún pedido) |
| `GET`    | `/api/admin/expenses`         | ✅   | Lista los gastos con su monto vigente, carga mensual y próximo cargo |
| `GET`    | `/api/admin/expenses/summary` | ✅   | Cuánto hay que retirar cada mes + los próximos cargos con su fecha |
| `GET`    | `/api/admin/expenses/history` | ✅   | Historial de gastos mes con mes, con los cambios de precio del mes |
| `POST`   | `/api/admin/expenses`         | ✅   | Da de alta un gasto (con su primera versión de monto) |
| `PUT`    | `/api/admin/expenses/:id`     | ✅   | Edita un gasto (mandar `amount` **agrega una versión**, no sobrescribe) |
| `DELETE` | `/api/admin/expenses/:id`     | ✅   | Borra un gasto (lo desactiva si ya generó algún cargo) |
| `GET`    | `/api/admin/dashboard`        | ✅   | Métricas agregadas del panel (KPIs, ingresos, ventas recientes, inventario) |
| `GET`    | `/api/admin/orders`           | ✅   | Lista paginada de pedidos con sus items (incl. `unitCost`) |
| `POST`   | `/api/admin/orders/:id/cancel` | ✅  | Cancela manualmente un pedido `pending`/`paid` (reembolso real vía Stripe si ya estaba pagado) |
| `PATCH`  | `/api/admin/orders/:id/status` | ✅  | Marca un pedido como `shipped`/`delivered` a mano, con guía capturada (solo hacia adelante) |
| `POST`   | `/api/admin/orders/:id/shipment/retry` | ✅ | Reintenta generar la guía de Skydropx de un pedido pagado que se quedó sin ella |
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
| `POST`   | `/api/webhooks/skydropx`      | 🔑   | Webhook de estado de envío de Skydropx (firma HMAC verificada; lo invoca Skydropx, no de uso manual) |

### `GET /health` y `GET /health/ready` (probes del despliegue, Fase O.5)

Son **dos probes distintos y el orquestador debe apuntar cada uno al suyo**:

| Probe | Ruta | Qué contesta | Qué hace el orquestador si falla |
| --- | --- | --- | --- |
| **Liveness** | `GET /health` | `200 { status, timestamp }`. **No toca la BD.** | **Reinicia** el contenedor |
| **Readiness** | `GET /health/ready` | `200 { status: "ok", database: "up", timestamp }` · `503 { status: "unavailable", database, reason, timestamp }` | Lo **saca de rotación** (sin reiniciarlo) |

Separarlos no es cosmético: si el liveness dependiera de Postgres, una caída momentánea de la BD
haría que el orquestador **reinicie la app** —que no arregla nada y encima tira las requests en
vuelo— en vez de solo dejar de mandarle tráfico. Por eso `/health` se quedó exactamente como
estaba y el chequeo real vive en la ruta nueva.

`/health/ready` hace `sequelize.authenticate()` bajo un timeout de `HEALTH_READY_TIMEOUT_MS`
(3 s por defecto). El timeout es imprescindible: `src/config/database.ts` no fija
`connectTimeout` ni `statement_timeout` y `pool.acquire` son 30 s, así que con Postgres caído la
consulta podría colgarse mucho más de lo que el probe espera. El resultado se cachea **1 s** y las
consultas concurrentes comparten la que está en vuelo (`src/services/readiness.ts`), para que un
script que martille esta ruta pública no se coma las 5 conexiones del pool y deje esperando a los
checkouts. Un `503` **nunca** incluye el error de la BD en el cuerpo (ruta pública sin auth): el
detalle va al log, y solo en los **cambios** de estado, para no llenar el proveedor de logs con una
línea por sondeo.

Durante el apagado ordenado, `/health/ready` responde `503` con `reason: "draining"` desde el
instante en que llega la señal — ver [Apagado ordenado](#apagado-ordenado-graceful-shutdown).

> **Hasta dónde llega el `reason: "draining"`.** Garantiza que un sondeo que **alcance a llegar**
> durante el drenado reciba un `503` honesto en vez de un `200` mentiroso, pero esa ventana dura lo
> que duren las requests en vuelo: en Node ≥ 19 `server.close()` cierra de inmediato las conexiones
> keep-alive ociosas y, sin nada que drenar, el proceso sale en milisegundos, así que el sondeo
> siguiente recibe un error de conexión (no el `503`). Para que un balanceador alcance a verlo haría
> falta un retardo explícito entre marcar el drenado y `server.close()`, que **no** está
> implementado porque alargaría cada redeploy. En la práctica el balanceador se entera por el error
> de conexión, que es igual de concluyente; el `503` cubre el caso en que sí hay tráfico drenando.

Ejemplo de configuración (Kubernetes; en Render/Railway/Fly el healthcheck configurable es el
readiness):

```yaml
livenessProbe:
  httpGet: { path: /health, port: 4000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 4000 }
  periodSeconds: 10
  timeoutSeconds: 5   # holgado respecto a HEALTH_READY_TIMEOUT_MS
```

### `GET /api/products`

Solo expone productos con `visible: true` y oculta el campo `unitCost`.

| Query param | Tipo   | Default | Descripción                                  |
| ----------- | ------ | ------- | -------------------------------------------- |
| `categoria` | string | —       | Filtra por `type` (`bota`, `sombrero`, `ropa`) |
| `talla`     | number | —       | Filtra productos que incluyan esa talla      |
| `q`         | string | —       | Busca en `name` y `code` (parcial, sin distinguir mayúsculas). Máx. 100 caracteres |
| `orden`     | string | —       | `precio_asc` · `precio_desc` · `novedad`. Sin valor, ordena por `id` ascendente |
| `precioMin` | number | —       | Precio de venta mínimo (inclusive)           |
| `precioMax` | number | —       | Precio de venta máximo (inclusive)           |
| `page`      | number | `1`     | Página (se ajusta al rango `[1, totalPages]`) |
| `perPage`   | number | `9`     | Elementos por página                         |

**Un parámetro inválido se ignora en silencio; nunca responde `400`.** Un enlace viejo o un bot con
basura en la query string debe seguir viendo el catálogo, no un error. Aplica a un `orden`
desconocido, a un precio no numérico o negativo y a una talla vacía o no entera. Un `precioMin`
mayor que `precioMax` **no se invierte**: devuelve cero resultados, que es la respuesta honesta a lo
que se pidió.

En `q`, los comodines `%` y `_` se buscan como **texto literal** (`escapeLike`, ver
`src/utils/escapeLike.ts`).

Respuesta: `{ products, total, page, perPage, totalPages, availableSizes }`. `Product.sizes`
(repetido por talla) y `Product.stock` (total) son campos `VIRTUAL` derivados de la tabla
`ProductSize` cuando se incluye esa asociación. `availableSizes` se acota por `categoria`, `q` y el
rango de precio, pero **nunca por `talla`**: si se acotara por la talla ya elegida, elegir una
vaciaría el propio selector y no habría forma de cambiarla.

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

### Importación/restock masivo de productos (Excel)

El dueño da de alta mercancía nueva y restockea la existente subiendo una hoja de cálculo, en vez
de editar producto por producto. Son **dos pasos**, y esa separación es la decisión central del
diseño: el restock **SUMA** stock y no hay forma de deshacerlo desde la app, así que aplicar un
archivo a ciegas (una fórmula que no se leyó, una columna mal escrita, un nombre que empareja con
el producto equivocado) sale caro.

1. **`POST /api/admin/products/import/preview`** `[auth]` — recibe el `.xlsx` por
   `multipart/form-data` (campo `file`, máximo **2 MB** y **500 filas**) y devuelve el plan **sin
   escribir nada**: por fila, su `action` (`create` · `update` · `unchanged` · `error`), el
   producto con el que empareja (`before`, `null` si se creará), cómo quedaría (`after`), los
   campos que cambian (`changes`) y el stock por talla (`sizeChanges`, con `before`/`added`/`after`).
2. **`POST /api/admin/products/import`** `[auth]` — recibe **JSON** `{ rows }` (los `input` que
   devolvió el preview, con las ediciones que el dueño haya hecho en pantalla) y los aplica. Es
   JSON y no el `.xlsx` original a propósito: lo que se escribe es lo que se revisó y corrigió, no
   lo que traía el archivo.

**Columnas** (encabezado canónico en español, insensible a acentos y mayúsculas, con alias comunes
como `sku`→código o `tipo`→categoría):

```
Código | Nombre | Categoría | Descripción | Precio original | Precio oferta | Costo unitario |
Tallas | Peso (kg) | Largo (cm) | Ancho (cm) | Alto (cm) | Visible
```

Una columna **no reconocida** no se descarta en silencio: sale en el `warnings` a nivel archivo del
preview ("estas columnas NO se van a importar"). Dos columnas que normalizan al **mismo** campo son
un `400`.

**Tallas**: además de la notación del formulario (`"25, 26, 26"`, una ocurrencia = una unidad) se
acepta **`"26x20"`** (20 piezas de la talla 26), mezclables: `"25x3, 26, 27x2"`. La notación `x`
existe porque el caso de uso central es el restock, y repetir `"26,"` veinte veces en una hoja de
cálculo es inviable.

**Emparejamiento**: por `Código` (insensible a mayúsculas) y, si la fila no lo trae, por `Nombre`
exacto insensible a mayúsculas. Un valor que empareja con **más de un producto** es ambiguo y la
fila falla pidiendo un código. Sin match se crea un producto nuevo (mismos campos requeridos que
`POST /api/admin/products`); con match se actualizan **solo** los campos presentes en la fila y que
realmente cambian —una columna ausente nunca borra un valor guardado— y las tallas se **suman** al
stock ya guardado. Un producto descontinuado (soft-deleted) que hace match se **reactiva**:
restockear implica que vuelve a venderse.

En la confirmación cada fila corre **independiente** (éxito parcial) y **en su propia transacción**,
con el match hecho bajo `FOR UPDATE`. Reenviar el mismo lote antes de 60 s responde `409` (doble
clic / reintento del navegador). Respuestas:
`{ summary: { total, created, updated, unchanged, failed }, warnings, rows }` en el preview y
`{ summary, rows }` al confirmar.

Para que el emparejamiento por código sea confiable, `products.code` ganó un **índice único
parcial** (`WHERE code IS NOT NULL AND code != ''`) — la migración
`20260727120000-products-code-unique-index.ts` **falla si ya existen códigos duplicados** en los
datos actuales, a propósito: no se deduplica en silencio.

### `POST /api/orders` (checkout público)

Convierte el carrito del cliente en un pedido persistido. Body:
`{ items: [{ productId, size, quantity }], customer, shippingCarrier?, quotationId?, rateId?,
couponCode? }`, validado con `createOrderSchema` (zod). El backend es la **autoridad de precios,
stock, envío y descuentos**:

- **Recalcula los totales** (`subtotal`, `savings`, `shipping`, `couponDiscount`, `total`) en el
  servidor con el service `cart` — el cliente nunca envía montos.
- **Cupón (Fase N.2):** `couponCode` es opcional, uno solo por compra, y es un **código, nunca un
  monto**. El servidor lo revalida y **canjea el uso dentro de la misma transacción** que descuenta
  el stock, así que dos compradores peleando el último uso reciben uno `201` y el otro `409`. El
  descuento se calcula sobre la mercancía neta (`subtotal − savings`) y **nunca sobre el envío**, y
  queda congelado en `couponCode`/`couponDiscount` como los precios del `OrderItem`. Un cupón
  inválido, vencido, agotado o ya usado por ese correo revierte todo (sin pedido y sin stock
  descontado) y **jamás se ignora en silencio**. Invariante:
  `total = subtotal − savings − couponDiscount + shipping`. Ver **Cupones de descuento** más abajo.
- **Envío autoritativo (Fase 8.4):** `quotationId`/`rateId` son opcionales pero van **juntos o
  ninguno** (si el checkout cotizó en vivo contra `POST /api/shipping/rates` los manda; si cayó al
  fallback de tarifa plana, los omite). Cuando vienen, el servidor **re-consulta** esa cotización en
  Skydropx (`getQuotationRate`, un solo `GET`, antes de abrir la transacción) y usa el `total` de ese
  rate como `shipping` — nunca un monto que mande el cliente. Persiste `skydropxQuotationId`/
  `skydropxRateId` y `shippingCarrier` desde el rate elegido. Un rate ya no disponible → `409`; un
  fallo de red al re-consultar → `503`. Sin `quotationId`/`rateId` usa `computeShipping` (tarifa
  plana) como antes.
- **Verifica y descuenta el stock por talla de forma atómica** dentro de una transacción, con un
  `UPDATE ... SET stock = stock - N WHERE stock >= N`. Si dos clientes compran la última unidad
  casi al mismo tiempo, solo uno recibe `201`; el otro recibe `409` y esa talla queda en stock 0.
  Cualquier fallo a media transacción revierte todo (sin descuentos parciales).
- **Congela los precios** (`unitOriginalPrice`, `unitSalePrice`, `unitCost`) y el nombre en cada
  `OrderItem`, para que el histórico no cambie si el producto se reprecia. El `unitCost` (costo
  interno) se guarda congelado pero **se excluye de la respuesta pública** — solo lo ven las rutas
  admin autenticadas. Lo mismo aplica a `shippingRequiresDropoff` (bandera operativa de "hay que
  llevar el paquete a la sucursal, no recogen a domicilio"): se persiste en la orden desde el rate
  re-consultado, pero se excluye de la respuesta de este endpoint — solo le sirve al dueño y se ve
  en `GET /api/admin/orders`.
- Renglones duplicados del mismo `(productId, size)` se agregan; el descuento se hace en orden
  determinista por `(productId, size)` para evitar deadlocks entre checkouts concurrentes.
- **Topes anti-abuso** (zod): máximo `99` unidades por artículo y `50` artículos por pedido (`400`
  si se exceden). El límite **real** de existencias por talla lo impone el descuento atómico: pedir
  más unidades de las que hay en esa talla (o una talla inexistente) devuelve `409`.
- **Idempotente (Fase O.2):** un reenvío del mismo checkout dentro de una ventana corta (**60 s**)
  no crea un segundo pedido — devuelve la **misma respuesta del original** (mismo `order`, mismo
  `clientSecret`, mismo `201`). Sin esto, un doble clic creaba otra fila `Order`, otro PaymentIntent
  real y **descontaba el stock otra vez**, y ese inventario fantasma no se liberaba hasta que
  `pendingOrderSweeper` alcanzara la orden (30–40 min). Se devuelve el original en vez de un `409`
  —al revés que el import masivo— porque el cliente está esperando para pagar: un `409` lo dejaría
  sin poder comprar y con stock apartado a su nombre. Hay **dos capas de clave**: el header
  `Idempotency-Key` (opcional, un valor nuevo por intento de compra; reusarlo con **otro** carrito
  responde `409`, y uno de más de 200 caracteres `400`) y, si no viene, una huella automática del
  carrito + los datos del cliente (renglones agregados y ordenados, así que el mismo carrito en
  distinto orden se reconoce igual). Es un mapa **en memoria**, deliberadamente no persistido —
  misma decisión que el guard del import masivo: protege del accidente, no del abuso; contra el
  abuso está `orderRateLimiter`. Un intento fallido libera la clave para que el comprador pueda
  corregir y reintentar de inmediato, **salvo** cuando el pedido ya se había creado y lo que falló
  fue el cobro: ahí la clave se conserva, porque la orden y su stock descontado ya existen y liberarla
  convertiría el reintento justo en el pedido duplicado que todo esto evita. La respuesta repetida
  trae el header `Idempotency-Replayed: true` (el cuerpo es idéntico al del original a propósito, así
  que es lo único que las distingue); va en `exposedHeaders` del CORS para que el navegador lo lea.

La ruta está limitada por `orderRateLimiter` (Fase H.3, mismo patrón que `authRateLimiter` /
`shippingRateLimiter`, `10` req/min por IP): cada request exitoso crea un PaymentIntent real de
Stripe y una fila `Order`, así que sin este límite un flood sostenido saturaría el rate limit de la
cuenta de Stripe y la tabla de órdenes (aunque `pendingOrderSweeper` libere después las `pending` sin
pagar). Solo aplica a la ruta pública `POST /`, no a `adminOrder.routes.ts` (ya protegida con JWT).

La orden nace en `status: "pending"` / `paymentStatus: "unpaid"`, se le crea un **PaymentIntent real
de Stripe** y se guarda su `paymentIntentId` (`paymentStatus: "processing"`). Respuesta `201`:
`{ order, clientSecret }` — el `clientSecret` sirve para que el cliente confirme el pago. Errores:
`400` (body/cliente inválido, código de cupón mal formado, o `Idempotency-Key` demasiado larga),
`404` (el cupón no existe), `409` (sin stock o producto no disponible —con el ítem en el mensaje—,
tarifa de envío vencida, `Idempotency-Key` reusada con otro carrito, o el cupón no aplica).

Todos los errores responden `{ message }` (los de validación agregan `details`). El `message` es la
copia que el front pinta tal cual, así que es una frase accionable en español: nombra el producto y,
cuando aplica, cuántas piezas quedan. Ver **Errores y mensajes** más abajo.

### Cupones de descuento (Fase N.2)

La única palanca de descuento que no toca el catálogo. `POST /api/coupons/validate` `[público]` deja
que el checkout muestre el descuento **antes** de pagar y el CRUD de `/api/admin/coupons` `[auth]` lo
administra: `code` (alfanumérico en mayúsculas, único), `type: percent|fixed`, `value`, `maxDiscount?`
(tope en pesos, solo para porcentajes), `minSubtotal?`, `maxRedemptions?` (`null` = ilimitado),
`oncePerCustomer` (default `true`), `startsAt?`/`expiresAt?`, `active` y `description?`. Pueden haber
varios activos a la vez, pero **uno solo por compra**.

**Cómo se limita a un uso por persona sin cuentas de cliente: por el CORREO del pedido, no por la
IP.** La IP es la opción intuitiva y la peor: detrás de CGNAT (cualquier plan móvil, Izzi,
Totalplay) media colonia sale por una sola dirección, así que un canje bloquearía compradores que
nunca usaron el cupón; y `req.ip` depende de `TRUST_PROXY`, así que desplegado detrás de un proxy sin
esa variable **todos** los compradores se ven con la IP del proxy y el primer canje mataría el cupón
para la tienda entera. El correo se normaliza (minúsculas, `+alias` recortado, puntos de Gmail
quitados) y lo hace cumplir un **índice único parcial** de Postgres, no un `SELECT` + `if`. La IP se
guarda en la fila de canje **solo como dato forense**, para que el dueño detecte patrones a mano.

**La barrera dura contra el abuso es `maxRedemptions`**, no el límite por persona: acota la pérdida
máxima a `usos × descuento` sin importar quién canjee. Se descuenta con un `UPDATE` condicional
dentro de la transacción del checkout, igual que el stock.

**El uso se devuelve** cuando un pedido se abandona o se cancela (el barrido de pedidos pendientes y
`POST /api/admin/orders/:id/cancel`). Sin eso, un cupón de 50 usos se agotaría con carritos que nunca
se pagaron. Un reembolso fallido **no** libera el uso, igual que no repone stock.

`POST /api/coupons/validate` **no canjea nada** (consultarlo diez veces no gasta la promoción) y usa
la misma función de descuento que el checkout, así que el monto que muestra es el que se cobra. Lo
que **no** garantiza es disponibilidad: el tope global y el uso por persona se re-deciden al pagar,
así que el front tiene que estar listo para el `409`. Su `email` es opcional (en el checkout el cupón
se captura antes de los datos de envío) y la respuesta lo declara con `perCustomerChecked`. Está
limitado por `couponRateLimiter` (`20` req/min por IP), y aquí el límite **sí** es la defensa
principal: los códigos de cupón no son secretos ni UUIDs, así que un cupón dirigido a una sola
persona debe ser **largo y aleatorio**, nunca `VIP`.

En el panel, `active: false` es la forma de **cancelar** un cupón; `code` y los usos consumidos no se
pueden editar (si el código está mal, se desactiva y se crea otro), y bajar `maxRedemptions` por
debajo de los usos ya consumidos es válido — es cómo se frena una promoción en caliente. `DELETE`
desactiva en vez de borrar cuando ya hay pedidos que usaron el cupón, para no romper el histórico.
`startsAt`/`expiresAt` aceptan una fecha sin hora (`2026-08-31`) y la interpretan en la zona de la
tienda (`America/Mexico_City`), con el vencimiento al final del día: un `2026-08-31` leído como UTC
habría matado la promoción la tarde del 30 en México.

### Gastos y suscripciones (Fase N.3)

Da de alta cualquier gasto —Render, Vercel, la base de datos, la renta, publicidad— con **cada cuánto
se paga** y **cuánto**, y responde las dos preguntas que el panel no podía contestar: *¿cuánto tengo
que retirar de lo ganado?* y *¿cuánto gasté cada mes, y cambió algo?*. Sustituye la constante
`GASTOS_FIJOS = $2,000` que el dashboard restaba para calcular la GANANCIA NETA — el KPI más
importante del panel era, hasta esta fase, un número inventado.

**El monto no es una columna del gasto: se guarda versionado por fecha de vigencia.** Cuando Render
sube de $290 a $340, se agrega una versión nueva y julio **sigue valiendo $290** en el historial: los
meses cerrados nunca se reescriben. Esa misma lista de versiones es lo que alimenta el arreglo
`changes` de cada mes en `/history`, o sea la respuesta consultable a "¿algo cambió?". Guardar además
un "monto actual" en el gasto habría dejado dos fuentes de verdad que se desincronizan con el primer
edit mal hecho, así que `currentAmount` se **calcula**.

**Todo en pesos.** Render y Vercel cobran en USD, pero lo que se captura es lo que cobró la tarjeta:
si el dólar sube y el cargo pasa de $130 a $145, eso **es** un cambio de monto y queda en el
historial. Sin API de tipo de cambio que se desactualice en silencio.

**Dos números distintos, y confundirlos es el error caro:**

- **El gasto real de un mes** (`/history`) se calcula generando las fechas de cargo y atribuyendo
  cada una a su mes con el monto vigente **en esa fecha**. Una anualidad de dominio aparece completa
  en su mes de renovación, no untada a lo largo del año. Los meses van sin huecos (los meses sin
  gasto salen en `$0`) y el mes en curso trae `partial: true`.
- **La carga mensual normalizada** (`monthlyRunRate` en `/summary` y en cada fila del listado)
  convierte cada gasto recurrente a su equivalente por mes: anual ÷ 12, trimestral ÷ 3, semanal
  × 52/12 (no × 4 — el año tiene 52 semanas, y usar 4 subestimaría el gasto anual en casi un mes).
  Es lo que responde "cuánto retirar" y lo que el dashboard prorratea por ventana. Los gastos de
  única vez **no** entran aquí: cuentan completos en su mes y nunca más.

`/summary` completa la respuesta con `upcomingCharges`: qué se cobra, de cuánto y **en qué fecha**
durante los próximos 30 días.

Detalles que muerden y ya están resueltos: las fechas son `DATEONLY` (un cargo es un día de
calendario, no un instante — esquiva el problema de zona horaria que los cupones tuvieron que
resolver con un offset fijo); una suscripción que arranca el **31** genera 31 de enero → 28 de
febrero → **31 de marzo**, sin arrastrar el clamp; apagar un gasto le fija `endsAt` en hoy, para que
"hasta cuándo cobró" sea un dato y no una inferencia sobre `updatedAt`; y `DELETE` **desactiva** en
vez de borrar si el gasto ya generó algún cargo, porque ese dinero se gastó y borrarlo dejaría el
historial mintiendo sobre meses cerrados.

El seed crea una fila recurrente de `$2,000/mes` equivalente a la constante vieja, para que la
GANANCIA NETA no dé un salto el día del deploy. Es una fila normal: se edita, se parte en gastos
reales o se borra.

### `GET /api/admin/dashboard` y `GET /api/admin/orders` (panel admin)

`GET /api/admin/dashboard` calcula todo en memoria a partir de `Order`/`OrderItem`/`Product`
(sin tablas de agregación): solo cuentan las órdenes con `status: "paid"`.

- `kpisByPeriod` / `profitKpisByPeriod`: igual patrón que `revenueByPeriod` — las tres ventanas
  `"7" | "30" | "90"` juntas, cada una comparada contra su propio periodo anterior (p. ej. "30"
  compara `hoy-29d..hoy` vs los 30 días previos) para el `trend`. El frontend alterna en cliente
  (`DataSection`), sin query params. Valores monetarios formateados en `es-MX` (`"$13,531.00"`).
  `GASTOS` sale de los gastos capturados en `/api/admin/expenses` (Fase N.3, antes era una
  constante de `$2,000` hardcodeada): los recurrentes como carga mensual prorrateada a la ventana
  (`× ventana/30`) más los de única vez que caigan dentro de ella, y el subtítulo separa las dos
  mitades. Cada ventana suma **sus propios** gastos de única vez, así que el `trend` de
  `GANANCIA NETA` compara periodos de verdad.
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

### `POST /api/admin/orders/:id/cancel` (cancelación/reembolso manual)

Para cuando un cliente pide cancelar fuera del flujo normal (WhatsApp, llamada). Body opcional
`{ reason? }`. Solo son cancelables `pending` y `paid`; un pedido `shipped`/`delivered` (ya tiene
guía generada, no se restockea) o ya `cancelled` responde `409`.

- **`pending`** → libera el stock reservado (`releaseOrderStock`) y, si tenía un `paymentIntentId`,
  intenta cancelarlo en Stripe (best-effort, para no dejarlo huérfano).
- **`paid`** → primero emite un **reembolso real y total** en Stripe
  (`stripe.refunds.create` con `idempotencyKey: refund-order-${id}`, así que dos cancelaciones
  concurrentes nunca reembolsan dos veces) y **solo después** restockea, dentro de una transacción
  que re-verifica `status === "paid"` bajo `FOR UPDATE` (una segunda cancelación concurrente ya la
  encuentra cerrada). Queda en `status: "cancelled"` / `paymentStatus: "refunded"` con
  `refundId`/`refundedAt` poblados.
- Si el reembolso en Stripe **falla**, nunca se restockea (el dinero no volvió): se loguea, se
  reporta a Sentry, se dispara una alerta operativa por correo y responde `502`.
- **Guard contra "resurrección" (Fase H.5):** el intento best-effort de cancelar el
  `paymentIntentId` de una orden `pending` puede fallar en silencio si el pago ya se había capturado
  en Stripe justo antes. `markOrderPaidFromWebhook` (el handler de `payment_intent.succeeded`) exige
  `status: "pending"` en su `UPDATE` condicional, así que un evento tardío/duplicado ya no puede
  reactivar una orden que un admin ya canceló (con su stock ya repuesto). Si eso ocurre, la orden
  queda `cancelled` y se dispara una alerta operativa para revisar si corresponde un reembolso
  manual — ver `CLAUDE.md`.

### `GET /api/orders/lookup/:token` (consulta pública del pedido, Fase O.4)

Deja al comprador ver en qué va su pedido **sin cuenta ni contraseña**. No hay cuentas de cliente ni
ninguna otra lectura pública de órdenes: hasta esta fase, lo único que tenía después de pagar era el
correo de confirmación, así que si lo borraba o le caía en spam, cada "¿ya salió mi pedido?" acababa
siendo trabajo manual del dueño por WhatsApp.

- **La credencial es el token**, un UUID opaco (`orders.publicToken`, con índice único) que se genera
  en `createOrder`, viaja **dos veces** en los correos al cliente —como link del botón "Ver el estado
  de mi pedido" (`/pedido/<token>`) y como **código a la vista, listo para copiar**, porque la página
  `/pedido` pide el código y un token metido dentro de un `href` no hay cómo copiarlo sin conocer el
  menú contextual del cliente de correo— y se devuelve también en el `201` del checkout. **No** es
  `id + email`: los ids son secuenciales y un correo es adivinable, así que ese par sería enumerable
  aunque se le pusiera rate limit.
- Por eso mismo **los correos al cliente no llevan número de pedido** (ni en el cuerpo ni en el
  asunto): `Order.id` es el consecutivo global de la tienda, no del comprador, y como referencia no
  le sirve de nada. La fecha del pedido sí se queda.
- **Proyección explícita**, no la fila del pedido con exclusiones: se arma campo por campo y el
  `SELECT` va acotado, así que una columna nueva en `Order` **no aparece** hasta que alguien la
  agregue a mano — el modo de fallo seguro. Devuelve estado, rastreo, totales con los precios
  congelados y la dirección de envío. Quedan fuera `unitCost`, `paymentIntentId`, `refundId`,
  `labelUrl` (la etiqueta imprimible es del dueño), los ids de Skydropx, `shippingRequiresDropoff`,
  el propio token y el correo/teléfono del cliente (el link se comparte con facilidad).
  `refundedAt` **sí** va: un pedido cancelado tiene que decir cuándo se devolvió el dinero.
- Un token **inexistente, alterado o mal formado** responde siempre el **mismo `404` con el mismo
  mensaje** (misma regla anti-enumeración que el login). El mal formado se rechaza antes de tocar la
  BD: la columna es `uuid` y Postgres rechazaría la comparación con un error que el `errorHandler`
  degradaría a un **500** — mismo problema que `parseId` resuelve para los `:id` numéricos.
- Rate limiter propio (`orderLookupRateLimiter`, **30 req/min por IP**). Holgado a propósito: quien
  recarga esa página es un comprador esperando su pedido, y adivinar un UUID es inviable con o sin
  límite. Ojo con el "por IP": detrás de un proxy sin `TRUST_PROXY` configurada (ver
  [Variables de entorno](#variables-de-entorno)) ese cupo es uno solo para toda la tienda, y el
  comprador 31 del minuto recibe un 429 en su propio pedido.

### `PATCH /api/admin/orders/:id/status` (envío/entrega manual, Fase O.1)

La única forma de que un pedido llegue a `shipped`/`delivered` **sin pasar por Skydropx**. Antes de
esta ruta, `Order.status` solo avanzaba ahí desde el webhook de Skydropx, o sea únicamente cuando
Skydropx reporta una guía que Skydropx creó: un pedido que en el checkout cayó al **fallback de
tarifa plana** nace sin `skydropxRateId` → no se genera guía → nunca llega el webhook → se quedaba
en `paid` **para siempre**, sin correo de "va en camino" y contando como pendiente en el dashboard.

Body: `{ status: "shipped" | "delivered", trackingNumber?, trackingUrl?, shippingCarrier? }`.
No agrega ninguna columna — las cuatro ya existen en `Order` desde las Fases 8.5/8.6.

- **Solo hacia adelante**, con el mismo rango que aplica el webhook
  (`pending < paid < shipped < delivered`): retroceder responde `409`. **Repetir el estado actual sí
  se permite** — es como se agrega una guía a un pedido ya marcado enviado sin ella.
- **`cancelled` no se toca aquí**: no es un valor aceptado en el body (`400`) y un pedido ya
  cancelado responde `409`. Cancelar sigue siendo exclusivo de `POST /api/admin/orders/:id/cancel`,
  el único camino que reembolsa y restockea. Un pedido todavía `pending` también responde `409` (no
  se despacha mercancía sin pago confirmado).
- El correo **"tu pedido va en camino" sale exactamente una vez por pedido**, lo dispare el panel o
  el webhook: los dos comparten el mismo guard atómico (`WHERE trackingNumber IS NULL`) y el mismo
  `idempotencyKey` de Resend. Marcar `delivered` **sin** guía es válido (entrega en mano o local) y
  no manda correo.

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

### Envío en vivo con Skydropx (Fase 8.1–8.6)

`POST /api/shipping/rates` (público, `src/routes/shipping.routes.ts` →
`shipping.controller.ts`) cotiza el envío en vivo contra Skydropx Pro para el checkout, con la
tarifa plana existente (`computeShipping`) como **fallback** si Skydropx falla, tarda o algún
producto del carrito no tiene dimensiones válidas. `src/services/skydropx.service.ts` maneja el
OAuth2 (`client_credentials`, token cacheado ~2h), limita las llamadas salientes a 2 req/s (límite
de la cuenta) y hace poll de la cotización hasta que las tarifas dejan de estar `pending`, se junten
3 tarifas utilizables (`MIN_READY_RATES`, corte temprano para no esperar una paquetería colgada) o
se agote un timeout de 8s. Las tarifas devueltas se filtran a las **utilizables** (resueltas,
exitosas, con montos), se ordenan de más barata a más cara y se recortan a 5 (`MAX_RATES_RETURNED`).
`SKYDROPX_CARRIERS` (env opcional) restringe de antemano qué paqueterías se cotizan, para respuestas
más rápidas. Cada tarifa incluye `requiresDropoff` (`true` = el dueño debe llevar el paquete a la
sucursal de la paquetería, no hay recolección a domicilio — dato operativo, el checkout no necesita
mostrarlo). `src/services/packing.ts` arma una sola caja apilada por pedido a partir de las
dimensiones/peso de cada producto. La ruta está limitada por `shippingRateLimiter` (20 req/min por
IP) para no acaparar el presupuesto de 2 req/s compartido por toda la cuenta. `POST /api/orders`
usa la cotización elegida como fuente autoritativa del costo de envío (ver la sección de checkout
arriba).

**Guía automática al pagar (Fase 8.5):** en cuanto el webhook de Stripe confirma el pago,
`createShipmentForOrder` (`src/services/payment.service.ts`) crea la guía real contra Skydropx
(`POST /api/v1/shipments`) usando el `rateId` guardado en la orden, y persiste
`Order.skydropxShipmentId` — protegido por un guard de idempotencia con centinela para no generar
dos guías (dinero real) ni con reintentos concurrentes. Si la cotización guardada ya venció, se
re-cotiza sola antes de crear el envío (sin tocar el monto ya cobrado). La creación es **asíncrona**
en Skydropx: `tracking_number`/`label_url` no llegan en la respuesta, así que
`trackingNumber`/`trackingUrl`/`labelUrl` quedan en `null` hasta que el webhook de Skydropx
(Fase 8.6) los reporte — ver `roadmaps-completados/roadmap-skydropx.md` para el detalle completo.

**Reintento de guía (Fase O.3):** si esa única llamada falla (Skydropx caído, saldo agotado, o el
proceso muere a media creación), el pedido queda pagado y sin guía y **ningún webhook va a llegar por
una guía que nunca se creó**. `POST /api/admin/orders/:id/shipment/retry` `[auth]` lo reintenta desde
el panel, y `src/services/shipmentRetrySweeper.ts` hace lo mismo solo cada
`SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES` sobre los pedidos `paid` con tarifa de Skydropx que siguen sin
guía pasados `SHIPMENT_RETRY_DELAY_MINUTES` (hasta 3 intentos por pedido, con una sola alerta por
correo al agotarlos). Ese mismo margen sirve para **liberar el centinela huérfano**: el valor
`"creating"` que quedaría bloqueando al pedido para siempre si el proceso muriera entre reclamarlo y
llamar a Skydropx. La antigüedad de ese centinela se mide con la columna propia
`orders.shipmentClaimedAt` (poblada al reclamarlo) y **no** con `updatedAt`, que cualquier otra
escritura sobre el pedido reiniciaría.

**Cada guía se cobra**, así que ninguno de los dos caminos genera una segunda ante la duda: un pedido
con `skydropxShipmentId` real se rechaza con `409`, y el caso "Skydropx la creó y cobró pero no se
pudo guardar su id" se marca con el valor especial `unreconciled:<id real>`, que nadie reintenta y que
conserva el id para localizar la guía en el panel de Skydropx (el webhook de esa guía, si llega,
reconcilia la fila solo). Un pedido ya marcado como `shipped`/`delivered` también se rechaza: ahí la
guía suele haberse generado a mano en el panel de Skydropx y capturado con el `PATCH .../status`.

Cuando Skydropx **no responde** al crear la guía (timeout, conexión cortada, 5xx) no se puede saber si
la creó y la cobró, así que el pedido se marca `unreconciled:desconocido` en vez de liberarse para un
reintento: liberarlo es exactamente lo que pagaría la segunda guía. Un `4xx` sí libera (ahí Skydropx
rechazó la petición y no creó nada). Ese es el único caso que el dueño puede **forzar** desde el panel
(`{ "force": true }` en el body) una vez que confirmó que no existe ninguna guía; un id real nunca se
fuerza. El endpoint **espera el resultado**: `200` con la guía creada, `409` si el pedido no aplica
(ya tiene guía, se está generando, no está pagado, está cancelado, ya se marcó como enviado/entregado,
se cobró con tarifa plana, o quedó sin conciliar) y `502` si Skydropx vuelve a fallar.

**Webhook de estado de envío (Fase 8.6):** `POST /api/webhooks/skydropx`
(`src/routes/webhook.routes.ts` → `order.controller.ts`'s `skydropxWebhook`) se monta con el mismo
`express.raw` que el de Stripe y verifica la firma **HMAC-SHA512** del header
`Authorization: HMAC <firma>` contra `SKYDROPX_WEBHOOK_SECRET` (comparación en tiempo constante);
firma ausente/inválida → `400`, evento verificado → `200` aunque no se maneje (sin reintentos en
bucle). Del evento `packages` puebla por primera vez `trackingNumber`/`trackingUrl`/`labelUrl`,
guarda el `shipmentStatus` crudo, avanza `Order.status` a `shipped`/`delivered` **solo hacia
adelante** y dispara el correo "tu pedido va en camino" **exactamente una vez** (guard atómico
`WHERE trackingNumber IS NULL`, reusando el template de confirmación con datos de rastreo) — ver
`applyShipmentUpdateFromWebhook` en `src/services/payment.service.ts`.

### Pagos con Stripe (Fase 8 — solo test/sandbox)

El cobro con Stripe está **activo** (llaves de test/sandbox). `src/config/stripe.ts`
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
  PaymentIntent ya se pagó y se perdió el webhook). También alcanza a las órdenes `pending` **sin**
  `paymentIntentId` —las que quedaron así porque Stripe falló cuando la orden ya estaba escrita con su
  stock descontado—: no hay nada que reconciliar (el cliente nunca recibió un `clientSecret`, así que
  ese pedido no puede pagarse) y son las únicas que ningún webhook va a tocar, así que se les repone el
  stock directo.
- **Correo de confirmación (Fase 9.3):** al pasar a `paid`, `markOrderPaidFromWebhook` dispara el
  correo de confirmación (Resend) con el resumen del pedido. La transición a `paid` es un **UPDATE
  atómico condicional** (`WHERE status: "pending", paymentStatus != 'paid'`): garantiza que el correo
  se envíe **una sola vez** aunque el webhook y el barrido lleguen a la vez (con un `idempotencyKey` de
  Resend como segundo respaldo), y que un evento tardío/duplicado nunca reactive una orden que ya fue
  cancelada manualmente (ver la nota de "resurrección" en la sección de cancelación manual, arriba). El
  envío es **fire-and-forget** (no bloquea la respuesta `200` del webhook) y nunca tumba el evento si
  Resend falla.

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

## Logging y monitoreo

`src/config/logger.ts` exporta una instancia compartida de **pino** (`logger`), usada en cada cron,
webhook o envío en segundo plano que antes usaba `console.*` — nivel `info` en producción (una
línea JSON por registro) / `debug` en desarrollo (con `pino-pretty`), configurable con `LOG_LEVEL`.
No hay middleware de logging de requests (`pino-http`): todo lo que se loguea aquí es un
cron/webhook/envío en background, no tráfico HTTP normal.

`src/config/sentry.ts` inicializa `@sentry/node` **solo si `SENTRY_DSN` está definido** (si falta,
continúa con solo un warning en el log) — a diferencia de Stripe/Resend/Cloudinary/Skydropx, Sentry
es monitoreo opcional, no una dependencia del negocio. Se importa como la primera línea de
`src/app.ts`, antes incluso que `express`, para estar armado antes de que cualquier otro módulo de
configuración pueda lanzar por una env var faltante. El manejador global de errores reporta a Sentry
todo error no controlado que llegue al `500`.

`src/services/alert.service.ts` envía correos operativos (vía Resend) a `ALERT_EMAIL_TO` (opcional
— si falta, no hace nada y solo loguea un warning) en dos casos: falla al generar una guía de
Skydropx después de haber pagado el pedido (`createShipmentForOrder`), y fallas repetidas (3
seguidas) del barrido de órdenes pendientes contra Stripe para la misma orden. Estos son avisos
operativos, no un sistema de reintentos automáticos — con una excepción: desde la Fase O.3 la guía
fallida **sí** se reintenta sola (`shipmentRetrySweeper`), y por eso ese camino apaga la alerta por
intento y manda una sola al agotar los 3.

## Avisos de venta al dueño (Fase N.4)

`alert.service.ts` solo avisa cuando algo **falla**. Los avisos de **negocio** viven aparte, en
`src/services/ownerNotification.service.ts` y `src/services/dailySalesDigest.ts`, y van a
`OWNER_NOTIFICATION_EMAIL` (con fallback a `ALERT_EMAIL_TO`). **Si ninguna de las dos está definida,
no se manda nada** — ese es el interruptor de la función, no hay una variable booleana aparte.

Son dos correos que responden preguntas distintas:

- **Aviso por venta.** Sale al confirmarse el pago, bajo el mismo guard atómico que el correo de
  confirmación al cliente, así que llega **exactamente una vez** por pedido. Trae tallas, cantidades,
  dirección y contacto, y avisa de las dos cosas que obligan a actuar a mano: que el pedido se cobró
  con la tarifa plana de respaldo (**no habrá guía automática**) y que la paquetería no recoge a
  domicilio. El asunto es autocontenido (`Venta #142 — $1,850.00 — 3 piezas — GUÍA MANUAL`) para poder
  leerse sin abrir el correo.
- **Resumen diario.** A las `DAILY_DIGEST_HOUR` (8:00 hora de Celaya) con el **día anterior completo**:
  totales, tabla por pedido, comparación contra el día previo y una sección de pedidos que requieren
  acción. Se manda **también los días sin ventas**, para que un día flojo no se confunda con un cron
  caído.

Nota de despliegue: a diferencia de los correos al cliente, esta función **ya sirve sin dominio
verificado en Resend**, porque el destinatario es el propio dueño de la cuenta de Resend.

## Apagado ordenado (graceful shutdown)

`SIGTERM`/`SIGINT` disparan un `gracefulShutdown` compartido en `src/app.ts` que: (0) pone el
readiness en rojo (`markDraining()`, Fase O.5) — a partir de ahí `GET /health/ready` responde `503`
con `reason: "draining"` sin consultar la BD, así ningún sondeo que llegue mientras se drena recibe
un `200` que ya no es cierto (ver el [alcance real](#get-health-y-get-healthready-probes-del-despliegue-fase-o5)
de esa ventana); (1) detiene los tres crons
—`pendingOrderSweeper`, `shipmentRetrySweeper` y el resumen diario de ventas— (dejan de abrir trabajo
nuevo), (2) `server.close()` — deja de aceptar
conexiones nuevas y espera a que terminen las que están en vuelo, (3) cierra el pool de Sequelize.
Así un redeploy no corta una transacción de checkout a medias. Señales repetidas se ignoran, y un
timeout de 10s (`unref()`ado) fuerza `process.exit(1)` si alguna conexión colgada bloquea el cierre.

## Errores y mensajes

Todos los errores salen del `errorHandler` (`src/middlewares/errorHandler.ts`) como
`{ message }`, y los de validación agregan `details: [{ path, message }]`.

**El `message` es la copia de UI del front.** Todos los consumidores (`usePlaceOrder.ts`,
`ProductForm.tsx`, `AccountCard.tsx`, `AdminsCard.tsx`…) leen **solo** `data.message` y lo pintan
tal cual; **nadie lee `details`**. Por eso cada mensaje es una frase completa en español que
nombra la entidad y dice qué hacer:

```jsonc
// 409 — POST /api/orders
{ "message": "Solo queda 1 pieza de \"Bota Bordada Tejana\" en talla 24. Ajusta la cantidad para continuar." }

// 400 — POST /api/orders (validación: el message resume los campos, details los trae todos)
{
  "message": "El teléfono debe tener 10 dígitos · El código postal debe tener 5 dígitos",
  "details": [
    { "path": "customer.phone", "message": "El teléfono debe tener 10 dígitos" },
    { "path": "customer.postalCode", "message": "El código postal debe tener 5 dígitos" }
  ]
}
```

Reglas al agregar o tocar un endpoint:

- **Escribe el `message` para el usuario final**, no para el log: nombra el producto/usuario y la
  acción a tomar. Nada de ids sueltos ni códigos.
- **Validación:** el `message` se arma con los mensajes por campo (uno por campo, máximo 3, luego
  "(y N campos más por corregir)"). Dale un mensaje propio a **cada campo** del schema; los
  defaults de zod salen en español (`src/config/zod.ts` fija `z.locales.es()`) pero describen un
  tipo ("se esperaba número, recibido indefinido"), no una solución. En zod 4 el mensaje de tipo
  es el **primer** argumento: `z.number("El peso (kg) es requerido").nonnegative("…")`.
- **Params `:id`:** pásalos por `parseId(req.params.id, "producto")` (`src/utils/parseId.ts`) o un
  id no numérico llega como `NaN` a Sequelize y el error del cliente termina como **500**.
- **Nunca reveles si un correo existe:** `POST /api/auth/login` devuelve el **mismo** `401` para
  correo desconocido y contraseña errada, y `assertValidResetCode` el **mismo** `400` para código
  inexistente/errado/expirado/sin intentos. Es deliberado: `forgot-password` ya responde
  `{ ok: true }` siempre por la misma razón.
- **Body ilegible:** un JSON mal formado devuelve `400` ("El cuerpo de la petición no es un JSON
  válido"), no `500`.

## Testing

Suite automatizada con **Jest + ts-jest + supertest** (Fase H.1 — ver
[`roadmaps-completados/roadmap-testing.md`](roadmaps-completados/roadmap-testing.md) para el desglose por partes; las **12 partes** — infra,
BD de test, servicios puros, auth, checkout, idempotencia de webhooks, cancelación/reembolso manual,
envío en vivo, cliente Skydropx, CRUD admin de productos/imágenes, marca/usuarios admin y
agregaciones de dashboard/reports — están **completas**: 37 suites / 412 tests en verde, y cada
fase nueva suma la suya). Los tests
viven en `tests/` (fuera de `src/`, para que `tsc` no los incluya en el build de producción);
`ts-jest` los transpila en memoria.

```bash
pnpm test              # toda la suite
pnpm test:watch         # modo watch
pnpm test <patrón>      # una parte (p. ej. pnpm test auth)
```

**Tres niveles de prueba:** (1) *unit puro* sin BD (`cart`, `forecast`, `formatMoney`, `date`,
`skydropx` con `fetch` mockeado, `dashboard`/`reports`, `sentry`, `errorHandler`, `idempotency`,
`readiness`);
(2) *integración HTTP* con `request(app)...` contra un Postgres de test real (`auth`,
`checkout`, `checkoutIdempotency`, `adminOrderStatus`, `products`, `shippingRates`, `adminProducts`,
`adminProductImport`, `adminBrandUsers`, `healthReady`); (3)
*servicio + SDK mockeado* para
concurrencia/idempotencia (`webhooks`, `cancelOrder`). **Stripe,
Skydropx y Resend van SIEMPRE mockeados** (cuestan dinero o mandan correos reales); la **BD no se
mockea**. `jest.config.ts` fuerza `maxWorkers: 1`: varias suites de integración comparten el mismo
Postgres de test y cada una dropea/recrea las tablas en su `beforeAll` (`sync({ force: true })`), así
que correrlas en paralelo produce errores intermitentes de tipo `ENUM ya existe`; un solo worker
serializa todo y elimina la carrera.

Al importar `src/app.ts` con `NODE_ENV=test`, un gate salta el `connectDB()`, los barridos
(`pendingOrderSweeper`/`shipmentRetrySweeper`) y el `app.listen(...)`, así que Supertest levanta `app` sin abrir puerto ni
conectar a la BD. La config de test (`.env.test`, gitignored) trae llaves dummy que satisfacen el
fail-fast de cada `src/config/*` más el `DATABASE_URL` de pruebas.

> ⚠️ **Base de datos de test dedicada.** Las suites de integración corren contra el Postgres
> apuntado por `DATABASE_URL` en `.env.test`, que **hay que crear** (`createdb botasdonchuy_test`)
> antes de correrlas — ver la **Parte 0.5** del roadmap de testing. Cada corrida hace
> `sync({ force: true })`, que **BORRA y recrea las tablas**, así que debe ser una BD exclusiva de
> pruebas, nunca la de desarrollo o producción. Las suites `unit/` y `smoke/` no necesitan BD.

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
.sequelizerc                     # Config de sequelize-cli (ts-node/register + rutas de migrations/seeders/models)
jest.config.ts                   # Config de Jest (preset ts-jest, setupFiles, testMatch tests/**)
tsconfig.jest.json               # tsconfig para tests (extiende el base; rootDir "." + types jest/node)
tests/                           # Suite automatizada (fuera de src/ — tsc la ignora), ver Testing
├── tsconfig.json                # Extiende ../tsconfig.jest.json (tsconfig local para el editor)
├── setup/                       # env.ts, db.ts, factories.ts, mocks/{stripe,skydropx,resend}.ts
├── smoke/                       # import app + GET /health (valida el arranque en test)
├── unit/                        # nivel 1 — servicios/utils/config/middlewares puros, sin BD
└── integration/                 # niveles 2/3 — Postgres de test (auth, checkout, checkoutIdempotency,
                                  # products, webhooks, cancelOrder, adminOrderStatus, shippingRates,
                                  # adminProducts, adminProductImport, adminBrandUsers, healthReady)
src/
├── app.ts                       # Punto de entrada: Express, middleware, arranque y apagado ordenado
├── seed.ts                      # Script de seed (productos, histórico, admin, marca)
├── config/
│   ├── database.ts              # Conexión Sequelize a PostgreSQL
│   ├── sequelize-cli.js         # Config de conexión para sequelize-cli (JS plano, dotenv propio)
│   ├── stripe.ts                # Cliente Stripe + llaves exigidas (test/sandbox)
│   ├── cloudinary.ts            # Cliente Cloudinary + llaves exigidas (fail-fast al arrancar)
│   ├── resend.ts                # Cliente Resend + RESEND_API_KEY/EMAIL_FROM exigidos (fail-fast)
│   ├── skydropx.ts              # Cliente/llaves de Skydropx + SHIP_FROM_* exigidos (fail-fast)
│   ├── logger.ts                # Instancia compartida de pino (structured logging)
│   ├── sentry.ts                # Inicializa @sentry/node si SENTRY_DSN está definido (opcional)
│   ├── zod.ts                   # z.config(z.locales.es()) — mensajes por defecto de zod en español
│   └── swagger.ts               # Spec OpenAPI base (swagger-jsdoc) servida en /api/docs
├── controllers/
│   ├── product.controller.ts    # Lógica de productos (listar, obtener por id, CRUD admin, import masivo)
│   ├── auth.controller.ts       # Login, forgot-password, verify-reset-code, reset-password, me
│   ├── order.controller.ts      # Checkout, consulta pública por token, admin orders, cancelación manual, webhooks de Stripe/Skydropx
│   ├── shipping.controller.ts   # POST /api/shipping/rates (cotización en vivo)
│   ├── dashboard.controller.ts  # GET /api/admin/dashboard
│   ├── reports.controller.ts    # GET /api/admin/reports/monthly y /replenishment
│   ├── brand.controller.ts      # GET/PUT /api/admin/brand + POST/DELETE del logo
│   └── adminUser.controller.ts  # /api/admin/users + PUT /api/admin/account
├── middlewares/
│   ├── AppError.ts               # Clase de error con status code para respuestas controladas
│   ├── asyncHandler.ts            # Wrapper para controllers async (evita try/catch repetido)
│   ├── errorHandler.ts            # Middleware centralizado de manejo de errores
│   ├── rateLimit.ts               # authRateLimiter / shippingRateLimiter / orderRateLimiter / orderLookupRateLimiter
│   ├── requireAuth.ts             # Verifica JWT Bearer, adjunta req.user; requireRole helper
│   └── upload.ts                  # multer en memoria (uploadProductImages / uploadLogo / uploadProductImportFile)
├── routes/
│   ├── product.routes.ts        # Rutas /api/products
│   ├── adminProduct.routes.ts   # Rutas /api/admin/products (CRUD admin + imágenes + import masivo, requireAuth)
│   ├── auth.routes.ts           # Rutas /api/auth
│   ├── order.routes.ts          # Rutas /api/orders (checkout público + consulta por token)
│   ├── adminOrder.routes.ts     # Rutas /api/admin/orders (listado, cancelación, estado manual y reintento de guía, requireAuth)
│   ├── adminDashboard.routes.ts # Ruta /api/admin/dashboard (requireAuth)
│   ├── adminReports.routes.ts   # Rutas /api/admin/reports/* (requireAuth)
│   ├── shipping.routes.ts       # Ruta /api/shipping/rates (cotización en vivo, pública)
│   ├── brand.routes.ts          # Ruta /api/admin/brand (GET pública, PUT/logo requireAuth)
│   ├── adminUser.routes.ts      # Rutas /api/admin/users (requireAuth)
│   ├── account.routes.ts        # Ruta /api/admin/account (requireAuth)
│   └── webhook.routes.ts        # Rutas /api/webhooks/stripe y /api/webhooks/skydropx (firma verificada)
├── schemas/
│   ├── auth.ts                   # Esquemas zod de login y recuperación de contraseña
│   ├── checkout.ts                # Esquema zod de envío/checkout
│   ├── shipping.ts                # Esquema zod de cotización de envío
│   ├── product.ts                 # Esquema zod de producto
│   ├── productImport.ts           # Esquemas zod de fila/lote de la importación masiva
│   ├── brand.ts                   # Esquema zod de update parcial de BrandSettings
│   └── adminUser.ts               # Esquemas zod de alta de usuario y update de cuenta propia
├── services/
│   ├── cart.ts                    # computeTotals, computeShipping, SHIPPING_BY_TYPE
│   ├── orders.service.ts          # Checkout idempotente: stock atómico, totales, precios congelados; releaseOrderStock / cancelOrderByAdmin / updateOrderStatusByAdmin / getOrderByPublicToken
│   ├── payment.service.ts         # Stripe: PaymentIntent, concilia pagos/fallos/reembolsos, crea/reintenta guía Skydropx, dispara correos
│   ├── pendingOrderSweeper.ts     # Barrido de órdenes pending abandonadas (libera stock, reconcilia con Stripe)
│   ├── shipmentRetrySweeper.ts    # Barrido de guías pendientes: reintenta la guía de pedidos pagados sin ella
│   ├── skydropx.service.ts        # Cliente REST de Skydropx (OAuth2, throttle 2 req/s, cotización, guía, poll)
│   ├── packing.ts                 # buildParcel: arma una sola caja apilada por pedido
│   ├── productAvailability.ts     # assertProductAvailable: guardia compartida checkout/cotización
│   ├── readiness.ts               # Readiness de GET /health/ready: chequeo de BD con timeout, caché 1s y flag de drenado
│   ├── alert.service.ts           # sendAlertEmail: avisos operativos (guía fallida o irreintentable, sweepers con fallas repetidas)
│   ├── image.service.ts           # Cloudinary: sube buffer (upload_stream) y borra asset (destroy)
│   ├── productImport.service.ts   # Importación/restock masivo: parsea el .xlsx, previsualiza y aplica
│   ├── email.service.ts           # sendEmail(...) sobre Resend; loguea pero nunca lanza
│   ├── email/templates/           # Plantillas HTML como funciones (passwordResetCode.ts, orderConfirmation.ts)
│   ├── dashboard.service.ts       # Agregación en memoria para GET /api/admin/dashboard
│   ├── reports.service.ts         # Reportes mensuales + reposición (usa forecast.ts, cachea 60s)
│   └── forecast.ts                # Función pura portada del frontend
├── utils/
│   ├── password.ts                # Helpers de hash/verificación de contraseñas (bcrypt)
│   ├── date.ts                    # Helpers de fecha UTC (isoDay/isoMonth/formatShortDate/...)
│   ├── formatMoney.ts             # Formateo es-MX compartido por correos/reportes/errores de precio
│   ├── parseId.ts                 # Valida :id numérico antes de tocar Sequelize (evita 500 por NaN)
│   ├── idempotency.ts             # Huella sha256 + mapa con TTL compartidos por el checkout y el import masivo
│   ├── constantTimeEqual.ts       # Comparación en tiempo constante (firma HMAC de Skydropx y código de reset)
│   ├── productSizesInclude.ts     # Include reusado para resolver los VIRTUAL stock/sizes de Product
│   ├── excelCell.ts               # Lee celdas de exceljs (fórmulas, richText, hyperlink) sin "[object Object]"
│   ├── sizesSpec.ts               # Parsea la notación de tallas del Excel ("25x3, 26, 27x2")
│   ├── sizesToRows.ts             # Agrupa tallas repetidas en filas { size, stock }
│   └── resetCode.ts               # Genera/hashea el código de recuperación de 5 dígitos
├── migrations/                  # Migraciones versionadas (sequelize-cli), una por tabla + incrementales
├── seeders/                     # Reservado para sequelize-cli (vacío; el seed real vive en seed.ts)
└── models/
    ├── Product.ts                # Modelo Product (bota | sombrero | ropa)
    ├── ProductSize.ts            # Stock por talla (productId, size, stock), único por (productId, size)
    ├── AdminUser.ts              # Usuarios del panel (id, name, email, passwordHash, role, reset de contraseña)
    ├── Order.ts                  # Pedidos (totales, envío, pago, tracking, reembolso)
    ├── OrderItem.ts              # Renglones de pedido con precios congelados
    ├── BrandSettings.ts          # Configuración de marca (singleton)
    └── associations.ts           # Relaciones entre modelos (hasMany/belongsTo)
```
