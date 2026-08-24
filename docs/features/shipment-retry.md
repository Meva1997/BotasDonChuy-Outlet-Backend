# Reintento de guía (Fase O.3)

`POST /api/admin/orders/:id/shipment/retry` `[auth]` (`adminRetryShipment` →
`payment.service.retryShipmentForOrder(id)`) más el cron gemelo `src/services/shipmentRetrySweeper.ts`.

La guía se genera en **una sola** llamada fire-and-forget al confirmarse el pago; si falla (Skydropx caído,
saldo agotado, o el proceso muere a media creación) el pedido queda pagado y sin guía **para siempre** —
ningún webhook puede llegar por una guía que nunca se creó. Además cerraba mal el caso del **centinela
huérfano**: si el proceso moría entre el `UPDATE` que escribe `"creating"` y el `POST /shipments`, ese valor
quedaba en la fila y cualquier intento futuro se retiraba.

**Los valores especiales de `skydropxShipmentId`** son la pieza central, y separarlos fue lo que hizo seguro
el reintento:
- `"creating"` (`SHIPMENT_CREATION_SENTINEL`) = **solo** "alguien está creando la guía ahora", por eso
  liberarlo por antigüedad es seguro.
- `unreconciled:<id real>` (`unreconciledShipmentId()` lo desempaqueta) = "Skydropx ya la creó y **la
  cobró**, solo no se pudo guardar el id".
- `unreconciled:desconocido` (`UNCERTAIN_SHIPMENT_MARKER`) = "pudo haberla creado y cobrado, ni su id
  sabemos".

Antes los tres eran el mismo `"creating"`, así que un reintento por antigüedad habría pagado una **segunda**
guía en el peor caso. Ni el endpoint ni el barrido tocan una fila `unreconciled:` (el `WHERE` de
`pendingShipmentWhere` solo acepta `null` o el centinela exacto); el webhook de esa guía, si llega con un id
real, la sana sola.

**El caso incierto** (`SkydropxShipmentUncertainError`) es el que más cuesta si se trata mal: cada `fetch`
sale con `AbortSignal.timeout` de 5 s, así que un `POST /shipments` que Skydropx **sí procesó y cobró**
puede terminar en excepción. `createShipment` clasifica su propio fallo antes de propagarlo: un `4xx` (salvo
408/429) es un rechazo explícito —no creó ni cobró nada, seguro reintentar— mientras que un timeout, un
socket cortado o un `5xx` son **inciertos**. Para que la clasificación sea fiable, `createShipment` resuelve
el token OAuth **fuera** del `try` (un fallo de token nunca es incierto: el POST jamás salió). Un fallo
incierto marca la orden `unreconciled:desconocido` en vez de liberar el centinela —liberarlo es exactamente
lo que pagaría la segunda guía— y alerta incondicionalmente con severidad `fatal`. El webhook **no** puede
sanar este caso solo (no hay id que empatar), así que es el único que el dueño puede desbloquear con
`force`.

**Endpoint** (body opcional `{ force? }`, `retryShipmentSchema`): rechaza con `409` todo lo que no sea
"falta la guía y se puede generar" — guía real ya presente (con su id en el mensaje), `unreconciled:` (con
el id a buscar en el panel de Skydropx), `unreconciled:desconocido` (pidiendo verificar antes de forzar),
centinela reciente ("se está generando"), pedido `pending` o `cancelled`, pedido ya `shipped`/`delivered`
(ese es precisamente el camino del dueño que generó la guía a mano y la capturó con el `PATCH /status` de
la Fase O.1: sin este guard el botón cobraría una segunda guía por un pedido que ya salió), y pedido con
**tarifa plana de respaldo** (sin `skydropxRateId` no hay tarifa que convertir en guía). `force: true`
**solo** desbloquea `unreconciled:desconocido`, y significa "ya revisé el panel de Skydropx y no existe
ninguna guía". A diferencia del camino automático **espera el resultado** (`createShipmentForOrder` nunca
lanza, así que `attemptShipment` relee la fila y devuelve un `ShipmentAttempt` tipado — `created` ·
`in-progress` · `unreconciled` · `failed`) y responde `502` si Skydropx vuelve a fallar: el dueño está
mirando la respuesta. Dos reintentos concurrentes los serializa el mismo centinela.

