# Empaque multi-caja (Fase N.6)

`src/services/packing.ts` (`packOrder`/`buildParcels`/`DEFAULT_CARTONS`), `cart.computeShipping`,
`Order.packageCount`.

Hasta esta fase el envío se calculaba asumiendo **un solo bulto**, por dos caminos y los dos mal.
`buildParcel` armaba **una caja apilada** (peso y alto sumados por unidad, largo/ancho al máximo): el
volumen salía bien, pero producía bultos que la tienda nunca arma —3 botas + 1 sombrero daban 45×45×**80
cm**— y como la paquetería cobra **por bulto**, la factura real llegaba más cara que lo cotizado. Peor:
`computeShipping` era un `Math.max` por tipo que **ignoraba la cantidad**, así que 3 botas + 1 sombrero
cobraba $160, lo mismo que una sola bota, y 50 piezas de ropa cobraban $100. Ese camino no es raro —se usa
cada vez que Skydropx está caído, no devuelve tarifas a tiempo, o un producto trae una dimensión en 0— así
que cada caja extra salía de la utilidad del dueño. Y la guía declaraba `packages: [1]` fijo.

**`DEFAULT_CARTONS` es el catálogo de cajas de la tienda** (chica 40×35×25/8 kg, mediana 55×40×35/15 kg,
grande 60×45×50/25 kg, con su tara) y es **el único lugar que editar** cuando el dueño mida las suyas: la
cotización, la guía y la tarifa plana se mueven todas con él. El acomodo es un *first-fit-decreasing* por
volumen contra la caja grande **más una pasada de downgrade** que reasigna cada caja cerrada al cartón más
chico que la aguante — sin esa segunda pasada, un pedido de una bota se cotizaría con la caja maestra y se
sobrecobraría el envío de **casi todas las ventas**. No es empaquetado 3D exacto (NP-difícil, y aquí no
paga): aproxima por volumen con `FILL_FACTOR` (0.8 — el 20% restante son huecos de aire, relleno y cajas
que no teselan), exige que cada pieza quepa **dimensionalmente** (con las medidas ordenadas, o sea
girándola) y respeta el tope de peso. Puede abrir una caja de más; nunca mete más de lo que cabe.
`FILL_FACTOR` es literalmente la constante que decide entre subcotizar y sobrecotizar.

Los casos borde están todos sesgados a **no subcotizar**: una pieza más grande que cualquier cartón viaja
sola con sus propias medidas (`carton: null`) en vez de tumbar la cotización, y una pieza con alguna
dimensión ≤ 0 (fila anterior a que `productSchema` exigiera `.positive()`) **no comparte caja con nada** —
no se puede afirmar que quepa, así que se cobra un bulto completo.

**`computeShipping` y la cotización en vivo salen del MISMO `packOrder`**, y eso es el punto: caer al
respaldo cambia el precio del bulto, nunca cuántos bultos son. El respaldo suma, por caja, la tarifa del
tipo más caro que esa caja lleva (los montos `SHIPPING_BY_TYPE` no cambiaron). Por eso `CartLineItem` ganó
las cuatro dimensiones — los tres llamadores (`createOrder`, `shipping.controller`, `previewCoupon`) ya
tenían el `Product` cargado, así que no hay consulta nueva.

**`isUsableRate` descarta los rates `multishipment`.** Skydropx ofrece tres formas de convertir una
cotización en envío (`shipment_creation_type`): `single`, `multipackage` (una guía con varios bultos) y
`multishipment` (**una guía por bulto**). Este modelo guarda un solo
`skydropxShipmentId`/`trackingNumber`/`labelUrl` por pedido y el webhook localiza la orden por
`relationships.shipment.data.id`, así que con un `multishipment` solo una de las N guías quedaría visible y
las demás serían dinero cobrado que nadie puede rastrear ni entregar. Un rate **sin** el campo sigue siendo
utilizable (el sandbox no siempre lo manda; leer la ausencia como `multishipment` apagaría la cotización en
vivo entera).

**`Order.packageCount`** (nullable, migración `20260804120000-orders-package-count.ts`) congela cuántos
bultos ampara la tarifa cobrada, y `createShipment` declara ese número de `packages` numerados. Tiene que
ser una columna y no un recálculo: la guía se genera minutos después y en otro proceso, donde las
dimensiones del catálogo pudieron cambiar y `GET /quotations/{id}` **no devuelve los `parcels` cotizados**.
`null` = tarifa plana o pedido previo a la fase, y el generador lo lee como 1 — que es exactamente lo que
esos pedidos declararon. La rama de re-cotización de `createShipmentForOrder` rehace el acomodo con las
dimensiones actuales y **persiste el conteo nuevo** (`order.shipping`/`order.total` siguen sin tocarse: ya
se cobraron). El `packageCount` que viaja en `NormalizedShippingRate` sale de `parcels.length`, no de la
respuesta de Skydropx, y `getQuotationRate` lo recupera del mismo `Map` en memoria donde ya recordaba la
dirección cotizada (mismo TTL de 24 h; si el proceso se reinició esa función ya falla cerrado, así que
siempre que hay rate hay conteo).

`src/services/productAvailability.ts`'s `assertProductAvailable(product)` es la guardia compartida de
"producto disponible" (existe, `visible`, no soft-deleted) entre `createOrder`, `getShippingRates` y
`/api/coupons/validate` — todos deben mostrar el mismo mensaje accionable.

`productSchema`/`productUpdateSchema` exigen las cuatro dimensiones **> 0** (`.positive()`) desde Fase 8.2:
con cotización en vivo, un producto en `0` no solo generaría una guía mala, tumbaría la cotización del
carrito completo. `ProductForm.tsx` valida lo mismo para que un producto legado en `0` se marque como
inválido en el formulario en vez de fallar con un 400 desde un campo no relacionado.
