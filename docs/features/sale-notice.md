# Aviso de venta al dueño (Fase N.4)

`src/services/ownerNotification.service.ts`, `dailySalesDigest.ts`,
`src/services/email/templates/newOrderNotification.ts` + `dailySalesDigest.ts`, `src/utils/storeDay.ts`.

Hasta esta fase `alert.service.ts` solo mandaba correo cuando algo **fallaba**, y no había nada para el
evento más importante del negocio — una venta. Son **dos correos que responden preguntas distintas**: el
**aviso por venta** es un *disparador de acción* ("empaca esto") y el **resumen diario** es
*reconciliación* ("cómo cerró el día"). Con solo el resumen, un pedido de las 3pm no se conocería hasta el
corte del día siguiente — hasta un día de retraso en despachar. Van a `OWNER_NOTIFICATION_EMAIL` con
**fallback a `ALERT_EMAIL_TO`** (resuelto en cada llamada, no al cargar el módulo, igual que
`sendAlertEmail`); **sin ninguna de las dos la fase queda apagada**, y ese es su interruptor. Sin dominio
verificado en Resend esta fase **sí funciona**, a diferencia de los correos al cliente: el destinatario *es*
el dueño de la cuenta.

**El aviso por venta** se dispara fire-and-forget desde `markOrderPaidFromWebhook` **dentro del guard
`affected === 1`**: ese `UPDATE` condicional ya serializa a nivel de BD el webhook de Stripe y
`pendingOrderSweeper`, así que sale exactamente una vez sin dedup propia (`idempotencyKey:
new-order/${id}` es el segundo cinturón). **No espera a `createShipmentForOrder`**: los dos datos
operativos que lleva (`skydropxRateId` y `shippingRequiresDropoff`) se persisten en el checkout, así que
encadenarlo solo retrasaría el aviso — o lo perdería si Skydropx falla. **Recarga el pedido en una
instancia nueva (`Order.findByPk`), nunca con `order.reload()`**: el correo de confirmación se dispara en
paralelo sobre esa misma instancia y también la recarga con otros `attributes`, y dos `reload()`
concurrentes se pisan a media renderización. El **asunto es autocontenido a propósito** (`Venta #142 —
$1,850.00 — 3 piezas`, con sufijo ` — GUÍA MANUAL` cuando `!skydropxRateId`): para que a 20–30 ventas
diarias siga sin ser ruido tiene que poder leerse **sin abrirlo**. El cuerpo lleva tallas, cantidades,
dirección con referencias y **el contacto completo del cliente** (a diferencia de `PublicOrderView`: son
los datos con los que el dueño resuelve un problema de entrega), más los dos **bloques de acción** que son
su razón de ser: `!skydropxRateId` ("se cobró con tarifa plana, genera la guía a mano") y
`shippingRequiresDropoff` ("hay que llevarlo a la sucursal"). **Nunca `unitCost` ni margen**, aunque el
correo sea del dueño: un correo no está autenticado, se reenvía y vive en una bandeja.

**El resumen diario** (`startDailySalesDigest`/`stopDailySalesDigest` en `app.ts` junto a los otros crons,
saltado bajo `NODE_ENV=test`, timer `unref()`ado) sale a las **`DAILY_DIGEST_HOUR` (8) hora de Celaya y
cubre el día anterior COMPLETO**: un corte a las 21:00 sería más inmediato pero truncado, y las ventas de
la noche no caerían en ningún resumen. Cada `DAILY_DIGEST_CHECK_INTERVAL_MINUTES` (15) `runDigestTick`
mira la hora local y, pasada la hora, manda el resumen de ayer si no lo ha mandado. **La ventana es un día
LOCAL, no UTC**, y de ahí `src/utils/storeDay.ts` — aparte de `src/utils/date.ts`, cuyo encabezado
garantiza que todo lo suyo está fijado a UTC para estabilidad de agregación: un "ayer" en UTC cubriría de
las 18:00 de antier a las 18:00 de ayer y **se comería la tarde-noche**, horario pico de compra. Offset
fijo `-06:00`; `MEXICO_CITY_OFFSET` se comparte con `src/schemas/coupon.ts`. Ojo con `storeHour`: usa
**`hourCycle: "h23"` y no `hour12: false`**, porque con este último varias versiones de ICU formatean la
medianoche como `"24"` y el resumen saldría a medianoche.

**Dos capas de idempotencia, y la segunda no es memoria**: `lastSentDay` vive en el módulo (misma decisión
y limitación asumida que los mapas de los otros crons) y **no sobrevive a un redeploy**, así que la segunda
es el **`idempotencyKey: daily-sales/<día>` de Resend**, cuya ventana de 24 h coincide con la cadencia
diaria y cubre el redeploy *y* varias instancias sin columna nueva. Se marca `lastSentDay` **antes** de
mandar (la función nunca lanza; reintentar en cada tick solo repetiría las consultas). **Se manda también
los días sin ventas** — un correo que no llega es ambiguo (¿día flojo o cron muerto?) y sirve de latido.
Tras una caída de varios días manda **solo el más reciente**, no un backfill. La ventana se mide sobre
**`createdAt`** porque **no existe columna `paidAt`** y agregarla exigiría un backfill imposible de
reconstruir, además de que el dashboard también agrupa por `createdAt`; consecuencia asumida: un pedido
creado 11:55pm y pagado 00:05 cuenta en el día anterior. El resumen filtra **`paymentStatus: "paid"`** (ver
**Dashboard**: filtrar por `status` le quitaría justo los pedidos despachados ese mismo día, lo peor que le
puede pasar a un correo de reconciliación). Trae totales del día y tabla por pedido con su hora local, y
una sección **"requieren acción"** con los pedidos sin guía (`skydropxShipmentId` en `null` o el centinela)
o con dropoff. **No compara contra el día anterior** (se probó y se quitó: un correo con el propio día en
cero junto a un día previo con ventas se leía como "perdiste dinero" en vez de "hoy no hubo ventas" — el
resumen reporta exclusivamente el día que cubre). `runDigestTick(now?)` acepta el instante para situarse a
una hora concreta en los tests sin timers falsos, y `resetDailySalesDigestState()` se exporta **solo para
tests**.

`escapeHtml` se extrajo de `orderConfirmation.ts` a **`src/services/email/templates/escapeHtml.ts`**: con
tres plantillas, tres copias de una función de escape es lo que se desincroniza. **Sin migración, sin
columnas y sin rutas nuevas** ⇒ sin `@openapi` y **sin fase en el roadmap del frontend**. WhatsApp/Twilio
**descartado** en esta fase (proveedor, cuenta de negocio verificada y costo por mensaje para un problema
que el correo resuelve a este volumen).
