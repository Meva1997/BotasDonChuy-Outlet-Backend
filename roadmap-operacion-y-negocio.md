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
| Consulta de pedido por el cliente | ❌ ausente | Si borra el correo, escribe por WhatsApp; toda consulta de estado es trabajo manual del dueño |
| Readiness real en `/health` | ❌ superficial | El healthcheck pasa en verde con Postgres caído |
| Búsqueda/orden en el catálogo | ❌ solo `categoria`/`talla` | Con el catálogo creciendo por import masivo, el cliente no encuentra lo que busca |
| Cupones / códigos de descuento | ❌ ausente | Sin la palanca de marketing más barata que existe |
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

### Fase O.4 — Consulta pública de pedido

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
- [ ] Migración: `orders.publicToken` (UUID, nullable por las filas existentes, índice único).
  Backfill de las órdenes ya creadas en la misma migración.
- [ ] Generar el token en `orders.service.createOrder` e incluir el link en
  `orderConfirmationTemplate` (ya recibe `FRONTEND_URL`).
- [ ] `GET /api/orders/lookup/:token` `[público]` con proyección explícita + rate limiter propio.
- [ ] Tests: token válido devuelve estado/tracking; token inválido → `404` genérico; la respuesta
  **no** contiene `unitCost`, `paymentIntentId` ni `shippingRequiresDropoff`.
- [ ] Fase 🔴 en el roadmap del frontend (página de seguimiento).

**Cómo verificar:** completar un checkout, abrir el link del correo → estado y tracking correctos;
cambiar un carácter del token → `404` sin filtrar si la orden existe.

---

### Fase O.5 — Readiness real en el healthcheck

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
- [ ] `GET /health/ready` con `sequelize.authenticate()` + timeout corto → `200`/`503`.
- [ ] Documentar en `README.md` cuál probe apunta a cuál en el deploy.
- [ ] Test de smoke (con la BD de test arriba, `/health/ready` responde `200`).

**Cómo verificar:** bajar Postgres con el server corriendo → `/health` sigue `200`, `/health/ready`
responde `503`.

---

# BLOQUE N — Features de negocio (sin orden obligatorio)

### Fase N.1 — Búsqueda, orden y filtros en el catálogo

**Objetivo:** que `GET /api/products` sirva para encontrar productos, no solo para paginarlos.

**Por qué:** hoy solo filtra `categoria` y `talla`. No hay búsqueda por texto, ni orden por precio,
ni rango de precios. Con el import masivo de Excel el catálogo va a crecer en lotes de hasta 500
filas por archivo, y ahí un listado sin búsqueda deja de ser navegable rápido.

**Tareas:**
- [ ] `q`: busca en `name` y `code` con `ILIKE '%q%'`, **escapando `%` y `_` del valor del usuario**.
  Ya hay precedente documentado de este bug en el import (`iLike` sin escapar hacía que una fila
  `"Bota%Premium"` emparejara y **renombrara** otro producto) — mismo cuidado aquí.
- [ ] `orden`: `precio_asc` · `precio_desc` · `novedad` (`id DESC`) · default actual (`id ASC`).
- [ ] `precioMin` / `precioMax` sobre `salePrice`, validados como números antes de tocar SQL (misma
  regla que `talla` con `Number.isInteger`).
- [ ] Todo **en SQL**, con el `where` compartido entre el `count` y el `findAll` (como ya está hecho).
- [ ] Índices en migración: `products(type)`, `products(salePrice)` y `pg_trgm` sobre `name` si la
  búsqueda por texto se siente lenta con catálogo real.
- [ ] Tests + `@openapi` (los query params nuevos van en el bloque existente).
- [ ] Fase 🔴 en el roadmap del frontend.

---

### Fase N.2 — Cupones y códigos de descuento

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
- [ ] Modelo `Coupon` (`code` único, `type: percent|fixed`, `value`, `minSubtotal?`,
  `maxRedemptions?`, `redeemedCount`, `startsAt?`, `expiresAt?`, `active`) + migración + asociación.
- [ ] Columnas `couponCode`/`couponDiscount` en `Order` (misma migración o una gemela).
- [ ] `POST /api/coupons/validate` `[público, rate-limited]` para que el checkout muestre el
  descuento antes de pagar (validación, **sin** canjear).
- [ ] CRUD admin `/api/admin/coupons` `[auth]`.
- [ ] Aplicación real en `computeTotals` + canje atómico en `createOrder`.
- [ ] Reflejarlo en `orderConfirmationTemplate` y decidir su tratamiento en dashboard/reportes.
- [ ] Tests: cupón expirado/agotado/mínimo no alcanzado; canje concurrente del último uso → uno solo
  gana; el descuento se recalcula server-side aunque el cliente mande otro monto.
- [ ] Fase 🔴 en el roadmap del frontend.

---

### Fase N.3 — Gastos reales (sustituye `GASTOS_FIJOS`)

**Objetivo:** que el KPI de utilidad del dashboard use gastos capturados, no una constante.

**Por qué:** `GASTOS_FIJOS = $2,000` está hardcodeado en `dashboard.service.ts` con el comentario
"no existe un modelo de gastos". Mientras siga ahí, `profitKpisByPeriod` es un número inventado, y
es justo el número que el dueño usa para decidir si el negocio gana dinero.

**Tareas:**
- [ ] Modelo `Expense` (`concept`, `amount`, `date`, `category`, `recurring: boolean`) + migración.
- [ ] CRUD `/api/admin/expenses` `[auth]` con filtro por rango de fechas.
- [ ] `dashboard.service.ts`: sustituir la constante por la suma real, prorrateada por ventana con
  la misma lógica que hoy (`× windowDays/30`). Los gastos `recurring` cuentan cada mes; los de una
  sola vez, solo en su mes.
- [ ] Seed: migrar los `$2,000` actuales a una fila de gasto recurrente, para que el dashboard no
  cambie de golpe el día del deploy.
- [ ] Tests de la agregación (nivel 1, sin BD, como el resto de `dashboard.service`).
- [ ] Fase 🔴 en el roadmap del frontend.

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
- **El bloque N no está ordenado por valor**, sino agrupado. Si hay que elegir una sola, **N.2
  (cupones)** es la que más mueve ventas; **N.3 (gastos)** es la que más corrige lo que el dueño ya
  está viendo mal hoy.
- **N.6 (CFDI) puede volverse urgente por razones ajenas al código.** Si el negocio lo necesita,
  brinca la fila entera.

---

## Checklist maestro

**Bloque O — antes del 1 de octubre**

- [x] **O.1** — `PATCH /api/admin/orders/:id/status` + tracking manual + correo de envío con guard único
- [x] **O.2** — Idempotencia en `POST /api/orders` (devuelve el original, no `409`)
- [x] **O.3** — Reintento de guía Skydropx + liberación del centinela huérfano
- [ ] **O.4** — `GET /api/orders/lookup/:token` (consulta pública con token opaco)
- [ ] **O.5** — `GET /health/ready` con chequeo real de BD

**Bloque N — features de negocio**

- [ ] **N.1** — Búsqueda (`q`), orden y rango de precio en el catálogo
- [ ] **N.2** — Cupones (modelo + validación + canje atómico + congelado en la orden)
- [ ] **N.3** — Gastos reales sustituyendo `GASTOS_FIJOS`
- [ ] **N.4** — Aviso de venta nueva al dueño
- [ ] **N.5** — Bitácora de auditoría admin
- [ ] **N.6** — Facturación CFDI (evaluar primero)

**Heredados**

- [ ] Dominio verificado en Resend (bloquea el lanzamiento)
- [ ] Evaluar rate limit en el catálogo público
