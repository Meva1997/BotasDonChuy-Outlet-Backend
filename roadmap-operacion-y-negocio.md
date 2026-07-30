# ROADMAP — Cierre operativo y features de negocio

Hoja de ruta activa del backend, abierta el **2026-07-28** con los cuatro roadmaps anteriores ya
cerrados y archivados en [`roadmaps-completados/`](roadmaps-completados/roadmap-readme.md). Cubre dos cosas
distintas que conviene no mezclar:

- **Bloque O (operativo)** — huecos donde el dueño de la tienda se queda **atorado sin poder hacer
  nada desde el panel**, o donde un accidente del cliente cuesta dinero. No son features: son
  caminos que el código abre y nunca cierra.
- **Bloque N (negocio)** — features que no existen y que mueven ventas o dan visibilidad real.

> **Cómo usarlo:** igual que los otros roadmaps — marca `[x]` cada tarea al completarla. El
> **bloque O va antes del lanzamiento (1 de octubre)** y en el orden O.1 → O.5, que es orden de
> riesgo real. El **bloque N no tiene orden obligatorio**: se toma la fase que el negocio pida.

---

## Por qué este documento existe

Los roadmaps anteriores midieron "¿funciona?". Este mide **"¿y cuando no funciona, qué hace el
dueño?"**. La integración con Skydropx y Stripe está completa para el camino feliz, pero cada una
tiene un desvío (paquetería caída, guía que falla, doble clic del cliente) donde el sistema queda
en un estado del que **no existe salida por código** — solo entrar a la base de datos a mano.

El caso más claro: el enum `Order.status` incluye `shipped` y `delivered`, pero **ninguna ruta del
panel puede llegar a ellos**. Si el pedido no trae guía de Skydropx, el webhook nunca llega y la
orden se queda en `paid` para siempre, sin correo de "va en camino" y sin forma de corregirlo.

---

## Estado actual (de un vistazo)

| Punto | Estado | Riesgo si no se atiende |
|---|---|---|
| Marcar un pedido como enviado/entregado a mano | ✅ **Fase O.1** (`PATCH /api/admin/orders/:id/status`) | — (falta cablear el botón en el panel: Fase 14 del roadmap del frontend) |
| Reintentar una guía de Skydropx fallida | ✅ **Fase O.3** (`POST /api/admin/orders/:id/shipment/retry` + barrido automático) | — (falta cablear el botón en el panel: Fase 16 del roadmap del frontend) |
| Idempotencia en `POST /api/orders` | ✅ **Fase O.2** (ventana de 60 s + header `Idempotency-Key`) | — (opcional: mandar el header desde `usePlaceOrder.ts`, Fase 15 del roadmap del frontend) |
| Consulta de pedido por el cliente | ✅ **Fase O.4** (`GET /api/orders/lookup/:token`) | — (falta la página de seguimiento en el front: Fase 17 del roadmap del frontend) |
| Readiness real en `/health` | ✅ **Fase O.5** (`GET /health/ready`) | — (falta apuntar el probe del orquestador a la ruta nueva al desplegar) |
| Búsqueda/orden en el catálogo | ✅ **Fase N.1** (`q`, `orden`, `precioMin`/`precioMax`) | — (falta cablear buscador y selector de orden en el front: Fase 18 del roadmap del frontend) |
| Cupones / códigos de descuento | ✅ **Fase N.2** (`POST /api/coupons/validate` + CRUD admin + canje atómico) | — (falta el campo en el checkout y la sección del panel: Fase 19 del roadmap del frontend) |
| Gastos reales (vs. `GASTOS_FIJOS` hardcodeado) | ❌ constante de `$2,000` | El KPI de utilidad del dashboard es ficción |
| Aviso al dueño de venta nueva | ❌ solo hay alertas de falla | Se entera de un pedido pagado hasta que abre el panel |
| Bitácora de auditoría admin | ❌ ausente | `owner` y `admin` tienen permisos idénticos y no queda rastro de quién borró o canceló qué |
| Facturación CFDI | ❌ ausente | En México se la van a pedir tarde o temprano |

---

## Reglas que aplican a todas las fases

Para no repetirlas once veces. Vienen de la sección **Workflow** de [`CLAUDE.md`](CLAUDE.md):

1. **Ruta nueva o cambiada** → bloque JSDoc `@openapi` **antes** de commitear, y los `components.schemas`
   nuevos en `src/config/swagger.ts`.
2. **Columna o modelo nuevo** → migración en `src/migrations/` **en el mismo commit**. No hay
   `sync({ alter: true })` de respaldo en ningún ambiente. Ojo con las que declaran índices: hay que
   replicarlos también en el `Model.init()` porque `tests/setup/db.ts` arma el esquema con
   `sync({ force: true })`, no con migraciones.
3. **Algo que el frontend consuma** → nueva fase 🔴 **Pendiente** en
   `../frontend/ROADMAP-BACKEND-INTEGRATION.md` + fila en su tabla de endpoints. Documentación
   nada más: **no se escribe código de frontend** salvo que se pida.
4. **Tests** → cada fase suma su parte a `tests/`. Stripe, Skydropx y Resend **siempre mockeados**;
   la BD **nunca** se mockea.
5. **Mensajes de error** → frase completa en español, accionable, que nombre la entidad. El `message`
   es la copia de UI que pinta el front tal cual.

---

# BLOQUE O — Cierre operativo (antes del 1 de octubre)

### Fase O.1 — Estados de envío manuales ✅ `[el hueco más grande]`

**Objetivo:** que el dueño pueda mover un pedido a `shipped`/`delivered` desde el panel y pegarle
una guía capturada a mano.

**Por qué primero:** hoy `Order.status` solo avanza a `shipped`/`delivered` desde
`applyShipmentUpdateFromWebhook`, o sea **únicamente** cuando Skydropx reporta un envío que Skydropx
creó. Si en el checkout la cotización en vivo falló y se cayó al fallback de tarifa plana, la orden
nace sin `skydropxRateId` → `createShipmentForOrder` se salta la guía a propósito → nunca hay
`skydropxShipmentId` → el webhook nunca llega → la orden se queda en `paid` **para siempre**, el
cliente nunca recibe el correo de "tu pedido va en camino" y el dashboard cuenta como pendientes
pedidos que ya se entregaron. El fallback de envío está diseñado para que la tienda nunca deje de
vender; el precio es que ese pedido sale del flujo automático y **hoy no hay puerta de regreso**.

**Diseño (decidido):**
- `PATCH /api/admin/orders/:id/status` `[auth]`, body
  `{ status: "shipped" | "delivered", trackingNumber?, trackingUrl?, shippingCarrier? }`.
- **Cero columnas nuevas.** `trackingNumber`/`trackingUrl`/`shippingCarrier`/`shipmentStatus` ya
  existen en `Order` desde la Fase 8.5/8.6. Sin migración.
- **Solo hacia adelante**, reusando `advanceOrderStatus` (`payment.service.ts`) con su rango
  `pending < paid < shipped < delivered`. Un `PATCH` que intente retroceder responde `409`. No es
  rigidez gratuita: si se permitiera retroceder, un webhook tardío de Skydropx y un clic del dueño
  podrían pelearse por el estado sin un ganador determinista.
- **`cancelled` NO se toca aquí.** Sigue siendo exclusivo de `POST /api/admin/orders/:id/cancel`,
  que es el único camino que reembolsa y restockea. Un `PATCH` a `cancelled` sería una cancelación
  silenciosa sin devolver el dinero.
- El correo de envío se dispara con **el mismo guard atómico** que ya usa el webhook
  (`Order.update({ trackingNumber }, { where: { id, trackingNumber: null } })` → solo si
  `affected === 1`). Así da igual si el tracking lo puso el webhook o el dueño: el correo sale
  **exactamente una vez** por pedido, y los dos caminos no pueden duplicarlo.
- Marcar `delivered` **sin** tracking es válido (entrega en mano/local); en ese caso no hay correo
  de envío que mandar.

**Tareas:**
- [x] `orderStatusUpdateSchema` en `src/schemas/checkout.ts` (o `src/schemas/order.ts` si crece):
  `status` restringido a `shipped`/`delivered`, tracking opcional, `trackingUrl` validada como URL.
- [x] `orders.service.ts`: `updateOrderStatusByAdmin(id, payload)` — valida la transición con
  `advanceOrderStatus`, persiste, reclama el correo con el guard atómico de `trackingNumber`.
- [x] `adminUpdateOrderStatus` en `order.controller.ts` (`parseId`, `asyncHandler`, `AppError`).
- [x] Ruta en `adminOrder.routes.ts` + bloque `@openapi`.
- [x] Tests de integración: transición válida; retroceso → `409`; `cancelled` rechazado; correo una
  sola vez cuando webhook y `PATCH` compiten por el mismo tracking.
- [x] Fase 🔴 en `../frontend/ROADMAP-BACKEND-INTEGRATION.md` (el panel necesita el botón).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- No existía una función llamada `advanceOrderStatus`: la regla "solo hacia adelante" vivía como
  `ORDER_STATUS_RANK` + `statusesBelow` dentro de `payment.service.ts`. Se **exportaron** esas dos
  (junto con `sendShipmentEmail`) y `orders.service.ts` las importa, en vez de duplicar el rango.
  No hay ciclo: `payment.service` nunca importa `orders.service`.
- **Repetir el estado actual sí se permite** (no solo avanzar): es la única forma de pegarle una guía
  a un pedido que ya se marcó `shipped` sin ella. Retroceder sigue siendo `409`.
- **Un pedido `pending` no se puede enviar** (`409`), aunque `pending → shipped` sea "hacia adelante"
  por rango: todavía no hay cobro capturado, su stock sigue reservado y `pendingOrderSweeper`
  acabaría cancelando el PaymentIntent de un pedido ya en camino.
