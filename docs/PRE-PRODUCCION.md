# Checklist de pre-producción — Backend Botas Don Chuy Outlet

> Revisión completa del repo hecha el **2026-08-24** sobre `main` (último commit `f72681c`,
> Fase 28 — disputas). Este documento lista **solo lo que falta**: lo que ya funciona no se
> repite aquí, vive en `README.md`, `CLAUDE.md` y `docs/features/`.
>
> **Actualizado el 2026-08-24:** cerrados los cinco arreglos de código del paso 2 del orden de
> ejecución — puntos **8**, **9**, **10**, **11** y **14**. Lo que queda es despliegue,
> credenciales y operación.

## Estado verificado hoy

Todo esto se comprobó ejecutándolo, no leyéndolo:

| Comprobación | Resultado |
| --- | --- |
| `pnpm build` (type-check + emisión a `dist/`) | ✅ sin errores |
| `pnpm test` | ✅ **60 suites / 787 tests**, todos pasando (40 s) |
| Migraciones vs. modelos | ✅ sin drift: cada columna de `Order`/`Product`/etc. tiene su migración |
| Integración con el frontend | ✅ las 27 fases de `../frontend/ROADMAP-BACKEND-INTEGRATION.md` cerradas; disputas (Fase 28) ya se pintan en el panel |
| CI (`.github/workflows/ci.yml`) | ✅ Postgres 16 + `pnpm build` + `pnpm test` en cada PR y push a `main` |

**El código está listo. Lo que falta es despliegue, credenciales y operación.**

---

## 🔴 Bloqueantes — sin esto no se puede lanzar

### 1. No existe destino de despliegue para el backend

Es el hueco más grande. El frontend ya tiene su camino (`vercel.json`, `.env.vercel.production`,
`outlet.botasdonchuy.com` apuntando a Vercel); **el backend no tiene nada**:

- Sin `Dockerfile`, `render.yaml`, `fly.toml`, `Procfile` ni equivalente.
- Sin `.env.example` versionado — la única lista de variables está en prosa dentro del `README.md`,
  así que dar de alta el servicio en el PaaS es copiar a mano ~35 variables sin nada que las valide.
- Sin paso de deploy que corra `pnpm migrate` (ver punto 5).

**Qué hacer:**
- [ ] Elegir proveedor (Render/Railway/Fly — el roadmap de gastos ya asume Render) y crear el servicio.
- [ ] Crear `.env.example` en la raíz con **todas** las variables (nombres + comentario, sin valores)
      y versionarlo. Es la referencia de alta y evita descubrir una variable faltante en el arranque.
- [ ] Definir el comando de arranque: `pnpm build` en build, `pnpm start` en runtime.
- [ ] Apuntar el *readiness probe* del proveedor a `GET /health/ready` y el *liveness* a `GET /health`
      (están hechos para eso: apuntar el liveness a `/ready` provoca reinicios en cada blip de Postgres).

### 2. Todas las credenciales están en modo prueba

`.env` actual (verificado, sin exponer secretos):

| Variable | Valor actual | Qué necesita producción |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` (activa el nivel `info` de pino y apaga el log de SQL) |
| `STRIPE_SECRET_KEY` | `rk_test_…` | llave **live** (`sk_live_`/`rk_live_`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_` de test | el `whsec_` del endpoint **live** — es distinto |
| `SKYDROPX_BASE_URL` | `https://sb-pro.skydropx.com` (sandbox) | `https://pro.skydropx.com` |
| `SKYDROPX_CLIENT_ID`/`_SECRET`/`_WEBHOOK_SECRET` | cuenta sandbox | las variantes `_PROD` que ya están guardadas comentadas en `.env` |
| `CORS_ORIGIN` | `http://localhost:3000,http://192.168.1.149:3000` | `https://outlet.botasdonchuy.com` |
| `FRONTEND_URL` | `http://localhost:3000` | `https://outlet.botasdonchuy.com` — **los links de los correos salen de aquí**; con el valor viejo, cada correo de seguimiento manda al comprador a `localhost` |

