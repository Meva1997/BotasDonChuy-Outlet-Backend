# ROADMAP — Hardening operativo del backend

Hoja de ruta para atacar los huecos de "higiene operativa" que ningún roadmap de features cubre:
testing, migraciones, rate limiting, logging/observabilidad, apagado ordenado y gestión manual de
órdenes. Detectados en una revisión del estado del proyecto (2026-07-22), con [ROADMAP.md](ROADMAP.md)
y [roadmap-skydropx.md](roadmap-skydropx.md) prácticamente cerrados.

> **Cómo usarlo:** igual que los otros roadmaps — marca `[x]` cada tarea al completarla, en orden de
> fases (H.1 → H.6). No están estrictamente encadenadas entre sí como Skydropx, pero **sí tienen un
> orden de riesgo**: empieza por H.1/H.2 si el siguiente paso real es un deploy a producción.

---

## Por qué este documento existe

El resto del roadmap mide features ("¿funciona el checkout?", "¿llega el correo?"). Este mide
**qué tan seguro es operar esto en producción sin que Alex tenga que estar viendo logs a mano**.
Ninguno de estos puntos bloquea el lanzamiento del core, pero varios (H.1, H.3) sí deberían
resolverse **antes** del primer deploy a producción real con clientes pagando.

---

## Estado actual (de un vistazo)

| Punto | Estado | Riesgo si no se atiende |
|---|---|---|
| Tests automatizados | ❌ `pnpm test` es un placeholder | Regresión silenciosa en stock atómico, webhooks, totales |
| Migraciones de esquema | ❌ solo `sync({ alter: true })` en dev | Sin forma segura de versionar el esquema en producción |
| Rate limit en `POST /api/orders` | ❌ ausente | Un bot puede crear PaymentIntents/órdenes `pending` sin límite |
| Logging estructurado / monitoreo de errores | ❌ solo `console.*` (37 usos) | Un webhook que empieza a fallar pasa desapercibido |
| Apagado ordenado (`SIGTERM`/`SIGINT`) | ❌ ausente | Redeploys pueden cortar conexiones de BD a medio transaction |
| Cancelación/reembolso manual de orden (admin) | ❌ ausente | Sin vía para atender "cancela mi pedido" fuera del webhook de Stripe |
| Dominio verificado en Resend | ⏳ pendiente (manual, ya en `ROADMAP.md` §9) | Emails a clientes reales siguen bloqueados (403 fuera de la cuenta) |

---

## Mapa de fases

### Fase H.1 — Tests automatizados

**Objetivo:** cubrir la lógica que más cuesta romper en silencio, no perseguir 100% de cobertura.

**Por qué primero:** es el único punto que protege contra que un cambio futuro (tuyo o mío) rompa
algo que ya funciona — stock atómico, idempotencia de webhooks, recálculo de totales — sin que nadie
se entere hasta que un cliente se queje.

**Elección de herramientas (decidido):** `jest` + `ts-jest` + `supertest`, no `vitest`. Vitest sería
técnicamente válido (no es una herramienta de frontend pese al nombre — corre en entorno Node por
defecto), pero **Jest + Supertest es el combo que domina las vacantes de Node/Express** y el que
cualquiera que audite este repo va a reconocer de inmediato (`request(app).post('/api/orders')...`
es casi el estándar de facto para probar rutas HTTP en Express). Se prioriza la señal de mercado
sobre la fricción extra de configurar `ts-jest` con `strict` mode.

**Tareas:**
- [ ] Instalar `jest` + `ts-jest` + `@types/jest` + `supertest` + `@types/supertest`. Reemplazar el
  placeholder de `pnpm test` (`jest.config.ts` con el preset `ts-jest`).
- [ ] Setup de BD de pruebas: un `DATABASE_URL` de test separado (Postgres real, no sqlite — el
  código depende de features Postgres-específicas: `ENUM`, `JSONB`, `literal('stock - N')`) +
  helper (`globalSetup`/`beforeEach` de Jest) que corre `sequelize.sync({ force: true })` antes de
  cada suite y limpia entre tests.