- Tests: `tests/integration/adminOrderStatus.test.ts` (11 casos, nivel 2 — HTTP contra Postgres real,
  solo `email.service` mockeado). El caso de la carrera corre el `PATCH` por HTTP y
  `applyShipmentUpdateFromWebhook` por servicio dentro del mismo `Promise.all`.

**Cómo verificar:** crear un pedido forzando el fallback de tarifa plana (con Skydropx apagado en
`.env` o mockeado a error), pagarlo con `stripe trigger payment_intent.succeeded`, confirmar que
queda en `paid` sin guía, y llevarlo a `shipped` con el `PATCH` → llega el correo de envío con el
tracking capturado y el dashboard deja de contarlo como pendiente.

---

### Fase O.2 — Idempotencia en `POST /api/orders` ✅

**Objetivo:** que un doble clic o un reintento del navegador no cree dos pedidos.

**Por qué ahora:** es la ruta que mueve dinero y es la **única** entrada crítica sin protección
contra reenvío. `POST /api/admin/products/import` —que no cobra nada— sí la tiene
(`assertNotDuplicateCommit`, 409 dentro de 60 s). En el checkout, un segundo request idéntico crea
otra fila `Order`, otro PaymentIntent real en Stripe y **descuenta el stock otra vez**; ese stock
duplicado no se libera hasta que el `pendingOrderSweeper` corra sobre una orden con más de
`PENDING_ORDER_TTL_MINUTES` (30) de antigüedad — o sea 30–40 minutos con inventario fantasma
bloqueado, justo en el momento de mayor tráfico. `orderRateLimiter` (10 req/min) no lo cubre: dos
clics están muy por debajo del límite.

**Diseño (decidido):**
- **Devolver la orden existente con su `clientSecret`, no un `409`.** Aquí está la diferencia con el
  import: el cliente está esperando para pagar. Un `409` lo deja sin poder completar la compra y
  además con stock ya apartado a su nombre. La respuesta correcta al reenvío es la **misma respuesta
  del original**.
- **Dos capas.** (1) Piso sin tocar el frontend: hash sha256 de `(items normalizados + customer)`
  con ventana corta, mismo patrón en memoria que `assertNotDuplicateCommit`. (2) Cuando el front lo
  soporte, header `Idempotency-Key` explícito, que es lo correcto a largo plazo y lo que ya usa
  Stripe internamente para el refund.
- **En memoria, no persistido** — misma decisión y misma limitación asumida que
  `assertNotDuplicateCommit` y que el contador de fallos de `pendingOrderSweeper`: se reinicia con el
  proceso y no cubre varias instancias. Protege del accidente, no del abuso; la barrera dura contra
  el abuso sigue siendo `orderRateLimiter`.

**Tareas:**
- [x] Helper compartido de idempotencia (extraer el patrón de `productImport.service.ts` a
  `src/utils/idempotency.ts` para no tener dos `Map` con TTL copiados).
- [x] Aplicarlo en `orders.service.createOrder`, cacheando `{ order, clientSecret }` del original.
- [x] Aceptar el header `Idempotency-Key` cuando venga y darle prioridad sobre el hash.
- [x] Tests: dos `POST` idénticos concurrentes → una sola fila `Order`, un solo PaymentIntent
  (mock de Stripe), stock descontado **una** vez, y el mismo `clientSecret` en ambas respuestas.
- [x] Fase 🔴 en el roadmap del frontend (mandar `Idempotency-Key` desde `usePlaceOrder.ts`).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- La dedup **no** vive dentro de `createOrder` sino en un `placeOrder(input, idempotencyKey?)` nuevo
  que lo envuelve. El `clientSecret` no lo produce `createOrder`: los tres pasos del checkout
  (crear orden → crear PaymentIntent → persistir `paymentIntentId`) estaban repartidos entre el
  service y el **controlador**, así que cachear "la respuesta del original" obligaba a tener los tres
  bajo un mismo techo. Se movieron a `placeOrder` y el controlador quedó en validar + delegar.
  `createOrder` sigue exportado e intacto (es la pieza con la transacción y el stock atómico).
- **Se cachea la promesa en vuelo, no el resultado.** El doble clic real llega *antes* de que el
  primer request termine; guardando solo el resultado, los dos arrancarían su propio checkout. El
  `get`/`set` del mapa no tiene `await` en medio, así que dos requests concurrentes no pueden
  reclamar la misma clave.
- **Reusar una `Idempotency-Key` con otro carrito → `409`** (no se devuelve el pedido anterior ni se
  crea uno nuevo). Es un bug del cliente, y las dos alternativas son peores: devolverle un pedido que
  no armó, o cobrarle dos veces. La huella del carrito viaja junto a la promesa para poder detectarlo.
- **Un intento fallido libera la clave, pero solo si no alcanzó a escribir.** Los errores comunes
  (`409` sin stock, `503` de cotización, `400` de validación) ocurren antes de persistir y el
  comprador tiene que poder corregir y reintentar en el acto, no esperar 60 s. Si en cambio falla
  *después* de que `createOrder` commiteó (Stripe caído), la clave **se conserva**: la orden y su
  stock descontado ya existen, y liberarla convertiría el reintento —el más probable de todos, porque
  el comprador acaba de ver un error— exactamente en el pedido duplicado con stock apartado 30–40 min
  que esta fase existe para evitar. `executeCheckout` marca un flag `persisted` justo después del
  commit y el manejador de error decide con él; un reenvío en esa ventana recibe el mismo error, no un
  segundo pedido.
- **La liberación va con chequeo de identidad** (`IdempotencyStore.deleteIf`, no `delete`): un intento
  puede tardar más que el TTL (el timeout por defecto del SDK de Stripe son 80 s contra una ventana de
  60 s), y para cuando falla su entrada ya expiró y otra petición reclamó la clave. Un `delete` a
  ciegas borraría **esa** entrada nueva.
- **El reenvío se marca con `Idempotency-Replayed: true`.** El cuerpo de la respuesta repetida es
  idéntico al del original a propósito, así que sin el header el cliente no puede distinguir "se creó
  tu pedido" de "este ya lo tenías" — relevante mientras el front no mande `Idempotency-Key` y la
  dedup dependa de la huella. Va en `exposedHeaders` del CORS de `app.ts`, o el navegador no dejaría
  leerlo.
- **Corolario en `pendingOrderSweeper`:** conservar la clave deja la orden viva, pero esa orden quedó
  `pending` **sin** `paymentIntentId` (Stripe fue justo lo que falló) y el barrido filtraba
  `paymentIntentId != null`, así que su stock no lo liberaba nadie — para siempre. Se quitó el filtro:
  una orden sin PaymentIntent salta la consulta a Stripe (no hay nada que reconciliar) y va directo a
  `releaseOrderStock`. Reponer es seguro porque el `clientSecret` nunca llegó al cliente, así que ese
  pedido no puede pagarse; y si Stripe alcanzó a crear el intent pero se perdió la respuesta, ese
  intent queda sin confirmar y expira solo. Tests en `tests/integration/pendingOrderSweeper.test.ts`
  (4 casos, con `sweepOnce` exportada porque el timer no corre bajo `NODE_ENV=test`).
- La huella normaliza el carrito igual que `createOrder` (renglones agregados por `(productId, size)`
  y ordenados), así que el mismo carrito con los renglones en otro orden se reconoce como el mismo
  pedido. Los datos del cliente entran como **arreglo posicional**, no como objeto, para no depender
  del orden de claves que produzca zod.
- Efecto colateral en un test existente: `checkout.test.ts` probaba la carrera por la última pieza con
  el **mismo** body dos veces, que ahora es un doble clic y se deduplica. Se cambió a dos compradores
  distintos, que es lo que esa prueba siempre quiso decir.
- Tests: `tests/unit/utils/idempotency.test.ts` (10 casos del helper, con timers falsos para el TTL) y
  `tests/integration/checkoutIdempotency.test.ts` (13 casos, nivel 2 — HTTP contra Postgres real, con
  `payment.service` mockeado; el contador de llamadas al mock **es** la prueba de que Stripe se llamó
  una sola vez). Se exporta `resetCheckoutIdempotency()` solo para los tests: el mapa vive en el
  módulo y sobrevive al `truncateAll` entre casos. Los dos casos de liberación de clave mandan el
  **mismo** carrito las dos veces (el fallo es "sin stock" y entra mercancía entre un envío y otro):
  con carritos distintos la huella también sería distinta y el reintento pasaría aunque la clave se
  hubiera quedado ocupada, o sea que el test no probaría nada.

**Cómo verificar:** disparar dos `POST /api/orders` idénticos con `Promise.all` → una sola orden en
la BD, un solo PaymentIntent en el dashboard de Stripe test, stock descontado una vez.

---

### Fase O.3 — Reintento de guía de Skydropx ✅

**Objetivo:** poder regenerar una guía que falló, sin entrar a la base de datos.

**Por qué ahora:** `CLAUDE.md` ya lo admite textualmente — *"ese reintento en sí no existe todavía"*.
Hoy cuando `createShipmentForOrder` falla llega un correo de alerta operativa y ahí muere: el pedido
está pagado, el cliente espera, y no hay ninguna ruta que vuelva a intentar.

**El bug latente que esta fase cierra:** el guard de centinela escribe
`skydropxShipmentId: "creating"` **antes** de llamar a Skydropx y lo libera en el `catch` si falla.
Pero si el proceso muere entre el `UPDATE` y el `POST` (redeploy, OOM, crash), el centinela queda
**huérfano en la BD**: la orden no tiene guía, y como `skydropxShipmentId !== null`, cualquier
intento futuro se retira creyendo que otra llamada ya la está creando. Esa orden **nunca** puede
volver a generar guía. El reintento tiene que poder distinguir el centinela de un id real y forzar
la liberación.

**Tareas:**
- [x] `POST /api/admin/orders/:id/shipment/retry` `[auth]` → llama a `createShipmentForOrder`.
  Rechaza con `409` si la orden ya tiene un `skydropxShipmentId` **real** (no el centinela), para no
  pagar una segunda guía.