`EMAIL_FROM` ya es `no-reply@botasdonchuy.com` con el dominio verificado en Resend (README §Dominio),
así que **el pendiente heredado "verificar dominio en Resend" ya está cerrado** aunque el checklist de
`roadmaps-completados/roadmap-operacion-y-negocio.md` siga marcándolo sin palomear.

**Ojo con Skydropx:** la cuenta de producción **no tiene sandbox propio**. Al cambiar a `_PROD`, cada
`POST /shipments` de prueba gasta saldo real. Cancelar los envíos de prueba
(`POST /shipments/{id}/cancellations`) y vigilar `GET /api/v1/finance/credits`.

### 3. Suscripción de eventos en los paneles de Stripe y Skydropx

**Se configura fuera del repo y no hay forma de detectar que falta:** el handler simplemente nunca
recibe el evento y todo "parece" funcionar.

- [ ] **Stripe (modo live)** — crear el endpoint apuntando a `https://<api>/api/webhooks/stripe` y
      suscribir **seis** eventos: `payment_intent.succeeded`, `payment_intent.payment_failed`,
      `payment_intent.canceled` **y** `charge.dispute.created`, `charge.dispute.updated`,
      `charge.dispute.closed`. Los tres de disputa son de la Fase 28 y son los que se olvidan:
      sin ellos, un contracargo deja el pedido en "pendiente de enviar" y la mercancía se manda
      con el dinero ya retirado. `stripe listen` reenvía todo en local, así que el hueco **solo se
      nota en producción**.
- [ ] **Skydropx** — configurar el webhook a `https://<api>/api/webhooks/skydropx` con autenticación
      **HMAC** y usar ese mismo secreto como `SKYDROPX_WEBHOOK_SECRET`. Sin él no llega ningún
      `tracking_number`, no sale el correo "va en camino" y el pedido nunca avanza a `shipped`.

### 4. `TRUST_PROXY` sin definir

No está en el `.env` actual. Detrás del proxy del PaaS, `req.ip` es la IP del proxy y **los cinco rate
limiters colapsan en un solo cupo para toda la tienda**: 30 consultas/min de
`GET /api/orders/lookup/:token` compartidas entre *todos* los compradores, así que el 31.º que abra su
link de seguimiento recibe un `429` en su propio pedido.

- [ ] `TRUST_PROXY=1` como punto de partida en cualquier PaaS. Verificar después de desplegar que
      `req.ip` es la del cliente (un `429` que llegue demasiado pronto es la señal de que quedó mal).

### 5. `pnpm migrate` no puede correr en un deploy de producción tal como está

`sequelize-cli` y `ts-node` son **devDependencies**, y las migraciones están escritas en TypeScript.
Un `pnpm install --prod` en el paso de release deja el comando sin binario.

- [ ] Decidir una de dos: instalar sin `--prod` en el paso de migración, o promover
      `sequelize-cli` + `ts-node` a `dependencies`.
- [ ] Añadir el paso de migración al pipeline **antes** de arrancar la app nueva (hay 21 migraciones
      pendientes de aplicar contra una base vacía).

### 6. Alta del primer usuario admin en producción

**`pnpm seed` NO sirve para producción** y esto no está dicho en ningún lado:
- inserta 30+ productos mock del frontend y un histórico de órdenes falsas que entrarían al dashboard
  y a los reportes como si fueran ventas reales;
- crea el admin con la contraseña **hardcodeada `Queco144@`** y el correo del desarrollador
  (`src/seed.ts:247`);
- llama `process.exit` al final.

No existe ningún otro camino para crear el primer usuario (`POST /api/admin/users` exige un JWT, y
para tener JWT hace falta un usuario).

- [ ] Escribir un script mínimo de bootstrap (correo + contraseña por argumento/env, solo
      `AdminUser` + `BrandSettings`, sin productos ni órdenes), **o** documentar el `INSERT` manual
      con un hash de bcrypt generado aparte.
- [ ] Cambiar la contraseña del admin semilla si en algún momento se corrió el seed contra la base
      que va a producción.

### 7. No hay estrategia de respaldo de la base de datos

