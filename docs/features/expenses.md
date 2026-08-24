# Gastos y suscripciones (Fase N.3)

`src/models/Expense.ts`, `ExpenseAmount.ts`, `src/services/expenses.service.ts`,
`src/schemas/expense.ts`; CRUD + `/summary` + `/history` en `/api/admin/expenses` `[auth]`.

Sustituye la constante `GASTOS_FIJOS = 2000` que `dashboard.service.ts` restaba para calcular **GANANCIA
NETA** — el KPI que el dueño usa para decidir si el negocio gana dinero era un número inventado.

**El monto NO es una columna de `expenses`: vive versionado en `expense_amounts`** (`amount`,
`effectiveFrom DATEONLY`, `note`), y esa separación es toda la fase. El monto vigente es *la versión con
el `effectiveFrom` más grande que ya empezó* y el de julio es *la vigente en julio*, así que subir Render
de $290 a $340 **no reescribe** lo que costaba en meses cerrados. Guardar además un `expenses.amount`
"actual" habría dejado dos fuentes de verdad que se desincronizan con el primer edit mal hecho (mismo
riesgo que `redeemedCount` vs `activeRedemptions`); las tablas son de decenas de filas, así que
`currentAmount` se **calcula** en memoria. El **índice único parcial** `(expenseId, effectiveFrom)`
—declarado en `Model.init` además de en la migración, por `sync({ force: true })`— no es contabilidad:
convierte "re-editar el monto que capturé hoy" en una **corrección en su lugar** en vez de una versión
duplicada que dejaría el historial ambiguo. Esa misma lista alimenta el arreglo **`changes`** de cada mes
en `/history`, la respuesta consultable a "¿algo cambió?" — sin él un aumento solo se nota como un total
más alto sin causa visible.

**Todo en MXN**, sin `currency` ni tipo de cambio: Render y Vercel cobran en USD, pero lo que se captura
es lo que cobró la tarjeta, así que un movimiento del dólar **es** un cambio de monto y queda fechado en
el historial. Un `fxRate` por gasto se descartó porque se desactualiza en silencio.

**Dos números distintos, los dos necesarios, y confundirlos es el error caro:**
1. El **gasto real de un mes** (`buildHistory`) se calcula **generando las fechas de cargo** desde
   `startsAt` acotadas por `endsAt`/`active`, atribuyendo cada ocurrencia a su mes con el monto vigente
   **en esa fecha** — así una anualidad cae completa en su mes de renovación y no untada en el año.
2. La **carga mensual normalizada** (`monthlyRunRate`) convierte cada recurrente a su equivalente por mes
   vía `MONTHLY_FACTOR` (`yearly ÷ 12`, `quarterly ÷ 3`, **`weekly × 52/12` y no `× 4`** — usar 4
   subestima el año en casi un mes completo), responde "cuánto retirar cada mes" y es lo que el dashboard
   prorratea por `windowDays/30`. Los `once` valen 0 en el run-rate: cuentan completos en su mes y nunca
   más.

**Trampas ya resueltas.** Las fechas son **`DATEONLY`** porque un cargo es un día de calendario, no un
instante — esquiva de raíz el problema de zona horaria que `couponDateSchema` tuvo que resolver; **ojo,
Sequelize las devuelve como string `"YYYY-MM-DD"`, no como `Date`** (de ahí `utcDayFromIso` en
`src/utils/date.ts`, y que las comparaciones sean de strings, que para ese formato ya son cronológicas).
Las ocurrencias se generan **por índice** desde `startsAt` (`addMonthsClamped(anchor, n × paso)`) y
**nunca iterando sobre la fecha ya calculada**: iterar con `setUTCMonth(+1)` desde el 31 de enero
desborda al 3 de marzo, y si se itera sobre el resultado clampeado (28 feb → 28 mar) el día 31 se pierde
para siempre; por índice sale 31 ene → 28 feb → **31 mar**. `monthlyRunRate` consulta `active`
**directamente** y no vía `effectiveEnd`: apagar un gasto le fija `endsAt` en hoy y, como `endsAt` es
inclusivo (un cargo fechado ese día sí cuenta, y así debe ser para las ocurrencias), sin ese guard la
suscripción recién cancelada seguiría sumando a "cuánto retirar" el día entero de su cancelación. Y
**apagar escribe `endsAt`** en vez de dejar que "hasta cuándo cobró" se infiera de `updatedAt`, que
cualquier otra escritura bumpea — la lección de `shipmentClaimedAt` (Fase O.3); reactivar limpia un
`endsAt` viejo salvo que el body mande uno.

**`monthRange` se movió de `reports.service.ts` a `src/utils/date.ts`** y ahora la comparten el reporte
mensual de ventas y el historial de gastos: los dos necesitan el mismo rango sin huecos y el mismo clamp
de `from > to`.