- [x] Liberar el centinela huérfano: si `skydropxShipmentId === "creating"` y la orden lleva más de
  N minutos así, el reintento lo limpia y vuelve a reclamar. Considerar un `createdAt` del centinela
  o apoyarse en `updatedAt` para medir la antigüedad.
- [x] Barrido automático (opcional, evaluar): extender `pendingOrderSweeper` —o un cron gemelo— para
  detectar órdenes `paid` sin `skydropxShipmentId` después de N minutos y reintentar solas. Es lo que
  convierte la alerta por correo en una recuperación de verdad.
- [x] Confirmar que `labelUrl` viaje en `GET /api/admin/orders` para imprimir la guía desde el panel.
- [x] Tests: reintento sobre orden con guía real → `409`; con centinela huérfano → libera y crea una
  sola guía; dos reintentos concurrentes → una sola llamada a Skydropx (mock del `fetch`).
- [x] Fase 🔴 en el roadmap del frontend.

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- **El centinela huérfano y el centinela "ya se cobró la guía" eran indistinguibles**, y ese era el
  verdadero obstáculo para reintentar. `createShipmentForOrder` deja `"creating"` escrito a propósito
  cuando Skydropx **sí creó y cobró** la guía pero no se pudo guardar su id — precisamente para que
  nadie genere una segunda. Un reintento por antigüedad, tal como lo pedía la tarea, habría pagado esa
  segunda guía en el peor caso posible. Se resolvió dándole a ese caso un **valor propio**,
  `unreconciled:<id real>`: conserva el id para que un humano lo localice en el panel de Skydropx, y
  ni el endpoint ni el barrido lo tocan (el `WHERE` del barrido solo acepta `null` o el centinela
  exacto). El `"creating"` vuelve a significar una sola cosa —"alguien está creando la guía"— y por
  eso liberarlo por antigüedad es seguro.
- **Antes de rendirse, se reintenta el `UPDATE`** que guarda el id de una guía ya cobrada
  (3 intentos, 1 s). Es el único fallo de esta función que cuesta dinero y su causa típica (pool
  agotado, conexión reciclada) es transitoria: insistir ahí evita la mayoría de los casos
  `unreconciled` en vez de solo gestionarlos mejor.
- **El webhook de esa guía la reconcilia solo.** `applyShipmentUpdateFromWebhook` busca también por
  `unreconciled:<id>` y, al encontrarla, escribe el id real: el evento **es** la prueba de que la guía
  existe y de cuál es su id, así que el caso más común se cierra sin intervención humana.
- **Un solo knob de tiempo** (`SHIPMENT_RETRY_DELAY_MINUTES`, 15) para las dos cosas que se miden:
  cuándo un `"creating"` cuenta como huérfano y cuánto espera el barrido antes de reintentar. Un
  intento normal se resuelve o falla en segundos (timeout de 5 s por request, 8 s el poll de
  re-cotización), así que 15 min nunca le quita el turno a una creación real en vuelo.
- **El endpoint espera el resultado** y responde `502` si Skydropx falla, en vez del fire-and-forget
  del camino automático: el dueño está mirando la respuesta y necesita saber si insistir. Dos
  reintentos concurrentes (doble clic) los serializa el mismo centinela: uno crea la guía, el otro
  recibe `409` "se está generando", no un error.
- **La alerta por correo pasó a ser opcional por llamada** (`notifyOnFailure`). El camino automático
  la sigue mandando; el reintento manual y el barrido la apagan porque ya tienen canal — el endpoint
  responde el error al momento y el barrido alerta **una sola vez al agotar sus 3 intentos**, en vez
  de un correo por ciclo.
- **El barrido es un cron gemelo** (`src/services/shipmentRetrySweeper.ts`), no una rama dentro de
  `pendingOrderSweeper`: distinta ventana, distintos candidatos y distinto criterio de rendición. Solo
  mira pedidos `paid` **con** tarifa de Skydropx creados en las últimas 24 h (pasado ese punto el
  fallo ya no es transitorio y hace falta una decisión humana), procesa hasta 20 por ciclo y va
  secuencial: el límite de 2 req/s de Skydropx es de la cuenta entera y lo comparte con las
  cotizaciones de checkouts en vivo. Se arranca y se detiene en `app.ts` junto al otro.
- `labelUrl` ya viajaba en `GET /api/admin/orders` (esa ruta no excluye ningún campo); quedó cubierto
  con un test para que no se pierda en un refactor.
- Tests: `tests/integration/shipmentRetry.test.ts` (20 casos — el endpoint por HTTP, el barrido
  llamando a `sweepShipmentsOnce`, y la reconciliación por webhook; `skydropx.service` y
  `email.service` mockeados, Postgres real). `resetShipmentRetryAttempts()` se exporta solo para los
  tests, igual que `resetCheckoutIdempotency()`.
- **Riesgo residual asumido:** si la BD está caída el tiempo suficiente para que también falle el
  marcado `unreconciled:`, la orden queda en `"creating"` y el barrido podría reclamarla a los 15 min
  y pagar una segunda guía. Por eso la alerta de ese caso es incondicional y de severidad `fatal`.

**Correcciones tras el `/code-review` de la fase (2026-07-28).** Diez hallazgos, todos arreglados en
el mismo commit. Los tres primeros son los que costaban dinero o dejaban al dueño atorado:

- **El fallo que el diseño de arriba no cubría: el `POST /shipments` sin respuesta.** El marcador
  `unreconciled:` protegía el caso "la guía se creó y falló guardarla en la BD", pero cada `fetch`
  sale con `AbortSignal.timeout` de 5 s: si Skydropx **procesa y cobra** la guía y la respuesta tarda
  o la conexión se corta, `createShipment` lanzaba, `createdShipmentId` seguía en `null`, y el `catch`
  liberaba el centinela creyendo que no había pasado nada. Antes de esta fase eso era inofensivo
  porque **nada reintentaba**; con el barrido, era una segunda guía pagada a los 15 min. Ahora
  `createShipment` clasifica su propio fallo: un `4xx` (salvo 408/429) es un rechazo explícito —no
  creó ni cobró nada, seguro reintentar, y es justo el caso "saldo agotado"/"Skydropx caído" que esta
  fase recupera—, mientras que timeout, socket cortado o `5xx` lanzan `SkydropxShipmentUncertainError`
  y la orden queda marcada `unreconciled:desconocido`. Para que la clasificación sea fiable el token
  OAuth se resuelve **fuera** del `try` (un fallo de token nunca es incierto: el POST no salió) y
  `SkydropxRequestError` carga su `path`.
- **`force: true`, la salida del caso incierto.** Ese marcador no lo puede sanar el webhook (no hay id
  que empatar), así que sin una puerta el pedido quedaría atorado para siempre — exactamente lo que
  esta fase vino a eliminar. El endpoint acepta un body opcional `{ force }` que significa "ya revisé
  el panel de Skydropx y no existe ninguna guía". Es lo único que desbloquea; un id real nunca se
  fuerza, porque ahí no hay nada que confirmar.
- **El reintento no rechazaba un pedido `shipped`/`delivered`.** El camino que el propio `409` de la
  tarifa plana recomienda —generar la guía a mano en el panel y capturarla con el `PATCH /status` de
  la Fase O.1— deja el pedido `shipped` con `skydropxShipmentId` en `null` y `skydropxRateId` puesto,
  o sea reintentable: un clic en el botón cobraba una segunda guía por un pedido que ya salió. El
  barrido nunca estuvo expuesto (su `WHERE status: "paid"` lo excluye).
- **`Number(process.env.X ?? 15)` no valida nada.** `??` solo cae al default con `undefined`, así que
  una línea vacía en el `.env` daba `0` —margen de centinela cero: una creación reclamada hace
  milisegundos cuenta como huérfana y un reintento concurrente paga la segunda guía— y un valor mal
  tecleado daba `NaN`, que convierte el `setInterval` del barrido en un bucle de ~1 ms. Los dos knobs
  pasan por `positiveNumberEnv` (`src/utils/env.ts`), con su test unitario.
- **El reloj del centinela era `updatedAt`**, que bumpea cualquier otra escritura sobre el pedido
  (webhook de envío, avance manual de estado, marcado de pago). Un pedido realmente atorado en
  `"creating"` reiniciaba su cuenta cada vez que el dueño lo tocaba desde el panel y no podía
  liberarse nunca. Ahora hay columna propia, `orders.shipmentClaimedAt` (migración
  `20260728120000-orders-shipment-claimed-at.ts`), poblada al reclamar; las filas anteriores quedan en
  `NULL` y cuentan como huérfanas de inmediato, que es lo correcto.
- **El `503` del webhook se disparaba con centinelas rancios.** `applyShipmentUpdateFromWebhook` pedía
  reintento ante cualquier envío desconocido mientras existiera **una sola** fila en `"creating"`, y
  esta fase hace que esos centinelas duren mucho más. Como además los mensajes nuevos le piden al
  dueño generar guías a mano en el panel de Skydropx, los eventos de esas guías se respondían `503` en
  bucle. El conteo se acota ahora a centinelas reclamados hace menos de 15 min (la misma columna
  nueva), que es lo único que significa "creación en vuelo".
- **`pendingShipmentWhere` filtraba solo `skydropxRateId`**, pero `createShipmentForOrder` exige rate
  **y** cotización: un pedido con uno y no el otro entraba en cada ciclo, se salía en la primera
  línea, gastaba sus tres intentos y disparaba la alerta de "no se pudo generar la guía" sin una sola
  llamada a Skydropx.