- [ ] **Servicios puros primero** (sin BD, el ROI más alto):
  - [ ] `src/services/cart.ts` — `computeTotals`, `computeShipping`.
  - [ ] `src/services/forecast.ts` — los 3 modos (1-2 meses, 3, 4+).
  - [ ] `src/utils/formatMoney.ts`, `src/utils/date.ts` (`isoDay`/`isoMonth`/formatters UTC).
- [ ] **Integración de checkout** (con `supertest` contra el `app` exportado de `src/app.ts`, BD real
  de test):
  - [ ] Descuento atómico de stock: dos requests concurrentes por el último par → una `201`, una `409`.
  - [ ] Totales recalculados ignoran montos que mande el cliente.
  - [ ] `quotationId`/`rateId` ambos-o-ninguno (el `.refine()` de `createOrderSchema`).
- [ ] **Idempotencia de webhooks** (el punto más frágil del código, por diseño):
  - [ ] `markOrderPaidFromWebhook`: dos llamadas concurrentes → un solo `affectedCount === 1`, un
    solo correo (mock de `sendEmail`, no llamar a Resend real).
  - [ ] `createShipmentForOrder`: el guard de centinela `"creating"` — dos llamadas concurrentes →
    una sola llega a llamar a Skydropx (mock del `fetch`, no gastar saldo real).
  - [ ] `applyShipmentUpdateFromWebhook`: un evento fuera de orden no retrocede `Order.status`.
- [ ] **Auth**: login con password correcta/incorrecta devuelven el mismo mensaje; `assertValidResetCode`
  agota intentos y bloquea.
- [ ] Wire a CI (ver Fase H.6) para que corran en cada PR, no solo localmente.

**Cómo verificar:** `pnpm test` corre una suite real y falla si alguien rompe el descuento atómico
de stock o la idempotencia de un webhook (probarlo a propósito: comentar el `WHERE` del `UPDATE`
condicional y confirmar que el test lo detecta).

---

### Fase H.2 — Migraciones de esquema

**Objetivo:** una forma versionada y reproducible de cambiar el esquema en producción, sin depender
de `sync({ alter: true })` (gateado a `NODE_ENV === "development"` a propósito — ver `database.ts`).

**Por qué ahora:** cada modelo nuevo hasta hoy se creó confiando en el `alter: true` de dev y
replicando el cambio "a mano" en producción (o nunca desplegando producción todavía). Eso no escala
más allá de un solo desarrollador con memoria perfecta.

**Tareas:**
- [ ] Adoptar `sequelize-cli` (ya viene con `sequelize` 6, cero dependencias nuevas) o `umzug`
  (más ligero, sin generador de código) — decidir según cuánto control fino se quiera sobre el SQL.
- [ ] `src/migrations/` con una migración por cambio de esquema ya aplicado, reconstruyendo el
  historial actual desde el primer modelo (`Product`) hasta la última columna de Skydropx —
  así el repo queda con un punto de partida limpio en vez de mezclar "migraciones nuevas" sobre
  un esquema que nunca pasó por una.
- [ ] Script `pnpm migrate` (aplicar pendientes) y `pnpm migrate:undo` en `package.json`.
- [ ] Documentar en `CLAUDE.md`: **"cuando agregues una columna/tabla, escribe la migración —
  no confíes en que `alter: true` la replique en producción."**
- [ ] Decidir si `sync({ alter: true })` se apaga por completo en dev también (usar migraciones
  ahí igual, para que dev y prod compartan el mismo camino) o se deja como conveniencia de
  desarrollo rápido mientras las migraciones son la única vía hacia producción.

**Cómo verificar:** una BD de producción vacía llega al esquema actual completo corriendo solo
`pnpm migrate`, sin tocar código de la app.

---

### Fase H.3 — Rate limiting en `POST /api/orders`