No hay nada en el repo ni en la documentación. La base guarda los pedidos, el histórico de ventas,
los precios congelados y las constancias de aceptación de términos (Fase 27, dato con valor legal).

- [ ] Activar los backups automáticos del proveedor de Postgres y confirmar la retención.
- [ ] **Probar una restauración una vez**, antes de lanzar. Un backup no verificado no es un backup.

---

## 🟠 Alto — arreglar antes de abrir al público

### 8. ~~Swagger UI y el spec crudo son públicos en producción~~ ✅ Cerrado el 2026-08-24

Las dos rutas van envueltas en `if (apiDocsEnabled())` (`src/utils/env.ts` → `src/app.ts`):
**apagadas en producción**, encendidas en dev y test, y `API_DOCS_ENABLED=true` las reabre sin
tocar código (útil para depurar contra el despliegue real). Sin montar, caen en el 404 por defecto
de Express.

Se descartó `requireAuth`: el navegador no manda `Authorization` al pedir los assets de Swagger UI
ni el spec, así que la interfaz quedaría rota. Verificado a mano con `NODE_ENV=production`
(404 en ambas / 200 con la variable) y cubierto por `tests/unit/config/apiDocs.test.ts`.

### 9. ~~`PENDING_ORDER_*` se saltan `positiveNumberEnv`~~ ✅ Cerrado el 2026-08-24

Las dos pasaron a `positiveNumberEnv` en `src/config/stripe.ts`. Ya **no queda ningún**
`Number(process.env…)` sin proteger en el repo. `tests/unit/config/stripe.test.ts` cubre los dos
valores que antes se colaban (`""` → `0` y `"abc"` → `NaN`) más `"0"`/`"-5"`.

De paso se arregló el `afterEach` de esa misma suite, que restauraba las variables con
`process.env[k] = undefined` — eso guarda la **cadena** `"undefined"`, no borra la variable, y
dejaba basura en el entorno para las suites siguientes.

### 10. ~~Versión de Node sin fijar (y la documentada rompe el apagado ordenado)~~ ✅ Cerrado el 2026-08-24

`package.json` declara `"engines": { "node": ">=22" }` (la versión del CI) y `README.md` §Requisitos
dice ya "Node.js 22+", con la nota de que el mínimo real es 19 por el apagado ordenado. De paso se
corrigió ahí `pnpm@11.8.0` → `pnpm@11.20.0`, una de las desalineaciones listadas más abajo.

### 11. ~~Faltan índices en `orders` para las consultas calientes~~ ✅ Cerrado el 2026-08-24

Migración `20260824120000-orders-hot-query-indexes.ts`, declarados también en `Order.init()` (el
esquema de los tests sale de `sync({ force: true })`, no de las migraciones):

| Índice | Columnas | Quién lo usa |
| --- | --- | --- |
| `orders_payment_intent_id` | `paymentIntentId`, parcial `IS NOT NULL` | cada evento del webhook de Stripe y cada disputa |
| `orders_skydropx_shipment_id` | `skydropxShipmentId`, parcial `IS NOT NULL` | cada evento del webhook de Skydropx + la reconciliación |
| `orders_payment_status_created_at` | `("paymentStatus", "createdAt")` | dashboard, reportes y `recentSales` |
| `orders_status_created_at` | `("status", "createdAt")` | `pendingOrderSweeper` y `pendingShipmentWhere` |

Los dos primeros son **parciales** porque esas columnas solo se consultan por valor exacto, nunca
por `IS NULL`, y están en `null` en buena parte de las filas. Los dos últimos son **compuestos con
`createdAt`** y no sobre la columna de estado a secas —como decía este hallazgo— porque los cuatro
llamadores combinan siempre el estado con una ventana de fechas y ordenan por ella.

Verificado con `pnpm migrate` → `pnpm migrate:undo` → `pnpm migrate` contra la base de desarrollo
(el `down` quita exactamente esos cuatro y nada más). `tests/integration/orderIndexes.test.ts` lee
`pg_indexes` para atrapar la deriva entre la migración y `Model.init`.

### 12. El estado en memoria obliga a **una sola instancia**