- **El contador de intentos caducaba por "no salió en este ciclo"**, y ese ciclo viene recortado a 20
  pedidos: uno que rotara fuera de la página perdía su cuenta, volvía a cero y podía gastar otros tres
  intentos y mandar una segunda alerta idéntica. Ahora caduca **por tiempo** (la ventana de 24 h).
  Además los pedidos agotados se excluyen **en la consulta** y no con un `continue`: si no, seguían
  ocupando lugares del `LIMIT` y —con el orden `createdAt ASC`— veinte pedidos atorados al frente
  dejaban sin turno a todos los más nuevos durante 24 h.
- **`attemptShipment` devolvía `null` para dos cosas distintas**: "falló" y "otra llamada tiene el
  centinela". El barrido contaba la segunda como fallo, gastando intentos y adelantando la alerta de
  un pedido cuya guía se estaba creando perfectamente (pasa de verdad cuando el cliente paga tarde
  —3DS— y el webhook está creando la guía justo cuando corre el barrido). Ahora devuelve un
  `ShipmentAttempt` tipado: `created` · `in-progress` · `unreconciled` · `failed`, y solo el último
  gasta intento.
- **`persistShipmentId` escribía sin condición de centinela**, a diferencia del resto de escrituras
  del flujo. Una creación lenta cuyo centinela ya se liberó por huérfano podía pisar en su intento 2 o
  3 lo que un intento más nuevo hubiera escrito —otro id real, o un marcador `unreconciled:`—
  borrando justo el dato que un humano necesita para reconciliar. Ahora, si el `UPDATE` no afecta
  ninguna fila, no se toca nada y se alerta `fatal`: la guía ya está cobrada y hay que revisar si el
  pedido terminó con dos.

Tests: `shipmentRetry.test.ts` pasa de 20 a 34 casos (el caso incierto y su `force`, el pedido ya
enviado, el `4xx` que sí libera, el filtro de cotización, el intento que no se gasta, el contador que
sobrevive a caerse de la página, y las dos ramas del `503` del webhook) más
`tests/unit/utils/env.test.ts` (8 casos).

**Cómo verificar:** mockear un fallo de Skydropx en `createShipmentForOrder`, pagar un pedido,
confirmar que llega la alerta y que el pedido queda sin guía; luego reintentar desde el endpoint →
se crea una sola guía y `skydropxShipmentId` queda poblado.

---

### Fase O.4 — Consulta pública de pedido ✅

**Objetivo:** que el cliente vea el estado y el tracking de su pedido sin escribirle al dueño.

**Por qué ahora:** no hay cuentas de cliente ni ninguna ruta pública de lectura de órdenes. Tras
pagar, lo único que tiene el comprador es el correo de confirmación. Si lo borra o le cae en spam,
toda consulta de "¿ya salió mi pedido?" es trabajo manual por WhatsApp — justo el trabajo que el
resto del backend automatizó.

**Diseño (decidido):**
- **Token opaco por orden**, no `id + email`. Con `id + email` el identificador secreto es un correo
  que cualquiera puede adivinar y los ids son secuenciales, así que sería enumerable aunque se le
  ponga rate limit. Una columna `publicToken` (UUID, único, generado en `createOrder`) se manda en el
  correo de confirmación como link y no se puede adivinar.
- **Sin cuentas de cliente.** Fuera de alcance: es otra fase completa (registro, sesión, historial) y
  el negocio no la ha pedido.
- **Exclusiones estrictas.** La respuesta omite `unitCost` (regla existente), `paymentIntentId`,
  `shippingRequiresDropoff` (bandera operativa del dueño) y `refundId`. Es una ruta pública: se
  arma una proyección explícita, no un `toJSON()` con exclusiones.

**Tareas:**
- [x] Migración: `orders.publicToken` (UUID, nullable por las filas existentes, índice único).
  Backfill de las órdenes ya creadas en la misma migración.
- [x] Generar el token en `orders.service.createOrder` e incluir el link en
  `orderConfirmationTemplate` (ya recibe `FRONTEND_URL`).
- [x] `GET /api/orders/lookup/:token` `[público]` con proyección explícita + rate limiter propio.
- [x] Tests: token válido devuelve estado/tracking; token inválido → `404` genérico; la respuesta
  **no** contiene `unitCost`, `paymentIntentId` ni `shippingRequiresDropoff`.
- [x] Fase 🔴 en el roadmap del frontend (página de seguimiento).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- **El token mal formado se rechaza antes de tocar la BD**, y no por ahorrarse la consulta: la
  columna es `uuid`, así que un `WHERE "publicToken" = 'abc'` lo rechaza Postgres con un error de
  sintaxis y el `errorHandler` lo degradaría a un **500 "Error interno del servidor"** — el mismo
  problema que `parseId` resuelve para los `:id` numéricos, y encima delataría la causa. Con la
  validación de formato, los tres casos (mal formado, inexistente, pedido borrado) responden el
  **mismo 404 con el mismo mensaje**, que es lo que la regla anti-enumeración exige (misma regla
  que `POST /api/auth/login` y `assertValidResetCode`).
- **Qué queda fuera de la proyección, además de lo que el diseño ya listaba.** `labelUrl`: la
  etiqueta imprimible es del dueño, trae los datos del remitente y no le sirve de nada a quien solo
  quiere rastrear. Los ids de Skydropx (`skydropxShipmentId`/`skydropxQuotationId`/`skydropxRateId`)
  por la misma razón. El propio `publicToken` (el cliente acaba de mandarlo). Y
  `customerEmail`/`customerPhone`: no aportan nada a una página de rastreo y el link se comparte por
  WhatsApp con facilidad. La **dirección sí va** — es lo que el comprador necesita verificar, y
  corregir con el dueño a tiempo si se equivocó.
- **`refundedAt` sí se expone** (no así `refundId`): un pedido cancelado tiene que poder decirle al
  cliente *cuándo* se devolvió el dinero, que es la pregunta que sigue. El id del reembolso de
  Stripe no le dice nada.
- **La proyección se arma campo por campo y el `SELECT` también va acotado** (`attributes: [...]`),
  así que las columnas excluidas ni siquiera salen de Postgres. Es a propósito para que el modo de
  fallo sea el seguro: una columna nueva en `Order` no aparece hasta que alguien la agregue aquí, en
  vez de filtrarse sola por olvidar sumarla a una lista de exclusiones.
- **El token viaja también en la respuesta de `POST /api/orders`**, no solo en el correo. El pedido
  es del comprador y así el front puede llevarlo a la página de seguimiento en cuanto paga, sin
  depender de que le llegue el correo (que es justo lo que esta fase asume que puede fallar).
- **El link va en los dos correos** (confirmación y "tu pedido va en camino"), no solo en el
  primero: comparten `sendOrderEmail`, y el correo que el cliente conserva es impredecible.
  `publicOrderUrl` devuelve `undefined` para un pedido sin token (filas anteriores a la columna) y
  el bloque simplemente no se renderiza, en vez de mandar un link a un 404.
- **La ruta del front es `/pedido/<token>`**, la única URL que este backend construye hacia el
  frontend; si cambia allá, hay que cambiarla en `publicOrderUrl` (`payment.service.ts`).
- **El backfill de la migración usa `gen_random_uuid()`** (nativo desde Postgres 13, sin extensión)
  y el índice único se crea **después**, para que el `UPDATE` masivo no tenga que respetar la
  unicidad fila por fila sin necesidad. El índice se declara además en `Order.init()`'s `indexes`
  porque `tests/setup/db.ts` arma el esquema con `sync({ force: true })`, no con migraciones.
- **Rate limiter propio, holgado** (`orderLookupRateLimiter`, 30 req/min). No es la defensa contra
  adivinar tokens —un UUID no se fuerza bruta con ni sin límite—: es para que un script no martille
  la ruta gratis y para acotar el daño de un token filtrado. El tope es amplio a propósito, porque
  quien recarga esa página es un comprador esperando su pedido.
- Tests: `tests/integration/orderLookup.test.ts` (11 casos, nivel 2 — HTTP contra Postgres real) y
  `tests/unit/services/orderConfirmationTemplate.test.ts` (3 casos, nivel 1). El caso de "no filtra
  nada" afirma campo por campo **y** hace un barrido sobre el JSON serializado completo, para que un
  campo nuevo no se cuele con otro nombre en un nivel anidado.

**Cómo verificar:** completar un checkout, abrir el link del correo → estado y tracking correctos;
cambiar un carácter del token → `404` sin filtrar si la orden existe.

---

### Fase O.5 — Readiness real en el healthcheck ✅

**Objetivo:** que el healthcheck falle cuando la app no puede atender tráfico.

**Por qué ahora:** `GET /health` responde `{ status, timestamp }` sin tocar la BD, así que sigue en
verde con Postgres caído. Cualquier orquestador (Railway, Render, Fly, un load balancer) lo va a
tomar como sano y le va a seguir mandando tráfico que solo puede terminar en `500`.

**Diseño:** `/health` se queda **igual** (liveness: "el proceso vive") y se agrega `/health/ready`
(readiness: "puede atender") con `sequelize.authenticate()` bajo un timeout corto → `503` si falla.
Separarlos importa: si el liveness probe dependiera de la BD, una caída momentánea de Postgres haría
que el orquestador **reinicie** la app en vez de solo sacarla de rotación, que es exactamente lo
contrario de lo que conviene.

**Tareas:**
- [x] `GET /health/ready` con `sequelize.authenticate()` + timeout corto → `200`/`503`.
- [x] Documentar en `README.md` cuál probe apunta a cuál en el deploy.
- [x] Test de smoke (con la BD de test arriba, `/health/ready` responde `200`).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- **El timeout no es una precaución, es lo único que hace útil al endpoint.** `config/database.ts`
  no fija `connectTimeout` ni `statement_timeout`, y `pool.acquire` son 30 s: con Postgres caído,
  un `sequelize.authenticate()` a secas se cuelga mucho más de lo que el orquestador espera por su
  sondeo, así que el probe expiraría por su lado sin que la ruta llegue a contestar nunca. Va en un
  `Promise.race` contra un `setTimeout` de `HEALTH_READY_TIMEOUT_MS` (**3000**, leído con
  `positiveNumberEnv` como manda la regla de la Fase O.3). Detalle que muerde: el timer hay que
  **limpiarlo en un `finally`**, o en el camino feliz se rechaza más tarde sin nadie escuchando y
  sale como unhandled rejection. **3 s y no 500 ms** a propósito: un pico de tráfico que sature
  momentáneamente el pool no debe sacar la instancia de rotación — eso solo cascadea la caída.