**Objetivo:** que el checkout público tenga el mismo tipo de protección que ya tienen
`/api/auth/login` y `/api/shipping/rates`.

**Por qué ahora:** es la ruta pública más cara de abusar — cada request exitoso crea un
PaymentIntent real en Stripe y una fila `Order` (aunque el `pendingOrderSweeper` la libere a los
`PENDING_ORDER_TTL_MINUTES`, un flood sostenido satura la tabla y el rate limit de la cuenta Stripe).

**Tareas:**
- [x] `orderRateLimiter` en `src/middlewares/rateLimit.ts` (mismo patrón que `shippingRateLimiter`) —
  un límite generoso pero real, p. ej. 10 req/min por IP (un comprador legítimo no manda más de
  1-2 checkouts por minuto; ajustar según datos reales una vez que haya tráfico).
- [x] Aplicar en `src/routes/order.routes.ts` solo a la ruta pública `POST /`, no a las de
  `adminOrder.routes.ts` (esas ya están detrás de `requireAuth`).
- [ ] Evaluar si también aplica a `GET /api/products`/`GET /api/products/:id` (catálogo público sin
  límite hoy) — separar en su propia tarea si el volumen de tráfico lo justifica; no bloquea esta fase.

**Cómo verificar:** 11 requests en un minuto contra `POST /api/orders` desde la misma IP → la 11
recibe `429`, no `201`/`400`.

---

### Fase H.4 — Logging estructurado y monitoreo de errores

**Objetivo:** que un webhook o cron que empieza a fallar seguido se note sin tener que grepear logs
de texto plano a mano.

**Por qué ahora:** con Stripe + Skydropx + Resend + el sweeper corriendo en background, hay 4
sistemas externos que pueden fallar de forma silenciosa (todos estos flujos están diseñados para
"logear y continuar", a propósito — pero eso solo es seguro si alguien lee ese log).

**Tareas:**
- [ ] Reemplazar `console.log`/`console.error` sueltos (37 usos) por un logger estructurado
  (`pino` — rápido, JSON por línea, bajo overhead) con niveles (`info`/`warn`/`error`).
- [ ] Contexto mínimo en cada log de los flujos críticos: `orderId`, `paymentIntentId`/
  `skydropxShipmentId`, nombre del evento de webhook.
- [ ] Integrar un servicio de error tracking (Sentry, tier gratis alcanza para este volumen) en el
  `errorHandler` (`src/middlewares/errorHandler.ts`) para los 500 no manejados, y en los catches
  silenciosos de `payment.service.ts`/`skydropx.service.ts` que hoy solo loguean.
- [ ] Alerta (puede ser tan simple como un correo vía Resend, o un webhook a Slack/Discord) cuando
  `pendingOrderSweeper` encuentra una orden que Stripe reporta como fallida repetidamente, o cuando
  `createShipmentForOrder` agota reintentos.

**Cómo verificar:** forzar un fallo controlado (p. ej. apagar `SKYDROPX_CLIENT_SECRET` temporalmente
en un entorno de prueba) y confirmar que aparece en Sentry/el canal de alertas, no solo en stdout.

---

### Fase H.5 — Apagado ordenado y gestión manual de órdenes

**Objetivo:** dos mejoras independientes de robustez operativa, agrupadas porque ninguna justifica
una fase propia.

**Tareas — apagado ordenado:**
- [ ] Manejar `SIGTERM`/`SIGINT` en `src/app.ts`: dejar de aceptar conexiones nuevas
  (`server.close()`), esperar requests en vuelo, cerrar el pool de Sequelize
  (`sequelize.close()`) y detener el timer del `pendingOrderSweeper` antes de salir — hoy un
  redeploy puede cortar una transacción de checkout a medias.