Cuatro cosas viven en memoria del proceso y no se comparten entre réplicas ni sobreviven un reinicio:

1. Los cinco `express-rate-limit` (store por defecto en memoria).
2. La idempotencia del checkout y de la importación masiva (`src/utils/idempotency.ts`, decisión
   deliberada y documentada).
3. El contador de fallos consecutivos de `pendingOrderSweeper`.
4. La caché de 1 s de `checkReadiness`.

Además, **los tres crons** (`pendingOrderSweeper`, `shipmentRetrySweeper`, `dailySalesDigest`) arrancan
en cada proceso: con dos réplicas, el resumen diario se manda dos veces y dos barridos compiten por los
mismos pedidos (los guards atómicos evitan el daño, pero no el ruido).

Para esta tienda una sola instancia sobra. Lo que falta es **que sea una decisión explícita y no un
accidente**:

- [ ] Fijar el servicio en 1 instancia en el proveedor y anotarlo.
- [ ] Si algún día se escala horizontalmente: rate limiters a Redis, y los crons a un proceso aparte
      o con un lock en la base de datos.

### 13. Conexión a Postgres sin SSL explícito

`src/config/database.ts` y `src/config/sequelize-cli.js` no configuran `dialectOptions.ssl`. La mayoría
de los Postgres gestionados exigen TLS y varios usan certificado autofirmado (`rejectUnauthorized`).

- [ ] Verificar que el `DATABASE_URL` de producción conecta (`sslmode=require` en la cadena suele
      bastar); si el proveedor usa certificado propio, agregar `dialectOptions` **en los dos archivos**
      — el CLI de migraciones no comparte configuración con la app.

### 14. ~~Cliente de Stripe sin `apiVersion` fijada~~ ✅ Cerrado el 2026-08-24

`src/config/stripe.ts` exporta `STRIPE_API_VERSION = "2026-06-24.dahlia"` y se la pasa al
constructor. **Es un no-op en runtime**: el SDK ya mandaba esa misma versión por su cuenta
(`props.apiVersion || DEFAULT_API_VERSION`), no la del dashboard. Lo que compra es el fail-fast del
tipo — `StripeConfig.apiVersion` está tipado con el literal exacto de la versión del SDK, así que un
`pnpm update` de `stripe` que la mueva **rompe `pnpm build`** y obliga a revisar el changelog en vez
de cambiar en silencio la forma de los objetos que leen los handlers del webhook.

---

## 🟡 Medio — conviene, no bloquea

- [ ] **No hay linter.** `README.md` y `CLAUDE.md` lo reconocen ("No linter is configured yet"). El
      frontend sí tiene `eslint.config.mjs`. Agregar ESLint + Prettier y meterlo al CI.
- [ ] **Rate limit del catálogo público** — pendiente heredado de la Fase H.3: `GET /api/products` y
      `GET /api/products/:id` no tienen límite. El propio roadmap pide **medir tráfico real primero**,
      porque un límite mal calibrado castiga a compradores legítimos. Sigue siendo el orden correcto.
- [ ] **Monitoreo de uptime.** Sentry captura excepciones, pero nadie avisa si el proceso está caído o
      si `/health/ready` lleva 10 minutos en `503`. Un chequeo externo gratuito (UptimeRobot o el del
      propio PaaS) apuntando a `/health/ready` cierra el hueco.
- [ ] **Sentry en producción:** confirmar que `environment` queda en `production` (sale de `NODE_ENV`,
      hoy `development`) y valorar subir *release* + sourcemaps — sin ellos, los stacktraces de `dist/`
      apuntan a JS compilado.
- [x] ~~**Trabajo sin commitear.**~~ **Cerrado el 2026-08-24** en el commit `04d9030` (`docs: extrae las
      features de CLAUDE.md a docs/ y archiva el roadmap activo`), ya pusheado a `origin/main`: los 11
      archivos de `docs/features/` + este mismo checklist quedaron versionados, `CLAUDE.md` con la
      extracción y `roadmap-operacion-y-negocio.md` registrado en `roadmaps-completados/`. El árbol
      está limpio, así que la documentación sí existe en el repo remoto.