- **Caché de 1 s + promesa compartida** (`src/services/readiness.ts`), que el diseño no pedía. Es
  una ruta **pública y sin auth** contra un pool de **5 conexiones**: una query por request deja
  que un script la martille y haga esperar a los checkouts hasta `pool.acquire` (30 s). Mismo
  patrón que `loadReportData` en `reports.service.ts`. La ventana se cuenta desde que el chequeo
  **termina**, no desde que arranca: midiéndola desde el arranque, un chequeo lento (justo el caso
  de BD caída) nace vencido y cada request abre su propia consulta. Se descartó un rate limiter
  propio, que era la opción obvia: el sondeo sale de una sola IP interna, así que un límite mal
  calibrado le devolvería `429` **al probe** → falso "no listo" → la instancia se reinicia sola.
- **Bandera de drenado.** `gracefulShutdown` llama a `markDraining()` como primera línea y desde
  ese instante `/health/ready` responde `503` con `reason: "draining"` **sin consultar la BD**: es
  el otro caso de "no puede atender" que el objetivo de la fase nombra y que el diseño no cubría —
  mientras el proceso drena, un `200` es mentira aunque Postgres esté perfecto.
  **Su alcance real es menor de lo que sugiere el patrón, y conviene tenerlo claro** (medido, no
  supuesto): en Node ≥ 19 `server.close()` cierra de inmediato las conexiones keep-alive ociosas y,
  sin requests en vuelo, el proceso sale en milisegundos, así que el sondeo siguiente recibe un
  error de conexión y no el `503`. O sea que la ventana dura lo que dure el tráfico que se está
  drenando. Que un balanceador la vea siempre exigiría un **retardo explícito** entre marcar el
  drenado y `server.close()` — no se implementó porque alargaría cada redeploy y esa es una
  decisión de despliegue, no de código. Queda como candidato si algún día el deploy real muestra
  errores de conexión durante los redeploys.
- **El cuerpo del `503` no lleva el error de la BD**, solo `reason`. Es una ruta pública: el host,
  el puerto y el driver van al log. Y el log es **solo por transición** (ready↔no-ready), no por
  sondeo — un probe corre para siempre cada pocos segundos y una línea por intento llena (y cobra)
  el proveedor de logs. Por lo mismo **no hay `Sentry.captureException`** aquí: un evento cada 5 s
  se come la cuota, y quien reporta la caída al final es el orquestador.
- **`checkReadiness` nunca lanza**, y el handler además lo envuelve en `try/catch`. Si el error
  llegara a `errorHandler`, cada sondeo con la BD caída mandaría un **500 a Sentry** y devolvería
  copia de UI en español para algo que lee una máquina.
- **`/health` no se tocó ni una línea**, que es la mitad del punto: es el liveness, y si dependiera
  de Postgres el orquestador **reiniciaría** la app ante una caída momentánea en vez de solo
  sacarla de rotación. La suite lo afirma explícitamente (espía `authenticate` y verifica que no se
  llame), para que un refactor que "unifique" los dos handlers rompa el test.
- **El test de smoke no vive en `tests/smoke/`.** Ese suite corre a propósito **sin Postgres** (su
  comentario lo dice), así que un assert de `/health/ready` a `200` rompería esa garantía. Quedó en
  `tests/integration/healthReady.test.ts` (4 casos, nivel 2) más
  `tests/unit/services/readiness.test.ts` (8 casos, nivel 1 — con `authenticate` espiado se puede
  simular lo que en producción no se provoca a voluntad: la BD **colgada sin responder**, que es el
  caso que motiva el timeout). `resetReadinessCache()` se exporta solo para los tests, igual que
  `resetCheckoutIdempotency()`.
- Sin migración, sin columnas y sin dependencias nuevas. **No lleva fase en el roadmap del
  frontend**: lo consume el orquestador, no el front.

**Cómo verificar:** bajar Postgres con el server corriendo → `/health` sigue `200`, `/health/ready`
responde `503` (en ~3 s, no en 30). Al volver a levantarlo, `/health/ready` vuelve a `200` en ≤1 s
(TTL de la caché). Con `kill -TERM` al proceso, `/health/ready` responde `503 reason: "draining"` de
inmediato, sin esperar el timeout.

---

# BLOQUE N — Features de negocio (sin orden obligatorio)

### Fase N.1 — Búsqueda, orden y filtros en el catálogo ✅

**Objetivo:** que `GET /api/products` sirva para encontrar productos, no solo para paginarlos.

**Por qué:** hoy solo filtra `categoria` y `talla`. No hay búsqueda por texto, ni orden por precio,
ni rango de precios. Con el import masivo de Excel el catálogo va a crecer en lotes de hasta 500
filas por archivo, y ahí un listado sin búsqueda deja de ser navegable rápido.

**Tareas:**
- [x] `q`: busca en `name` y `code` con `ILIKE '%q%'`, **escapando `%` y `_` del valor del usuario**.
  Ya hay precedente documentado de este bug en el import (`iLike` sin escapar hacía que una fila
  `"Bota%Premium"` emparejara y **renombrara** otro producto) — mismo cuidado aquí.
- [x] `orden`: `precio_asc` · `precio_desc` · `novedad` (`id DESC`) · default actual (`id ASC`).
- [x] `precioMin` / `precioMax` sobre `salePrice`, validados como números antes de tocar SQL (misma
  regla que `talla` con `Number.isInteger`).
- [x] Todo **en SQL**, con el `where` compartido entre el `count` y el `findAll` (como ya está hecho).
- [x] Índices en migración: `products(type)`, `products(salePrice)`; `pg_trgm` sobre `name`
  **diferido a propósito** (ver abajo).