**Liberación del huérfano**: `releaseOrphanSentinel` hace `UPDATE ... SET skydropxShipmentId = null WHERE
skydropxShipmentId = 'creating' AND (shipmentClaimedAt IS NULL OR shipmentClaimedAt < now −
SHIPMENT_RETRY_DELAY_MINUTES)` (15). La antigüedad se mide con **`orders.shipmentClaimedAt`**, columna
propia poblada al reclamar el centinela (migración `20260728120000-orders-shipment-claimed-at.ts`), y no con
`updatedAt`: cualquier otra escritura sobre el pedido lo bumpea, así que un pedido realmente atorado en
`"creating"` reiniciaba su reloj cada vez que el dueño lo tocaba desde el panel. Las filas anteriores a la
columna quedan en `NULL` y cuentan como huérfanas de inmediato, que es lo correcto. Un intento normal se
resuelve o falla en segundos, así que 15 min nunca le quita el turno a una creación real en vuelo, y el
`WHERE` condicional hace que dos liberaciones concurrentes no puedan ganar las dos. Esa misma columna acota
el `pendingCreation` del webhook: solo un centinela **reciente** justifica pedir reintento con un `503`.

**Todas las escrituras de este flujo van condicionadas al centinela**, incluida `persistShipmentId`: sin esa
condición, una creación lenta cuyo centinela ya se liberó podía pisar en su intento 2 o 3 lo que un intento
más nuevo hubiera escrito (otro id real, o un marcador `unreconciled:`), borrando justo el dato que un
humano necesita para reconciliar. Cuando el `UPDATE` no afecta ninguna fila (`claim-lost`) la guía **ya está
cobrada** y no se toca nada: se alerta `fatal` para que alguien revise si el pedido terminó con dos guías.

**Barrido automático** (`shipmentRetrySweeper.ts`, arrancado/detenido en `app.ts`, saltado bajo
`NODE_ENV=test`, timer `unref()`ado): cada `SHIPMENT_RETRY_SWEEP_INTERVAL_MINUTES` (10) toma hasta 20
pedidos `paid` **con** `skydropxQuotationId` **y** `skydropxRateId` (los dos, porque
`createShipmentForOrder` exige ambos y se retira sin llamar a Skydropx si falta cualquiera — filtrar solo por
el rate metía en cada ciclo pedidos que gastaban sus tres intentos y disparaban la alerta sin una sola
llamada) creados en las últimas **24h** (`MAX_ORDER_AGE_HOURS`: pasado ese punto el fallo no es transitorio y
hace falta una decisión humana) que sigan sin guía pasados los 15 min, y reintenta **secuencialmente** (el
límite de 2 req/s es de la cuenta entera y lo comparten los checkouts en vivo). Solo el desenlace `failed`
gasta intento: `in-progress` (otra llamada tiene el centinela) no es un fallo, y `unreconciled` ya alertó por
su cuenta. Tras `MAX_ATTEMPTS_PER_ORDER` (3) fallos manda **una** alerta y deja de intentar; esos pedidos se
excluyen **en la consulta** (`id NOT IN`) y no con un `continue`, porque si no seguirían ocupando lugares del
`LIMIT` y —con el orden `createdAt ASC`— veinte pedidos atorados al frente dejarían sin turno a todos los más
nuevos. El contador es un `Map` en memoria con el momento del último intento, deliberadamente **no
persistido**; caduca **por tiempo** (`MAX_ORDER_AGE_HOURS`) y no por "no apareció en este ciclo", que era lo
que hacía que un pedido rotando dentro y fuera de la página del `LIMIT` reiniciara su cuenta y volviera a
alertar. `sweepShipmentsOnce` y `resetShipmentRetryAttempts()` se exportan para los tests.

Por eso `createShipmentForOrder` acepta `{ notifyOnFailure }` (default `true`): el camino automático sigue
alertando al instante, mientras que el reintento manual y el barrido lo apagan porque ya tienen canal propio
— si no, cada ciclo mandaría un correo. Los casos `unreconciled:` alertan **siempre**, ignorando la bandera.

**Riesgo residual asumido:** si la BD está caída lo suficiente para que también falle el marcado
`unreconciled:`, la fila queda en `"creating"` y a los 15 min el barrido podría pagar una segunda guía. Por
eso la alerta de ese caso es incondicional y `fatal`.