**Reglas del CRUD.** `PUT` con `amount` **agrega una versión** (con `amountEffectiveFrom` o hoy), salvo
que ya exista una con esa misma vigencia (se corrige en su lugar) o que el monto no haya cambiado (editar
el concepto no debe ensuciar el historial de precios). La primera versión de un alta rige desde
**`startsAt`, no desde hoy**: registrar en agosto una suscripción que empezó en marzo tiene que dejar
cubiertos los cargos de marzo a julio. `DELETE` sigue el criterio de `deleteCoupon`/`adminDeleteProduct`:
**desactiva** (con `endsAt` en hoy) si el gasto ya generó algún cargo —ese dinero se gastó y borrarlo
dejaría el historial mintiendo sobre meses cerrados— y solo borra de verdad lo que nunca cobró nada. El
filtro `from`/`to` del listado es por **fecha de cargo y no por alta**. Los parámetros inválidos aquí son
**`400`, no se ignoran** (la inversión deliberada de la regla del catálogo público: quien consulta es el
dueño, y un filtro que no aplicó le haría leer mal sus propios números). Las categorías son un **ENUM
fijo** (`infraestructura`, `software`, `renta`, `servicios`, `paqueteria`, `publicidad`, `nomina`,
`impuestos`, `otro`) y no texto libre, porque con texto libre `"Infra"`/`"infraestructura"`/`"INFRA"`
serían tres grupos distintos en la misma gráfica; agregar una es un `ALTER TYPE ... ADD VALUE`, y los
catálogos se repiten literales en la migración (no se importan de `models/Expense.ts`, que arrastraría
`config/database.ts` a un proceso que no debe abrir una segunda conexión) — **al agregar un valor, tocar
los dos lados**.

**En el dashboard**, `buildKpisForWindow` recibe el run-rate y un `Map<isoDay, amount>` de gastos de única
vez (`oneTimeExpensesByDay`) y los suma en **el mismo recorrido día-por-día que ya hacía** sobre la
ventana actual y la previa. El KPI pasó de `GASTOS FIJOS` a **`GASTOS`** (con gastos de única vez adentro,
"fijos" sería falso) y su `subtitle` separa las dos mitades, porque un pico tiene dos causas muy distintas
—subió una suscripción vs. hubo una compra puntual— y el dueño debe distinguirlas sin abrir el historial.
La ventana previa ahora suma **sus propios** gastos de única vez: antes restaba exactamente los mismos que
la actual porque la constante no tenía cómo variar, y eso volvía el `trend` de GANANCIA NETA una
comparación a medias. **La forma de `DashboardData` no cambia**, así que el panel no se rompe con el
deploy. `src/seed.ts` crea una fila recurrente de `$2,000/mes` equivalente a la constante vieja para que la
GANANCIA NETA no dé un salto ese día; es una fila normal y editable.

**La línea derivada de envío** (`DerivedShippingCost`, Fase N.5) es el segundo costo más grande del
negocio y **no es un gasto capturado**: sale de `Order.shipping` y aparece en `/summary` (mes en curso a
la fecha) y en cada mes de `/history` como un campo `shippingCost` aparte. Tres decisiones que hay que
leer juntas:

1. **Nunca se persiste como `Expense`.** Una fila por pedido serían ~900 al mes a 30 ventas diarias:
   inundaría el `activeCount` y el `byCategory` de `/summary`, el `byExpense` de `/history` y la lista
   editable del panel, para representar algo que ya está en `orders`. Las dos tablas de gastos son de
   decenas de filas justamente porque las captura un humano.
2. **Va FUERA de `total`/`byCategory`/`byExpense`/`monthlyRunRate`.** El dashboard ya la resta en
   GANANCIA BRUTA (el envío es costo de venta, ver **Dashboard** en `CLAUDE.md`), y como `OPERATIVA = BRUTA − GASTOS`,
   sumarla también a los totales de gastos la restaría **dos veces**. Se expone aparte para que el dueño
   la *vea* sin que los dos paneles se contradigan; las banderas `derived: true` e
   `includedInGrossProfit: true` son el contrato legible por máquina de eso.
3. **⚠️ Cajas y empaque sí se capturan como `Expense` de categoría `paqueteria`; las guías NO.** Es el
   único modo de reintroducir el doble conteo, y por eso está advertido en tres lugares: el comentario
   del enum en `models/Expense.ts`, la bandera en la API, y el copy obligatorio del frontend.

`buildSummary`/`buildHistory` **siguen siendo puras**: reciben el envío como **parámetro final con
default `new Map()`** en vez de consultarlo adentro (sus tests unitarios corren sin BD y el default deja
intacto a todo llamador anterior). La consulta vive en los wrappers, `loadShippingByMonth(from,
toExclusive)`, con `paymentStatus: "paid"` —el mismo predicado del dashboard— y bucketing por
`isoMonth` UTC para que los dos paneles nunca partan el mes distinto. **Sin `raw: true`**: el
`parseFloat` de `shipping` vive en el getter del modelo, que `raw` no ejecuta, así que devolvería el
string `"150.00"` y la suma **concatenaría**. `getExpenseSummary` toma **un solo `now`** para los límites
del mes y para `buildSummary`, o una llamada a las 23:59:59.9 podría cruzar la medianoche entre ambos.
Los campos `from`/`to`/`partial` de la línea existen para que un acumulado a media quincena no se lea
contra un `monthlyRunRate` de mes completo y parezca que el envío sale baratísimo.