- [x] Tests + `@openapi` (los query params nuevos van en el bloque existente).
- [x] Fase 🔴 en el roadmap del frontend (Fase 18).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**
- **Hay que escapar la `\`, no solo `%` y `_`.** No es una nota de completitud: `\` es el carácter
  de escape por defecto de `LIKE` en Postgres, así que un `?q=\` deja un escape colgante, Postgres
  responde `22025 LIKE pattern must not end with escape character` y el `errorHandler` lo degrada a
  un **500 provocable con un solo carácter en la query string**. `escapeLike`
  (`src/utils/escapeLike.ts`) escapa los tres en **una sola pasada** (`/[\\%_]/g`): encadenar un
  `.replace` por carácter volvería a escapar las barras que la pasada anterior acaba de introducir.
  Como el escape por defecto ya es `\`, no hace falta cláusula `ESCAPE` explícita — que además
  obligaría a armar la condición con `sequelize.literal` y perdería el binding.
- **`Op.iLike` sí funciona con `Product.count`.** Era la duda razonable, porque es justo la
  limitación que obliga a interpolar `talla` a mano (`count` no acepta `replacements`). Pero eso
  solo aplica a `sequelize.literal` con binds nombrados: `Op.iLike` es un operador que el query
  generator expande igual en `count` y en `findAll`.
- **`precioMin`/`precioMax` se validan con `Number.isFinite`, NO con `Number.isInteger`** como
  sugería la tarea: `salePrice` es `DECIMAL(10,2)` y `precioMax=1499.99` es un filtro legítimo que
  `Number.isInteger` habría descartado en silencio.
- **Los órdenes por precio llevan desempate por `id`,** que el diseño no pedía. Los precios empatan
  todo el tiempo (números redondos, lotes importados con el mismo precio) y Postgres no garantiza
  ningún orden entre filas empatadas: sin desempate, la página 2 repetía productos de la 1 y perdía
  otros. El desempate va en la **misma dirección** que el precio para que `precio_desc` se resuelva
  con un recorrido hacia atrás del mismo índice, sin sort.
- **`products(salePrice)` no alcanza: tiene que ser `("salePrice", "id")`.** Un índice de una sola
  columna no puede satisfacer `ORDER BY "salePrice", id` — obligaría a un sort incremental, que es
  exactamente lo que el índice venía a evitar. Los dos índices son además **parciales** sobre
  `visible = true AND "deletedAt" IS NULL`, el predicado que llevan textualmente todas las consultas
  públicas; el único listado que no lo lleva (`adminGetProducts`) no tiene `WHERE` alguno, así que
  ningún índice le sirve de todos modos.
- **`availableSizes` sí se acota por `q` y por precio** (el diseño ni lo mencionaba, pese a que
  viaja en la misma respuesta). Es el mismo callejón sin salida que motivó excluir `talla`, en el
  otro eje: con una búsqueda activa, el selector ofrecía tallas que al elegirse daban cero
  resultados. Se acota por `categoria`/`q`/precio y **sigue sin acotarse por `talla`** — si se
  acotara por la talla ya elegida, elegir una vaciaría el propio selector. El `WHERE` de esa
  consulta es una **copia a mano** del `where` compartido (es SQL crudo): un filtro nuevo hay que
  agregarlo en los dos lados, y hay comentarios en ambos que lo advierten.
- **`pg_trgm` diferido, pero no por el motivo que uno esperaría.** El índice GIN en sí *sí* se puede
  declarar en `Model.init()` (Sequelize soporta `using` y `operator` por campo); lo que no se puede
  es el `CREATE EXTENSION`, y `sync({ force: true })` nunca lo ejecutaría — la BD de pruebas y el
  contenedor de Postgres de CI armarían un esquema donde la creación del índice revienta, y
  arreglarlo pide superusuario. Con el tope de 500 filas por archivo de importación, un `ILIKE
  '%x%'` sobre unos miles de filas no se nota. **Revisar** cuando el catálogo pase de ~20k filas o
  la latencia del catálogo se degrade.
- **Bug preexistente que salió al pasar por aquí:** `?talla=` (vacío) daba `Number("") === 0`, que
  `Number.isInteger` acepta, así que filtraba por `size = 0` y devolvía el **catálogo vacío**. Se
  arregló con el mismo guard que necesitaban los params nuevos (recortar, exigir no vacío y `> 0`),
  con su test de regresión.
- El `where` pasó de mutarse campo por campo a **un solo literal con spreads condicionales**:
  `[Op.or]` es una clave `symbol` y asignarla por mutación sobre un `WhereOptions` obliga a un cast.
  Sigue siendo el mismo objeto para `count` y `findAll`, que es el invariante que importa.
- Tests: `tests/unit/utils/escapeLike.test.ts` (7 casos, nivel 1) y 18 casos nuevos en
  `tests/integration/products.test.ts` (nivel 2 — HTTP contra Postgres real), incluidos los tres que
  blindan lo caro: `%` y `_` como texto literal, `?q=\` que no revienta, y `availableSizes` acotado
  por `q`/precio pero no por `talla`.

**Queda pendiente (no lo abre esta fase):** `perPage` sigue sin tope superior, y ahora un
`?orden=precio_asc&perPage=999999` fuerza un escaneo ordenado del catálogo completo en una ruta
pública sin auth. Se junta con el pendiente heredado de "evaluar rate limiting en el catálogo
público" del final de este documento.

**Cómo verificar:** `curl 'localhost:4000/api/products?q=100%25'` no debe devolver el catálogo
completo (el escapado funcionando de punta a punta); `?orden=precio_asc&precioMin=500&precioMax=1500`
ordena y acota; `?q=charro&talla=25` devuelve un `availableSizes` sin tallas que no existan dentro de
la búsqueda.

---

### Fase N.2 — Cupones y códigos de descuento ✅

**Objetivo:** poder lanzar una promoción sin repreciar producto por producto.

**Por qué:** no existe ningún mecanismo de descuento fuera de `salePrice` por producto, que es
permanente y toca el catálogo. Un cupón es la palanca de marketing más barata que hay y encaja
limpio en la arquitectura actual: el backend ya es la autoridad de precios.

**Diseño (decidido):**
- El descuento se aplica **en `computeTotals`**, del lado del servidor. El cliente manda un `code`,
  **nunca un monto** — misma regla que ya rige precios y envío.
- Se aplica **sobre el subtotal, antes del envío**, para no regalar la paquetería en un cupón
  pensado para producto.
- El canje se congela en la orden (`couponCode`, `couponDiscount`) igual que los precios: un cupón
  editado después no debe alterar el histórico.
- **El contador de canjes se decrementa igual que el stock**: `UPDATE ... SET redeemedCount =
  redeemedCount + 1 WHERE redeemedCount < maxRedemptions`, dentro de la transacción del checkout. Un
  `SELECT` + `if` dejaría que dos compradores simultáneos quemaran el último uso de un cupón único.
- **Interacción con reportes:** `savings` hoy significa "ahorro por `originalPrice` vs `salePrice`".
  El descuento por cupón es otra cosa y **no debe sumarse ahí** o el margen del dashboard queda mal.
  Columna aparte y decisión explícita de cómo lo reporta `dashboard.service.ts`.

**Tareas:**
- [x] Modelo `Coupon` (`code` único, `type: percent|fixed`, `value`, `minSubtotal?`,
  `maxRedemptions?`, `redeemedCount`, `startsAt?`, `expiresAt?`, `active`) + migración + asociación.
- [x] Columnas `couponCode`/`couponDiscount` en `Order` (misma migración o una gemela).
- [x] `POST /api/coupons/validate` `[público, rate-limited]` para que el checkout muestre el
  descuento antes de pagar (validación, **sin** canjear).
- [x] CRUD admin `/api/admin/coupons` `[auth]`.
- [x] Aplicación real en `computeTotals` + canje atómico en `createOrder`.
- [x] Reflejarlo en `orderConfirmationTemplate` y decidir su tratamiento en dashboard/reportes.
- [x] Tests: cupón expirado/agotado/mínimo no alcanzado; canje concurrente del último uso → uno solo
  gana; el descuento se recalcula server-side aunque el cliente mande otro monto.
- [x] Fase 🔴 en el roadmap del frontend (Fase 19).

**Cómo quedó (decisiones que el diseño de arriba no fijaba):**

- **"Un solo uso" eran dos cosas distintas, y hacen falta las dos.** El diseño solo tenía
  `maxRedemptions` (tope global): con eso, **una sola persona podía quemar los 50 usos** de una
  promoción, que es justo el abuso que había que evitar. Se agregó `oncePerCustomer` (default `true`)
  como límite **por persona**, y el tope global quedó como lo que realmente es: la barrera **dura**,
  la que acota la pérdida máxima a `usos × descuento` sin importar quién canjee. El límite por
  persona es un tope de velocidad, no una garantía.
- **La identidad de "una persona" es el correo del pedido, NO la IP** (la pregunta explícita del
  dueño). Con CGNAT —cualquier plan móvil, Izzi, Totalplay— media colonia sale por una sola
  dirección, así que un canje bloquearía vecinos que nunca usaron el cupón. Y peor: `req.ip` depende
  de `TRUST_PROXY`, así que desplegado detrás de un proxy sin esa env **todos** los compradores se
  ven con la IP del proxy y el primer canje mataría el cupón para la tienda entera. Encima se evade
  apagando el WiFi. El correo se normaliza en `src/utils/emailIdentity.ts` (minúsculas, `+tag`
  recortado en todos los dominios, puntos quitados solo en Gmail/Googlemail) y **sobre-fusiona a
  propósito**: alguien con `juan+trabajo@` como buzón realmente distinto queda bloqueado, y por eso
  el mensaje de error nombra el correo. La IP **sí** se guarda en `coupon_redemptions.ip`, pero solo
  como dato forense para que el dueño detecte patrones: ninguna decisión la consulta.
- **La liberación del canje no estaba en el diseño y sin ella la promoción se muere sola.** El
  diseño solo pedía incrementar el contador dentro de la transacción del checkout. Pero un pedido
  nace `pending` y puede no pagarse nunca: sin devolver el uso, un cupón de 50 canjes se agota con
  carritos abandonados y el dueño ve morir la promoción sin una sola venta. El uso es una reserva
  igual que el stock, así que `releaseCouponForOrder` se llama **en el mismo punto y dentro de la
  misma transacción** que la reposición — en `releaseOrderStock` (con eso queda cubierto el webhook
  `payment_intent.canceled` y `pendingOrderSweeper`) y en la rama `paid` de `cancelOrderByAdmin`,
  después de su guard para que dos cancelaciones concurrentes no decrementen dos veces. Un
  **reembolso fallido no libera** (el dinero no volvió), misma regla que el restock.
- **El `catch` obvio del índice único habría dado un 500, no el 409.** El plan era atrapar el
  `UniqueConstraintError` del índice parcial y traducirlo. Mecánicamente cierto, pero un error
  `23505` deja la transacción de Postgres **abortada** y Sequelize no envuelve un `Model.create` en
  savepoint, así que la parte importante —releer la fila que bloquea para armar un mensaje decente,
  como sí puede hacer el camino de stock— habría fallado con *"current transaction is aborted"*. Se
  usa un `INSERT ... ON CONFLICT ... DO NOTHING` crudo: Postgres sigue decidiendo la carrera, no se
  levanta excepción, la transacción sigue viva y el conteo de filas es la señal (misma forma que el
  `affected === 0` del stock, y ya había precedente con el upsert de `productImport.service.ts`).
- **`coupon_redemptions.enforced`**: el índice parcial no puede consultar el flag `oncePerCustomer`
  del cupón, así que apagarlo en un cupón vivo no relajaría nada — las filas ya escritas seguirían
  bloqueando esos correos para siempre. La columna mete el flag *del momento del canje* en el
  predicado del índice. Se escribe fila para **todo** canje (es la bitácora, y la liberación se apoya
  en su existencia para saber de qué cupón decrementar).
- **El 409 de "ya usaste este cupón" lleva dos mensajes.** Si el pedido que bloquea sigue `pending`,
  el texto invita a terminar de pagarlo. Es una composición de decisiones previas que había que
  resolverle al comprador: cuando Stripe falla *después* del commit, la Fase O.2 conserva la clave de
  idempotencia y el pedido queda `pending` con el cupón apartado hasta que el barrido lo alcance
  (30 min) — decirle "ya lo usaste" por un pedido que nunca pagó sería falso.
- **`computeTotals` no se tocó**, contra lo que decía el diseño ("el descuento se aplica en
  `computeTotals`"). Su test unitario afirma con `toEqual` sobre exactamente cuatro claves, y lo que
  hacía falta compartir entre el checkout y `/validate` no eran "totales" sino "cuántos pesos quita
  este cupón": `computeCouponDiscount(coupon, netMerchandise)`, en el mismo archivo.
- **La base del descuento es la mercancía NETA (`subtotal − savings`), no `subtotal`.** En este repo
  `subtotal` está a precio *original*, así que calcular sobre él regalaría porcentaje sobre un precio
  que nadie paga, y un `minSubtotal` de $1000 se cumpliría con un carrito que realmente vale $600.
- **`maxDiscount`** (tope en pesos, solo para `percent`), que el diseño no listaba: sin él un 50%
  sobre un carrito grande se lleva una cifra que el dueño no anticipó. Y **clamp a `[0, neto]`**, o un
  `fixed` mayor que el carrito dejaría un total negativo.
- **Todo el cálculo va en centavos enteros con un solo redondeo.** La columna es `DECIMAL(10,2)`: sin
  eso, Postgres redondearía al guardar (medio hacia afuera del cero) mientras `/validate` —que no pasa
  por la BD— mostraría el de JS (medio hacia arriba), y el preview diferiría del cobro en un centavo
  justo en los porcentajes que caen a la mitad.
- **Guard de mínimo cobrable, dentro de la transacción.** Un total que Stripe rechace fallaría
  *después* del commit y —por `releaseKeyOnFailure` de la Fase O.2— con la clave conservada: un pedido
  `pending` que aparta stock y quema el cupón 30 min sin poder reintentar. `MIN_CHARGE_MXN` vive en
  `coupon.service.ts` y **no** en `config/stripe.ts`: dos suites reemplazan ese módulo con un objeto
  literal de exports fijos, así que un import nuevo resolvería a `undefined`, `total < undefined` sería
  `false`, y el guard quedaría **muerto en todas las suites que mockean Stripe** con los tests en
  verde. En la práctica casi no se dispara (el descuento está acotado a la mercancía y la tarifa plana
  mínima son $100), así que su lógica se prueba a nivel unitario.
- **`checkoutFingerprint` tuvo que incluir `couponCode`.** Sin eso, el mismo carrito con y sin cupón
  daba la misma huella y al comprador que acaba de aplicar un descuento se le devolvía el pedido
  anterior **sin descontarlo**. La IP **no** entra (no es parte de la identidad del pedido: un
  reintento desde otra red se leería como pedido nuevo).
- **El canje va después del loop de stock, no antes.** Es la posición anti-deadlock: así todo checkout
  toma candados en el mismo orden global (`product_sizes` → `coupons` → `orders` →
  `coupon_redemptions`). Reclamar antes también sería acíclico, pero mantendría un candado sobre la
  fila caliente del cupón durante N idas y vueltas a la BD, serializando a todos los compradores de
  una promoción popular.
- **`/validate` distingue la causa del rechazo** (no existe / venció / se agotó / falta para el
  mínimo), invirtiendo a propósito la regla anti-enumeración del resto del repo: un cupón existe para
  que un humano lo teclee y un "no es válido" opaco lo volvería inusable. La consecuencia queda dicha
  en voz alta: **los códigos no son secretos**, así que un cupón para una sola persona tiene que ser
  largo y aleatorio, nunca `VIP`. El `email` es **opcional** porque el campo vive en el paso 0 del
  checkout, antes de los datos de envío: sin él no se verifica el uso por persona, y la respuesta lo
  declara con `perCustomerChecked: false` para que el front no trate el visto bueno como garantía.
- **Reglas de edición:** `code` no se puede editar (ya pudo repartirse, y el valor congelado en los
  pedidos dejaría de empatar) y `redeemedCount` no entra en ningún schema (estado derivado). **Bajar
  `maxRedemptions` por debajo de `redeemedCount` sí se permite y no se valida**: es el edit que hace
  un dueño para frenar una promoción en caliente. `updateCoupon` re-valida las reglas cruzadas contra
  el estado **combinado** (lo guardado + lo que cambia), porque los refines del schema solo ven el
  body y un `PUT` con solo `maxDiscount` sobre un cupón `fixed` los pasaría.
- **Fechas en la zona de la tienda.** Un `"2026-08-01"` como ISO es medianoche **UTC** = 31 de julio a
  las 18:00 en México: el dueño perdería la última tarde de su promoción. Una fecha sin hora se
  interpreta en `America/Mexico_City` (inicio de día para `startsAt`, `23:59:59.999` para
  `expiresAt`), con offset fijo `-06:00` porque México no tiene DST desde 2022.
- **Tratamiento en el dashboard (la decisión explícita que el diseño pedía):** `savings` **no se
  toca** y `agg.revenue += order.total` **se queda** (ahora suma el efectivo realmente cobrado, que es
  lo correcto). Pero sin nada más, una campaña se leería como una *caída* de ingresos contra el
  periodo anterior aunque el volumen creciera, así que hay un KPI nuevo **`DESCUENTOS POR CUPÓN`** en
  `profitKpis`. Y `SaleRow` **tuvo** que sumar `couponCode`/`couponDiscount`: sin ellos la fila del
  panel es irreconciliable (`subtotal − savings + envío ≠ total` sin causa visible).
  `reports.service.ts` no cambia ni una línea (acota `attributes` en `Order` y usa el `salePrice`
  actual, así que es estructuralmente ciego al cupón); solo se documentó que su `totalRevenue` ya era
  ≥ caja real y el cupón ensancha esa brecha.
- **Riesgo residual asumido:** `coupon_redemptions.orderId` va con `onDelete: "CASCADE"`, así que un
  `DELETE FROM orders` a mano se lleva la fila de canje sin pasar por la liberación y deja
  `redeemedCount` inflado. Ningún camino del código borra pedidos (cancelar solo cambia `status`), así
  que se prefirió permitir la limpieza manual y hacer la divergencia **visible**: el listado admin
  devuelve `activeRedemptions` (conteo vivo) junto al contador guardado.
- Tests: 6 suites nuevas y +64 casos — `tests/integration/coupons.test.ts` (26, nivel 2: la
  aserción de que `/validate` **no** mueve `redeemedCount`, las dos carreras, y que el mismo carrito
  con y sin cupón son dos pedidos), `adminCoupons.test.ts` (16, nivel 2),
  `couponRelease.test.ts` (10, nivel 3 — incluye que tras liberar el **mismo correo** puede volver a
  usar el cupón, que es el predicado del índice parcial de punta a punta),
  `unit/services/couponDiscount.test.ts` (12), `unit/services/chargeableTotal.test.ts` (6) y
  `unit/utils/emailIdentity.test.ts` (8), más casos nuevos en
  `orderConfirmationTemplate.test.ts` (la fila del cupón **antes** de la de Envío),
  `dashboard.test.ts` y `errorHandler.test.ts` (el caso de regresión que documenta *por qué* el
  conflicto del índice no debe llegar al handler genérico). Total del repo: **37 suites / 412 tests**.

**Cómo verificar:** crear un cupón con `POST /api/admin/coupons`; llamar
`POST /api/coupons/validate` varias veces y confirmar en la BD que `redeemedCount` sigue en `0`;
completar un checkout con el cupón → el `201` y el correo muestran el descuento, el **envío no baja**,
y `coupon_redemptions` tiene una fila con el correo normalizado; reintentar con el mismo correo →
`409`; cancelar el pedido desde el panel → `releasedAt` poblado, `redeemedCount` de vuelta en `0` y el
mismo correo puede volver a comprar.

---

### Fase N.3 — Gastos reales (sustituye `GASTOS_FIJOS`) ✅ *(completada)*

**Objetivo:** que el KPI de utilidad del dashboard use gastos capturados, no una constante.

**Por qué:** `GASTOS_FIJOS = $2,000` estaba hardcodeado en `dashboard.service.ts` con el comentario
"no existe un modelo de gastos". Mientras siguió ahí, `profitKpisByPeriod` fue un número inventado, y
es justo el número que el dueño usa para decidir si el negocio gana dinero.

**Tareas:**
- [x] Modelos `Expense` + `ExpenseAmount` + migración.
- [x] CRUD `/api/admin/expenses` `[auth]` con filtro por rango de fechas, más `/summary` y
  `/history`.
- [x] `dashboard.service.ts`: sustituir la constante por la suma real, prorrateada por ventana con
  la misma lógica que hoy (`× windowDays/30`). Los gastos recurrentes cuentan cada mes; los de una
  sola vez, solo en su mes.
- [x] Seed: migrar los `$2,000` actuales a una fila de gasto recurrente.
- [x] Tests de la agregación (nivel 1, sin BD) + suite de integración del CRUD.
- [x] Fase 🔴 en el roadmap del frontend (Fase 20).

**Lo que cambió respecto al plan original de esta fase.** El roadmap pedía un modelo plano
(`concept`, `amount`, `date`, `category`, `recurring: boolean`); el alcance real que pidió el dueño
—"cada cuánto se paga, cuánto hay que retirar en total, y un historial mes con mes para saber si algo
cambió"— exige dos cosas que ese modelo no puede dar:

- **`frequency` en vez de `recurring: boolean`** (`once · weekly · monthly · bimonthly · quarterly ·
  semiannual · yearly`). Con un booleano, una anualidad de dominio y una mensualidad de Render son
  "lo mismo", y no hay forma de calcular ni cuándo se cobra ni cuánto apartar por mes.
- **El monto versionado en `expense_amounts`, no como columna del gasto.** Es lo que hace que el
  historial sea honesto: subir Render de $290 a $340 hoy **no reescribe** lo que costaba en julio, y
  el "¿algo cambió?" sale consultable del propio versionado (`changes` por mes) en vez de ser una
  corazonada sobre un total más alto. Un `amount` en `expenses` habría dejado dos fuentes de verdad
  (misma trampa que `redeemedCount` vs `activeRedemptions`).

Decisiones acordadas con el dueño antes de escribir código: **todo en MXN** (Render/Vercel cobran en
USD, pero se captura lo que cobró la tarjeta — un movimiento del dólar es un cambio de monto fechado,
no una conversión que se desactualiza en silencio); **categorías ENUM fijas** con `otro` (con texto
libre, `"Infra"`/`"infraestructura"`/`"INFRA"` serían tres grupos en la misma gráfica); y el KPI
renombrado de `GASTOS FIJOS` a **`GASTOS`** con el desglose en el subtítulo, porque con gastos de
única vez adentro "fijos" sería falso.

**Los dos números que no hay que confundir:** el **gasto real de un mes** se calcula generando las
fechas de cargo y atribuyendo cada una a su mes con el monto vigente en esa fecha (una anualidad cae
completa en su mes de renovación, no untada en el año), y la **carga mensual normalizada**
(`yearly ÷ 12`, `weekly × 52/12` — no `× 4`, el año tiene 52 semanas) responde "cuánto retirar" y es
lo que el dashboard prorratea. Los `once` valen 0 en el run-rate y cuentan completos en su mes.

**Trampas que costaron y quedaron cubiertas por tests:** las fechas son `DATEONLY` (un cargo es un
día de calendario — esquiva el problema de zona horaria que los cupones resolvieron con un offset
fijo) y Sequelize las devuelve como **string**, no `Date`; las ocurrencias se generan **por índice**
desde `startsAt` y no iterando, porque `setUTCMonth(+1)` desde el 31 de enero desborda al 3 de marzo
y, si se itera sobre el resultado clampeado, el día 31 se pierde para siempre (31 ene → 28 feb → **31
mar** es el comportamiento correcto); `monthlyRunRate` consulta `active` directo, porque `endsAt` es
inclusivo y sin eso una suscripción recién cancelada seguía sumando a "cuánto retirar" todo su último
día; y apagar un gasto **escribe `endsAt`** en vez de dejar que "hasta cuándo cobró" se infiera de
`updatedAt`, que cualquier otra escritura bumpea (la lección de `shipmentClaimedAt`, Fase O.3).

**La forma de `DashboardData` no cambió** (los KPIs siguen siendo `{label, value, trend, subtitle}`
genéricos), así que el panel no se rompe con este deploy, y el seed crea la fila de `$2,000/mes` para
que la GANANCIA NETA tampoco dé un salto.

- Tests: 2 suites nuevas y +38 casos — `tests/unit/services/expenses.test.ts` (21, nivel 1: el clamp
  de fin de mes, que un aumento no reescriba el pasado, los factores de run-rate, el historial sin
  huecos y `changes`) y `tests/integration/adminExpenses.test.ts` (17, nivel 2: el versionado de
  punta a punta, la corrección en su lugar por el índice único, y desactivar-vs-borrar), más los
  casos de `GASTOS` reescritos en `dashboard.test.ts`. Total del repo: **39 suites / 453 tests**.

**Cómo verificar:** `pnpm migrate` y `pnpm seed` → `GET /api/admin/dashboard` sigue mostrando los
$2,000 prorrateados, idéntico a antes. Dar de alta Render mensual $290 y un dominio anual $250 →
`GET /api/admin/expenses/summary` da `monthlyRunRate ≈ 310.83` y los próximos cargos con su fecha.
Subir Render a $340 con vigencia del mes en curso → `GET /api/admin/expenses/history` conserva $290
en los meses anteriores y trae la fila en `changes` con `previousAmount: 290`. Un gasto de única vez
de $1,500 de hace tres días entra completo en la ventana de 7 días del KPI `GASTOS` y el subtítulo lo
separa de los recurrentes. Borrarlo responde `deactivated: true` y su gasto pasado sigue en el
historial.

---

### Fase N.4 — Aviso al dueño de venta nueva

**Objetivo:** enterarse de un pedido pagado sin abrir el panel.

**Por qué:** `alert.service.ts` solo manda correos cuando algo **falla** (guía de Skydropx, sweeper
con fallas repetidas). No hay nada para el evento más importante del negocio: una venta.

**Tareas:**
- [ ] Template `newOrderNotificationTemplate` (resumen del pedido + tallas + dirección + si requiere
  dropoff, que es dato operativo del dueño y aquí **sí** va).
- [ ] Disparo **fire-and-forget** desde `markOrderPaidFromWebhook`, bajo el mismo guard
  `affected === 1` que ya protege el correo de confirmación — así no puede duplicarse ni bloquear el
  `200` del webhook.
- [ ] Destino: reusar `ALERT_EMAIL_TO` o una env var propia (`OWNER_NOTIFICATION_EMAIL`) para poder
  separar alertas técnicas de avisos de venta.
- [ ] WhatsApp (evaluar, no comprometido): requiere proveedor (Twilio / WhatsApp Cloud API), cuenta
  de negocio verificada y costo por mensaje. Vale la pena solo si el correo no basta en la práctica.
- [ ] Tests: un pedido pagado dispara un aviso; webhook y sweeper concurrentes → uno solo.

---

### Fase N.5 — Bitácora de auditoría

**Objetivo:** saber quién hizo qué en el panel.

**Por qué:** `owner` y `admin` tienen permisos idénticos por diseño (no hay `requireRole` en ninguna
ruta) y varias acciones son destructivas e irreversibles: borrar un producto, cancelar un pedido con
reembolso real, borrar un usuario, aplicar un import masivo que **suma** stock sin deshacer. Con más
de una persona en el panel, no queda ningún rastro de quién lo hizo.

**Tareas:**
- [ ] Modelo `AuditLog` (`adminUserId`, `action`, `entity`, `entityId`, `before`/`after` en `JSONB`,
  `ip`, `createdAt`) + migración.
- [ ] Registrar en los puntos destructivos, con llamadas explícitas (no un middleware genérico: el
  valor está en el `before`/`after`, que solo el controlador conoce): delete de producto, cancel de
  orden, `PATCH` de estado (O.1), delete de usuario, commit de import masivo, cambios de precio.
- [ ] `GET /api/admin/audit` `[auth]` paginado y filtrable por entidad/usuario.
- [ ] Definir retención (¿90 días? ¿un año?) y si se purga con un cron o se deja crecer.
- [ ] Tests + `@openapi` + fase 🔴 en el roadmap del frontend.

---

### Fase N.6 — Facturación CFDI `[evaluar antes de comprometer]`

**Objetivo:** emitir factura fiscal cuando el cliente la pida.

**Por qué está al final:** es de lejos la fase más pesada de este documento y la única que depende de
requisitos legales y de un proveedor externo de pago. No se compromete hasta que el negocio confirme
que la necesita.

**A resolver antes de escribir código:**
- [ ] ¿El negocio la necesita hoy? (régimen fiscal, volumen, si los clientes la piden de verdad).
- [ ] Proveedor: Facturama · SW Sapien · Finkok. Comparar costo por timbre, calidad de la API y
  soporte de sandbox.
- [ ] Datos fiscales del cliente: hoy `createOrderSchema` **no** los pide (RFC, régimen, uso de CFDI,
  CP fiscal). ¿Se capturan en el checkout o en un flujo aparte, posterior a la compra?
- [ ] Cancelación de factura cuando se cancela/reembolsa un pedido — se engancha con
  `cancelOrderByAdmin`.

**Tareas (una vez decidido):**
- [ ] Modelo `Invoice` + migración; datos fiscales opcionales en `Order`.
- [ ] Servicio de timbrado con el patrón de siempre (`src/config/<proveedor>.ts` con `dotenv.config()`
  propio y hard-require, cliente compartido, errores tipados) y **mockeado en tests**.
- [ ] Endpoints de solicitud y descarga (PDF/XML) + envío por correo.

---

## Pendientes heredados

Los dos diferidos de los roadmaps ya cerrados. Se recogen aquí porque este pasa a ser el documento
activo — hay que revisarlos **cerca del 1 de octubre**:

- [ ] **Verificar dominio en Resend** (`roadmaps-completados/ROADMAP.md` §Fase 9). Paso manual de DNS,
  sin código. **Bloquea el lanzamiento**: sin dominio verificado, `EMAIL_FROM` tiene que ser
  `onboarding@resend.dev` y Resend solo entrega al correo del dueño de la cuenta — un `403` silencioso
  para cualquier cliente real. Todos los correos de esta fase (confirmación, envío, seguimiento)
  dependen de esto.
- [ ] **Evaluar rate limiting en el catálogo público** (`roadmaps-completados/roadmap-hardening.md`
  §Fase H.3): `GET /api/products` y `GET /api/products/:id` no tienen límite. Medir tráfico real
  primero — un límite mal calibrado en el catálogo le pega a compradores legítimos.

---

## Notas

- **El bloque O no agrega features**, cierra caminos que el código ya abre y nunca termina. Por eso
  va antes del lanzamiento: cada uno de sus cinco puntos tiene como plan B "entrar a la base de datos
  a mano", que no es un plan.
- **O.1 + O.2 + O.3 son las de mayor relación impacto/esfuerzo.** Ninguna necesita dependencias
  nuevas y solo O.4 requiere migración. Entre las tres tapan los tres estados en que el dueño se
  queda atorado.
- **El bloque N no está ordenado por valor**, sino agrupado. N.1, N.2 y N.3 ya están cerradas —con
  N.3, `profitKpisByPeriod` dejó de restar una constante inventada—. De las que quedan, **N.4 (aviso
  de venta)** es la de mayor relación impacto/esfuerzo: no necesita modelo nuevo ni migración.
- **N.6 (CFDI) puede volverse urgente por razones ajenas al código.** Si el negocio lo necesita,
  brinca la fila entera.

---

## Checklist maestro

**Bloque O — antes del 1 de octubre**

- [x] **O.1** — `PATCH /api/admin/orders/:id/status` + tracking manual + correo de envío con guard único
- [x] **O.2** — Idempotencia en `POST /api/orders` (devuelve el original, no `409`)
- [x] **O.3** — Reintento de guía Skydropx + liberación del centinela huérfano
- [x] **O.4** — `GET /api/orders/lookup/:token` (consulta pública con token opaco)
- [x] **O.5** — `GET /health/ready` con chequeo real de BD

**Bloque N — features de negocio**

- [x] **N.1** — Búsqueda (`q`), orden y rango de precio en el catálogo
- [x] **N.2** — Cupones (modelo + validación + canje atómico + congelado en la orden)
- [x] **N.3** — Gastos reales sustituyendo `GASTOS_FIJOS`
- [ ] **N.4** — Aviso de venta nueva al dueño
- [ ] **N.5** — Bitácora de auditoría admin
- [ ] **N.6** — Facturación CFDI (evaluar primero)

**Heredados**

- [ ] Dominio verificado en Resend (bloquea el lanzamiento)
- [ ] Evaluar rate limit en el catálogo público
