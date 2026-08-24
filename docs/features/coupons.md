# Cupones y códigos de descuento (Fase N.2)

`src/models/Coupon.ts`, `CouponRedemption.ts`, `src/services/coupon.service.ts`,
`src/schemas/coupon.ts`, `src/utils/emailIdentity.ts`; `POST /api/coupons/validate` `[público]` + CRUD
en `/api/admin/coupons` `[auth]`.

La única palanca de descuento que no toca el catálogo. El cliente manda un **código** y **jamás un
monto** — misma regla que ya rige precios y envío. `Coupon` lleva `code` (alfanumérico en mayúsculas,
índice único), `type: percent|fixed`, `value`, `maxDiscount?` (tope en pesos, **solo** para `percent`),
`minSubtotal?`, `maxRedemptions?` (`null` = ilimitado), `redeemedCount`, `oncePerCustomer` (default
`true`), `startsAt?`/`expiresAt?`, `active` (ponerlo en `false` **es** "cancelar el cupón") y
`description?`. Puede haber varios activos, pero **uno solo por compra** (`couponCode` es un `string`).

**El descuento se calcula en `computeCouponDiscount` (`src/services/cart.ts`)**, única implementación,
compartida por `createOrder` y por `/validate` — si fueran dos, el preview podría prometer un descuento
distinto al que se cobra. `computeTotals` **no se tocó** (su test unitario afirma con `toEqual` sobre
exactamente cuatro claves, y lo que hacía falta compartir no eran "totales" sino "cuántos pesos quita
este cupón"). Tres invariantes, cada uno tapando una forma distinta de perder dinero:

1. La base es la **mercancía neta `subtotal − savings`** — aquí `subtotal` está a precio *original*,
   así que calcular sobre él regalaría porcentaje sobre un precio que nadie paga, y un `minSubtotal` de
   $1000 se cumpliría con un carrito que vale $600.
2. **El envío no entra**, y no es un parámetro de la función justamente para que no pueda colarse (un
   cupón de producto no debe regalar la paquetería, que se paga a un tercero).
3. **Clamp a `[0, neto]`**: un `fixed` de $5,000 sobre un carrito de $1,600 descuenta $1,600 y nunca
   deja un total negativo.

Todo se calcula en **centavos enteros** con un solo redondeo antes de tocar la BD: la columna es
`DECIMAL(10,2)` y sin eso Postgres redondearía por su cuenta (medio hacia afuera del cero) mientras
`/validate` —que no pasa por la BD— mostraría el de JS (medio hacia arriba), difiriendo un centavo en
los porcentajes que caen justo a la mitad. **El invariante nuevo de toda la app es
`total = subtotal − savings − couponDiscount + shipping`.**

**La identidad de "una persona" es el correo del pedido, NO la IP** (`normalizeEmailIdentity`:
minúsculas, `+tag` recortado en todos los dominios, puntos quitados solo en
`gmail.com`/`googlemail.com`). La IP era la opción intuitiva y es la peor: detrás de CGNAT (cualquier
plan móvil, Izzi, Totalplay) media colonia sale por una sola dirección, y además `req.ip` depende de
`TRUST_PROXY` — desplegado detrás de un proxy sin esa env, **todos** los compradores se ven con la IP
del proxy y el primer canje mataría el cupón para la tienda entera. Se guarda en
`coupon_redemptions.ip` **solo como dato forense** (viaja como `CheckoutContext.clientIp` desde
`req.ip`, nunca desde el body) y ninguna decisión la consulta. La normalización **sobre-fusiona a
propósito** (alguien cuyo buzón realmente distinto sea `juan+trabajo@` queda bloqueado, y por eso el
mensaje de error nombra el correo). La barrera **dura** contra el abuso no es la identidad sino
`maxRedemptions`: acota la pérdida máxima a `usos × descuento` sin importar quién canjee.

**El canje es atómico y va dentro de la transacción del checkout**, con dos candados y ningún `SELECT`
+ `if` (dos compradores simultáneos leerían los dos "sí se puede"):

1. El tope global es un `Coupon.update({ redeemedCount: literal('"redeemedCount" + 1') }, { where: {
   id, active: true, maxRedemptions IS NULL OR redeemedCount < maxRedemptions, + ventana de vigencia
   } })` — `affected === 0` es el 409, misma forma que el descuento de stock. **Ojo con las
   comillas**: la columna es camelCase y Postgres pliega a minúsculas los identificadores sin comillas,
   así que `literal('redeemedCount + 1')` buscaría `redeemedcount` → 500.
2. El "un uso por cliente" lo decide el **índice único parcial** `coupon_redemptions (couponId,
   emailNormalized) WHERE releasedAt IS NULL AND enforced`, vía un `INSERT ... ON CONFLICT ... DO
   NOTHING` crudo y **no** un `try/catch` del `UniqueConstraintError`: un error `23505` deja la
   transacción de Postgres **abortada** y, como Sequelize no envuelve `Model.create` en un savepoint,
   cualquier consulta posterior falla con *"current transaction is aborted"* — o sea que el `catch`
   natural (releer la fila que bloquea para armar un mensaje decente) daría un **500 en vez del 409**.
   Con `ON CONFLICT` no se levanta excepción y el conteo de filas es la señal.

Ese 409 lleva **dos mensajes** según el estado del pedido que bloquea — si es `pending`, "ya tienes un
pedido sin pagar que usa este cupón", porque cuando Stripe falla *después* del commit la Fase O.2
conserva la clave y el cupón queda apartado hasta que `pendingOrderSweeper` lo alcance (30 min).

**`coupon_redemptions.enforced`** existe porque el índice parcial **no puede consultar el flag del
cupón**: si el dueño apaga `oncePerCustomer` en un cupón vivo, las filas ya escritas seguirían
bloqueando esos correos para siempre. Se escribe fila para **todo** canje (es la bitácora —quién,
cuándo, cuánto, desde qué IP— y `releaseCouponForOrder` se apoya en su existencia), y solo las escritas
con el flag encendido participan en la restricción.

**La liberación del uso** (`releaseCouponForOrder`) es lo que el roadmap no pedía y sin lo cual la
promoción muere sola: el uso es una reserva igual que el stock, así que se devuelve **en el mismo punto
y dentro de la misma transacción** — en `releaseOrderStock` (que cubre a sus dos llamadores: el webhook
`payment_intent.canceled` y `pendingOrderSweeper`) y en la rama `paid` de `cancelOrderByAdmin`, después
del guard `status !== "paid"` para que dos cancelaciones concurrentes no decrementen dos veces. Sin
esto, un cupón de 50 usos se agota con carritos abandonados. Es auto-idempotente por el `UPDATE`
condicional (`releasedAt IS NULL`) y el decremento lleva `redeemedCount > 0`. **Un reembolso fallido no
libera** (el dinero no volvió), misma regla que el restock.

**`assertChargeableTotal`** valida el mínimo cobrable **antes** de persistir: si Stripe rechazara el
total, eso pasaría *después* del commit y —por `releaseKeyOnFailure` de la Fase O.2— con la clave
conservada, dejando un pedido `pending` que aparta stock y quema el cupón 30 min sin poder reintentar.
`MIN_CHARGE_MXN` vive en `coupon.service.ts` y **no en `src/config/stripe.ts`**: dos suites
(`cancelOrder.test.ts`, `pendingOrderSweeper.test.ts`) reemplazan ese módulo con un objeto literal de
exports fijos, así que un import nuevo resolvería a `undefined`, `total < undefined` sería `false`, y el
guard quedaría **muerto en todas las suites que mockean Stripe** mientras los tests pasan en verde.

**`checkoutFingerprint` incluye `couponCode`**: sin él el mismo carrito con y sin cupón daría la misma
huella, y al comprador que acaba de aplicar un descuento se le devolvería el pedido anterior **sin
descontarlo**. El código ya viene normalizado por `couponCodeSchema` (recortado y en mayúsculas). La IP
**no** entra: no es parte de la identidad del pedido, y un reintento desde otra red se leería como
pedido nuevo.

**`POST /api/coupons/validate`** `[público, couponRateLimiter 20/min]` valida **sin canjear** —ni mueve
`redeemedCount` ni escribe fila, así que abrir el checkout diez veces no gasta la promoción— y reusa
`assertProductAvailable` para que un producto oculto dé el mismo 409 que dará el checkout. El `email` es
**opcional** porque el campo del cupón vive en el paso 0 del checkout, antes de capturar los datos de
envío: sin correo no se verifica el uso por persona y la respuesta lo declara con
`perCustomerChecked: false`; `remainingRedemptions` es informativo y **no vinculante** (el tope global y
el uso por persona se re-deciden atómicamente al pagar, así que el front tiene que pintar el 409). Sus
mensajes **sí distinguen la causa** (no existe / venció / se agotó / no alcanza el mínimo), la inversión
deliberada de la regla anti-enumeración del resto del repo: un cupón existe para que un humano lo
teclee y un mensaje opaco lo volvería inusable. Consecuencia a decir en voz alta: **los códigos no son
secretos**, así que un cupón dirigido a una sola persona tiene que ser largo y aleatorio, nunca `VIP`.

**Reglas del CRUD admin.** `code` **no es editable** (ya pudo repartirse, y el `couponCode` congelado en
los pedidos dejaría de empatar; si está mal, desactivar y crear otro). `redeemedCount` **no entra en
ningún schema** (estado derivado que solo mueven el canje y la liberación). **Bajar `maxRedemptions` por
debajo de `redeemedCount` se permite y no se valida**: es justo el edit que hace un dueño para frenar
una promoción en caliente. `updateCoupon` re-valida las reglas cruzadas contra **el estado combinado**
(lo guardado + lo que cambia), porque los refines del schema solo ven el body y un `PUT` que manda solo
`maxDiscount` sobre un cupón `fixed` los pasaría. `DELETE` sigue el criterio de `adminDeleteProduct`:
**desactiva** si algún pedido lo usó, borra de verdad si no — y se cuentan **pedidos y no canjes**,
porque un canje liberado sigue siendo historia y una fila de canje puede desaparecer por cascada
mientras el pedido no. El listado devuelve `activeRedemptions` (conteo vivo) junto a `redeemedCount`
para que una divergencia (p. ej. un pedido borrado a mano, que se lleva su fila de canje por cascada) se
**vea** en vez de esconderse; ese es el riesgo residual asumido del `onDelete: "CASCADE"`.

**Fechas y zona horaria** (`couponDateSchema`): un `"2026-08-01"` interpretado como ISO es medianoche
**UTC**, o sea el 31 de julio a las 18:00 en México — el dueño perdería la última tarde de su promoción.
Una fecha sin hora se interpreta en `America/Mexico_City` (inicio de día para `startsAt`,
`23:59:59.999` para `expiresAt`); un instante ISO completo se respeta tal cual. Offset fijo `-06:00`
porque México no tiene DST desde 2022 y la tienda está en Celaya, GTO.

**Dónde aparece el cupón fuera del checkout:** la fila `Cupón <CÓDIGO> − $X` de
`orderConfirmationTemplate` va **después de "Ahorraste" y antes de "Envío"** (ese orden es la prueba
visual de que no tocó la paquetería) y la reciben los dos correos. `PublicOrderView` expone
`couponCode`/`couponDiscount` (sin ellos el total de la página de seguimiento no cuadraría) pero no
`couponId`. En `dashboard.service.ts`, `SaleRow` suma los dos campos —obligatorio, o la fila del panel
es irreconciliable— y hay un KPI nuevo **`DESCUENTOS POR CUPÓN`**: `agg.revenue += order.total` **se
queda** (ahora suma el efectivo realmente cobrado), pero sin ese KPI una campaña se leería como una
*caída* de ingresos aunque el volumen creciera. **`savings` no se toca** — sumar el cupón ahí falsearía
el margen. `reports.service.ts` **no cambia**: calcula `revenue = unitsSold × salePrice` actual, así que
los dos reportes son estructuralmente ciegos al cupón; su `totalRevenue` ya era ≥ caja real y el cupón
ensancha esa brecha, y **no** se "arregla" pasándolo a `order.total` porque rompería el desglose por
producto/categoría.