**Tareas — cancelación/reembolso manual (admin):**
- [ ] `POST /api/admin/orders/:id/cancel` `[auth]`: para una orden `pending` o `paid` que el cliente
  pidió cancelar fuera del flujo normal (WhatsApp, llamada). Debe reusar
  `orders.service.releaseOrderStock` para `pending`; para `paid` necesita además llamar a
  `stripe.refunds.create` (reembolso real) antes de restockear — **no existe hoy ningún camino de
  reembolso en el código**, ni parcial ni total.
  - [ ] Zod schema propio (`cancelOrderSchema`, quizás con `reason` opcional para el registro).
  - [ ] `409` si la orden ya está `cancelled`/`delivered` (no tiene sentido cancelar dos veces ni
    después de entregada).
- [ ] Documentar en Swagger (`src/config/swagger.ts`) igual que el resto de rutas admin, por el
  Workflow de `CLAUDE.md`.

**Cómo verificar:** matar el proceso con `SIGTERM` durante un checkout en curso (agregar un
`await sleep()` temporal para ensanchar la ventana) → la transacción termina o hace rollback limpio,
nunca deja una fila a medias. `POST /api/admin/orders/:id/cancel` sobre una orden `paid` → aparece el
reembolso en el dashboard de Stripe test y el stock se restablece.

---

### Fase H.6 — CI

**Objetivo:** que H.1 (tests) se ejecute automáticamente, no solo cuando alguien se acuerda de
correrlo local.

**Tareas:**
- [ ] GitHub Actions: workflow que en cada PR levanta un contenedor Postgres de servicio,
  corre `pnpm install`, `pnpm build` (`tsc --noEmit` ya detecta errores de tipos) y `pnpm test`.
- [ ] Bloquear merge a `main` si el workflow falla (branch protection — paso manual en GitHub, no
  de código).

**Cómo verificar:** abrir un PR con un test roto a propósito → el check de GitHub lo marca en rojo
antes de que se pueda mergear.

---

## Notas

- **Ninguna fase de este documento bloquea features nuevas.** Si aparece trabajo de negocio urgente
  (otra fase de `ROADMAP.md`, o algo que pida el dueño de la tienda), pasa primero — este documento
  es para huecos que importan más entre más tráfico real reciba la tienda, no antes.
- **H.1 y H.3 son las de mayor relación impacto/esfuerzo** si el próximo paso real es un deploy a
  producción con clientes pagando de verdad.
- La verificación de dominio en Resend (para que los correos lleguen a clientes reales, no solo a la
  cuenta) ya está trackeada en [ROADMAP.md](ROADMAP.md) §Fase 9 — no se duplica aquí.

## Checklist maestro

**Fase H.1 — Tests**
- [ ] Jest + ts-jest + Supertest instalados + BD de test
- [ ] Servicios puros (`cart`, `forecast`, `formatMoney`, `date`)
- [ ] Integración de checkout (stock atómico, totales, refine de shipping)
- [ ] Idempotencia de webhooks (pago, guía, estado de envío)
- [ ] Auth (login, reset code)

**Fase H.2 — Migraciones**
- [ ] Herramienta elegida (`sequelize-cli` / `umzug`)
- [ ] Historial reconstruido en `src/migrations/`
- [ ] Scripts `pnpm migrate`/`migrate:undo`
- [ ] `CLAUDE.md` actualizado con la nueva convención

**Fase H.3 — Rate limit en checkout**
- [x] `orderRateLimiter` en `POST /api/orders`

**Fase H.4 — Logging y monitoreo**
- [ ] Logger estructurado (`pino`) reemplazando `console.*`
- [ ] Error tracking (Sentry) en `errorHandler` y catches silenciosos
- [ ] Alertas para fallos repetidos de Skydropx/sweeper

**Fase H.5 — Apagado ordenado + cancelación manual**
- [ ] `SIGTERM`/`SIGINT` cierran servidor, pool y sweeper
- [ ] `POST /api/admin/orders/:id/cancel` con reembolso Stripe

**Fase H.6 — CI**
- [ ] Workflow de GitHub Actions con Postgres de servicio + `pnpm test`
- [ ] Branch protection en `main`