- [ ] **Desalineaciones de documentación** (rápidas):
  - ~~`packageManager` real es `pnpm@11.20.0`; `README.md` y `CLAUDE.md` dicen `11.8.0`.~~
    Corregido en ambos el 2026-08-24, junto con el punto 10.
  - `BCRYPT_ROUNDS` se usa (`src/utils/password.ts`) y está en `.env` y en el CI, pero **no aparece en
    la lista de variables del `README.md`**.
  - El checklist de `roadmap-operacion-y-negocio.md` sigue con "Dominio verificado en Resend" sin
    palomear, cuando el `README.md` documenta que ya se hizo (2026-08-19).
  - `README.md` no tiene sección de **Despliegue**. Al cerrar los puntos 1–7, escribirla.

---

## ⚪ Decisiones de negocio pendientes (no son de código)

- **Facturación CFDI (Fase N.5)** — `roadmaps-completados/roadmap-operacion-y-negocio.md` §N.5. Está
  marcada `[evaluar antes de comprometer]` y depende del contador: la venta en línea se da de alta
  como actividad fiscal aparte, con retención de IVA/ISR por la plataforma, y falta el texto de la
  política de facturación. **Puede volverse urgente por razones ajenas al código**; no bloquea el
  lanzamiento técnico.
- **Buzón real en `@botasdonchuy.com`** — hoy solo se puede *enviar*. El plan (Google Workspace
  Business Starter) está escrito paso a paso en `README.md` §Dominio. No bloquea: ningún correo del
  sistema espera respuesta, pero un cliente que responda a `no-reply@` no le llega a nadie.

---

## Decisiones deliberadas — no las "arregles"

Para que nadie las levante como hallazgo en la siguiente revisión:

- **No hay `AuditLog`.** La tienda la operan dos personas con permisos idénticos por diseño; no hay
  para quién auditar. Revisar solo si eso cambia.
- **`owner` y `admin` tienen exactamente los mismos permisos.** `requireRole` existe pero no se usa.
- **`GET /health` no toca la base de datos.** Es liveness: si la tocara, un parpadeo de Postgres
  provocaría un *reinicio* en vez de sacar la instancia de rotación.
- **La idempotencia del checkout no se persiste.** Protege del accidente (doble clic), no del abuso
  — contra eso están `orderRateLimiter` y los índices únicos.
- **El correo de confirmación no imprime el número de pedido.** `Order.id` es la secuencia global de
  la tienda, no la del comprador.
- **Una disputa no cancela el pedido ni repone stock.** La mercancía pudo haber salido ya; esa
  decisión sigue siendo del dueño.

---

## Orden sugerido de ejecución

1. ~~Commitear lo que está sin trackear (`docs/`, `CLAUDE.md`, el roadmap movido) — punto 🟡.~~
   ✅ **Hecho** (commit `04d9030`, pusheado a `origin/main`).
2. ~~Arreglos de código, que son chicos y entran en un commit: **9** (`positiveNumberEnv`),
   **10** (`engines`), **11** (índices), **8** (gate de Swagger), **14** (`apiVersion`). Con sus tests.~~
   ✅ **Hecho** el 2026-08-24: los cinco, con 35 tests nuevos (60 suites / 787 en total), la
   migración probada de ida y vuelta y el gate comprobado a mano con `NODE_ENV=production`.
3. Crear `.env.example` (**1**) y el script de bootstrap del admin (**6**).
4. Dar de alta el servicio y la base de datos en el proveedor; resolver **5** (migraciones en el
   pipeline), **13** (SSL) y **7** (backups + una restauración de prueba).
5. Cargar las variables de producción (**2**) con `TRUST_PROXY=1` (**4**), desplegar y comprobar
   `/health/ready`.
6. Configurar los webhooks de Stripe live y Skydropx producción (**3**) y probar de punta a punta:
   una compra real de bajo monto → correo de confirmación → guía → correo "va en camino" → una disputa
   de prueba.
7. Fijar 1 instancia (**12**), enchufar el monitoreo de uptime y escribir la sección de Despliegue
   del `README.md`.
