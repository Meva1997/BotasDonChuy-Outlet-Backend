# ROADMAP — Integración Skydropx (guías de envío)

Hoja de ruta de implementación para conectar Skydropx Pro a la tienda: cotización en vivo en el checkout y generación automática de guías al confirmarse el pago. Este documento es la **expansión** de la casilla sin marcar `Skydropx POST /api/shipping/rates` en [ROADMAP.md](ROADMAP.md) §Fase 8 — al terminar esta integración, marca esa casilla ahí.

> **Cómo usarlo:** igual que `ROADMAP.md` — marca `[x]` cada tarea al completarla, en orden de fases (8.1 → 8.7). Cada fase incluye un bloque "Cómo verificar".

> **Estado:** Fases 8.1–8.5 implementadas y probadas contra sandbox real; 8.6–8.7 pendientes.

---

## 0. Estado actual

| Pieza | Estado | Dónde |
|---|---|---|
| Envío cobrado con tarifa plana por tipo (`bota`/`sombrero`/`ropa`) | ✅ Hecho, seguirá como fallback | [src/services/cart.ts](src/services/cart.ts) |
| `Product.weightKg`/`lengthCm`/`widthCm`/`heightCm` | ✅ Existen (default `0` a nivel de columna solo como fallback de DB); `productSchema`/`productUpdateSchema` ya exigen `.positive()` en la API (Fase 8.2) | [src/models/Product.ts](src/models/Product.ts) |
| `Order.shippingCarrier` (string libre) | ✅ Existe | [src/models/Order.ts](src/models/Order.ts) |
| `orderConfirmationTemplate({ tracking?: {...} })` | ✅ El bloque de rastreo ya está implementado, solo falta poblarlo | [src/services/email/templates/orderConfirmation.ts](src/services/email/templates/orderConfirmation.ts) |
| `markOrderPaidFromWebhook` (guard atómico `WHERE paymentStatus != 'paid'`) | ✅ Es el punto de enganche natural para crear la guía | [src/services/payment.service.ts](src/services/payment.service.ts) |
| Mount `/api/webhooks` con `express.raw` | ✅ Ya sirve cuerpo crudo — reutilizable para el webhook de Skydropx | [src/app.ts](src/app.ts), [src/routes/webhook.routes.ts](src/routes/webhook.routes.ts) |
| `src/config/skydropx.ts` | ✅ Hecho — todos los `SHIP_FROM_*` son hard-require desde Fase 8.5 | [src/config/skydropx.ts](src/config/skydropx.ts) |
| `POST /api/shipping/rates` | ✅ Hecho (Fase 8.3) | [src/routes/shipping.routes.ts](src/routes/shipping.routes.ts) |
| Columnas de guía/rastreo en `Order` | ✅ Hechas (Fase 8.5): `skydropxShipmentId`/`trackingNumber`/`trackingUrl`/`labelUrl`/`shipmentStatus` | [src/models/Order.ts](src/models/Order.ts) |
| `createShipmentForOrder` (guía automática al pagar) | ✅ Hecho (Fase 8.5), solo persiste `skydropxShipmentId` — tracking/label llegan por el webhook (Fase 8.6, pendiente) | [src/services/payment.service.ts](src/services/payment.service.ts) |
| `SKYDROPX_CLIENT_ID`/`SKYDROPX_CLIENT_SECRET`/`SHIP_FROM_*` en `.env` | ✅ Existen (sandbox por defecto, `_PROD` guardadas para el lanzamiento — ver §1) | — |

---

## 1. ⚠️ Correcciones al spec previo

`frontend/BACKEND.md` §5.4 y el `.env` actual (`SKYDROPX_API_KEY`, `SKYDROPX_BASE_URL`) fueron escritos asumiendo una **llave estática** vía `Authorization: Bearer $SKYDROPX_API_KEY`. Verificado contra la documentación oficial de Skydropx Pro (Context7, `/websites/pro_skydropx_es-mx_api-docs`): **eso está obsoleto.**

| | Spec previo (`frontend/BACKEND.md` §5.4 / `.env`) | API real de Skydropx Pro |
|---|---|---|
| Auth | Llave estática `SKYDROPX_API_KEY` en cada request | **OAuth2 `client_credentials`**: `client_id` + `client_secret` → `POST /api/v1/oauth/token` → `access_token` Bearer |
| Vigencia del token | N/A (llave fija) | **Expira en 2 horas** (`expires_in: 7200`) — hay que cachear y renovar |
| Límite de tasa | No documentado | **2 requests/segundo** |
| Host | `SKYDROPX_BASE_URL` genérico | ✅ **Confirmado contra la cuenta real** (ver Fase 8.1): tanto `pro.skydropx.com` como `api-pro.skydropx.com` aceptan las credenciales de la cuenta de producción y devuelven token. `sb-pro.skydropx.com` (sandbox) **rechaza** esas credenciales de producción (`invalid_client`), pero desde 2026-07-17 existe una **cuenta sandbox separada** (credenciales propias, $1000 MXN de saldo de prueba) que sí autentica contra `sb-pro.skydropx.com` — ver nota abajo |

**Implicación:** no se puede usar `SKYDROPX_API_KEY` como header fijo. El cliente HTTP necesita un paso previo de autenticación con caché de token en memoria (ver Fase 8.1).

> **✅ Actualización 2026-07-17 — ya hay sandbox.** La cuenta de producción sigue sin entorno de pruebas propio (`sb-pro.skydropx.com` rechaza sus credenciales con `invalid_client`), pero se abrió una **cuenta sandbox independiente** en `sb-pro.skydropx.com` con $1000 MXN de saldo de prueba. `.env` usa esas credenciales sandbox por defecto para desarrollo (las de producción quedan comentadas en `.env`, listas para el lanzamiento). Con esto, las Fases 8.2–8.6 **sí pueden probarse libremente**, incluyendo `POST /shipments` reales contra sandbox, sin gastar saldo de producción. Antes de lanzar a producción: cambiar las tres `SKYDROPX_*` en `.env` por las variantes `_PROD` guardadas ahí mismo.

`frontend/BACKEND.md` §5.4 debe actualizarse (o marcarse como obsoleto) cuando esta integración se implemente, para que no siga describiendo el flujo de llave estática.

---

## 2. Decisiones de diseño

| Tema | Decisión | Por qué |
|---|---|---|
| Alcance | **Cotización en vivo + guías.** `POST /api/shipping/rates` reemplaza la tarifa plana en el checkout; la guía se genera después, al confirmarse el pago | El comprador ve el costo real de envío antes de pagar, no una tarifa fija que puede no cubrir el costo real |
| Disparo de la guía | **Automático al pagar**, dentro de `markOrderPaidFromWebhook` | Cero fricción operativa: no depende de que alguien entre al panel a generarla |
| Empaque | **Una caja apilada por pedido**: `peso = Σ(weightKg × qty)`, `largo/ancho = max(...)`, `alto = Σ(heightCm × qty)` → 1 sola cotización, 1 sola guía, 1 solo tracking | Coincide con cómo se envía hoy (un solo paquete por pedido); nunca subcotiza porque el alto siempre se apila, aunque puede sobrestimar si las cajas anidarían mejor en la realidad (ver §8) |
| Dimensiones en `0` | **Obligatorias desde ya**: `productSchema`/`productUpdateSchema` exigen `weightKg`/`lengthCm`/`widthCm`/`heightCm` > 0; backfill de productos existentes antes de activar la cotización en vivo | Con cotización en vivo, un producto en `0` no solo generaría una guía mala — tumbaría el checkout completo al fallar la cotización |

---

## 3. Arquitectura del flujo

```
CHECKOUT (front)
  1. cliente llena dirección
  2. POST /api/shipping/rates  { customer, items }
       └─ buildParcel(items) → UNA caja apilada
       └─ Skydropx POST /quotations → poll GET /quotations/{id} hasta is_completed
       └─ normaliza → { quotationId, rates: [{ rateId, carrier, service, amount, total, days }] }
  3. cliente elige paquetería
  4. POST /api/orders  { items, customer, quotationId, rateId }
       └─ el server RE-CONSULTA la cotización y toma el `total` de ese rateId
          (jamás confía en un monto del cliente — misma regla que hoy con computeTotals)
       └─ persiste skydropxQuotationId / skydropxRateId / shippingCarrier
  5. Stripe PaymentIntent (sin cambios)

PAGO CONFIRMADO (webhook Stripe → markOrderPaidFromWebhook)
    └─ UPDATE atómico → paid   (guard ya existente: WHERE paymentStatus != 'paid')
    └─ void sendOrderConfirmationEmail(order)   ← sin tracking, como hoy
    └─ void createShipmentForOrder(order)       ← NUEVO
         └─ UPDATE ... WHERE skydropxShipmentId IS NULL  (guard anti-doble-guía)
         └─ Skydropx POST /shipments → tracking_number + label_url
         └─ email "tu pedido fue enviado" (reusa orderConfirmationTemplate con `tracking`)

ACTUALIZACIONES DE ESTADO (webhook Skydropx)
  POST /api/webhooks/skydropx  → verifica HMAC-SHA512 → Order.status = shipped | delivered
```

---

## 4. Fases de implementación

### Fase 8.1 — Cimientos

**Objetivo:** poder autenticarse contra Skydropx y tener un cliente HTTP reutilizable.

**Tareas:**
- [x] Confirmar el host real de la API contra la cuenta de Skydropx (ver §1) — `pro.skydropx.com` (producción) y `sb-pro.skydropx.com` (sandbox, cuenta separada desde 2026-07-17) funcionan. `.env` usa las credenciales **sandbox** por defecto para desarrollo; las de producción quedan guardadas como `SKYDROPX_*_PROD` — ver §1.
- [x] `src/config/skydropx.ts`, mismo patrón que [src/config/stripe.ts](src/config/stripe.ts): `dotenv.config()` propio al inicio del módulo (los imports se evalúan antes del `dotenv.config()` de `app.ts`), **hard-require** de `SKYDROPX_CLIENT_ID` y `SKYDROPX_CLIENT_SECRET` (throw al arrancar si faltan), exporta las constantes ya resueltas.
- [x] Cliente HTTP en `src/services/skydropx.service.ts` (o un helper interno) que:
  - Obtiene el token vía `POST /api/v1/oauth/token` (`grant_type=client_credentials`).
  - **Cachea el token en memoria** y lo renueva ~5 minutos antes de que expire (`expires_in: 7200` → 2h).
  - Respeta el límite de **2 requests/segundo** (throttle simple).
- [x] Registrar el side-effect import de `skydropx.ts` en `app.ts` para fail-fast al arrancar, igual que `stripe.ts`/`resend.ts`/`cloudinary.ts`.

**Cómo verificar:** arrancar el server sin `SKYDROPX_CLIENT_ID`/`SECRET` → falla al inicio con mensaje claro. Con credenciales válidas, una llamada de prueba a `GET /api/v1/finance/credits` responde `200` con el saldo de la cuenta.

---

### Fase 8.2 — Dimensiones obligatorias

**Objetivo:** que ningún producto llegue a cotización con `weightKg`/`lengthCm`/`widthCm`/`heightCm` en `0`. **Bloquea la Fase 8.3** — sin esto, la cotización en vivo puede fallar en cualquier checkout.

**Tareas:**
- [x] `productSchema` y `productUpdateSchema` ([src/schemas/product.ts](src/schemas/product.ts) o donde vivan): cambiar `weightKg`/`lengthCm`/`widthCm`/`heightCm` a `.positive()` con mensaje explícito en español (recordar zod 4: el mensaje de tipo va como **primer** argumento — `z.number("El peso (kg) es requerido").positive("El peso debe ser mayor a 0")` — y que ese mensaje llega tal cual al usuario vía `errorHandler`, como documenta `CLAUDE.md`).
- [x] Backfill de los productos existentes en la base de datos con dimensiones reales (medir físicamente cada producto del catálogo). — no hizo falta: la BD de dev ya tenía las 6 filas con dimensiones reales > 0 (coinciden con `seed.ts`), verificado con `SELECT count(*) FROM products WHERE "weightKg" <= 0 OR ... ` → `0`.
- [x] Actualizar `src/seed.ts` para que los productos semilla también tengan dimensiones > 0. — ya lo estaban (sin cambios necesarios).

**Cómo verificar:** `POST /api/admin/products` con `weightKg: 0` → `400` con mensaje accionable. `SELECT * FROM products WHERE weight_kg <= 0 OR length_cm <= 0 OR width_cm <= 0 OR height_cm <= 0;` → 0 filas.

---

### Fase 8.3 — Empaque + cotización

**Objetivo:** `POST /api/shipping/rates` funcionando, con fallback si Skydropx no responde.

**⚠️ Corrección de spec confirmada contra sandbox real (2026-07-17):** la documentación de
Context7 (`/websites/pro_skydropx_es-mx_api-docs`) mezcla ejemplos inconsistentes para
`POST /api/v1/quotations` (uno con `from`/`to`/`parcel` planos y `street`/`zip_code`, otro con
`quotation: { address_from, address_to, parcels }` y `area_level1/2/3`). Se probó ambos contra
la cuenta sandbox real y **el segundo es el correcto**:
```json
POST /api/v1/quotations
{
  "quotation": {
    "address_from": { "country_code": "MX", "postal_code": "38000", "area_level1": "Guanajuato", "area_level2": "Celaya", "area_level3": "Centro" },
    "address_to":   { "country_code": "MX", "postal_code": "06000", "area_level1": "Ciudad de México", "area_level2": "Cuauhtémoc", "area_level3": "Centro" },
    "parcels": [ { "length": 30, "width": 20, "height": 15, "weight": 2 } ]
  }
}
```
`name`/`phone`/`street`/`external_number` **no son necesarios para cotizar** (solo para crear la
guía en Fase 8.5). La respuesta (`GET /api/v1/quotations/{id}` tiene el mismo shape) es:
```json
{
  "id": "...", "is_completed": false,
  "rates": [
    { "id": "...", "success": true, "status": "price_found_internal", "provider_name": "dhl",
      "provider_display_name": "DHL", "provider_service_name": "Standard", "currency_code": "MXN",
      "amount": "94", "total": "174.70", "service_fee": "2.58", "days": 3 }
  ]
}
```
`amount`/`total` llegan como **strings** (`parseFloat` requerido). `status` puede quedar en
`pending` indefinidamente para 1-2 tarifas de las ~35 cotizadas por timeouts internos de Skydropx
ajenos a nosotros — **`is_completed` puede nunca llegar a `true`**, así que el poll no debe
esperarlo: agota un presupuesto de tiempo (8s) y devuelve lo que ya se resolvió
(`success: true` + `amount`/`total` no nulos), descartando `pending`/`no_coverage`/`not_applicable`.
Verificado con una cotización real Celaya→CDMX: rates reales de DHL/Paquetexpress/Estafeta/
tresguerras con montos en pesos.

**Tareas:**
- [x] `src/services/packing.ts`: función `buildParcel(items)` que arma la caja apilada (ver §2): `weight = Σ(product.weightKg × qty)`, `length/width = max(...)`, `height = Σ(product.heightCm × qty)`. `length`/`width`/`height` se redondean hacia arriba (`Math.ceil`) porque Skydropx los exige enteros.
- [x] `src/services/skydropx.service.ts`: `createQuotation(addressFrom, addressTo, parcel)` → `POST /api/v1/quotations` (shape confirmado arriba), luego `pollQuotation(quotationId)` con `GET /api/v1/quotations/{id}` hasta que no queden tarifas `pending` o se agote un timeout de 8s (no espera `is_completed: true`, ver nota arriba). `getShippingRates(...)` normaliza a `{ quotationId, rates: [{ rateId, carrier, service, amount, total, days }] }`, filtrando solo `success: true`.
- [x] `src/schemas/shipping.ts`: `shippingRatesSchema` (reutiliza `shippingSchema` y `orderItemSchema` de `checkout.ts`).
- [x] `src/routes/shipping.routes.ts` + `src/controllers/shipping.controller.ts`: `POST /api/shipping/rates` **público**, monta `address_from` desde `SHIP_FROM_*` (env, agregadas a `config/skydropx.ts` como hard-require) y `address_to` desde el body del cliente; agrega cantidades por producto (mismo criterio que `orders.service`) y valida que cada producto exista/esté visible (`409` si no, mismo mensaje que `createOrder`).
- [x] **Fallback:** si la llamada a Skydropx falla/hace timeout **o no devuelve ninguna tarifa utilizable**, responde con la tarifa plana de `computeShipping` (`rateId: null`, `quotationId: null`) — la tienda no debe dejar de vender porque la paquetería esté caída.
- [x] Montar el router nuevo en `app.ts` (`/api/shipping`).

**Cómo verificar:** ✅ Probado end-to-end contra sandbox real: `POST /api/shipping/rates` con un
producto real (Bota Bordada Tejana, Celaya→CDMX) → `200` con tarifas reales de varias
paqueterías. Carrito con 2 productos distintos (bota + sombrero) → `200` con parcel agregado
correctamente. `productId` inexistente → `409` con mensaje accionable. Body inválido (customer
vacío) → `400` con mensajes zod compuestos. Pendiente probar el camino de fallback real (requiere
simular una falla de Skydropx, p. ej. credenciales inválidas temporalmente).

---

### Fase 8.4 — Órdenes con tarifa real

**Objetivo:** que `POST /api/orders` cobre el monto real cotizado, no solo la tarifa plana.

**Tareas:**
- [x] `createOrderSchema` ([src/schemas/checkout.ts](src/schemas/checkout.ts)): agregar `quotationId`/`rateId` opcionales (opcionales porque el fallback de 8.3 puede no tener cotización real). Un `.refine()` exige que vayan **juntos o ninguno** (un `quotationId` suelto no identifica un rate re-consultable).
- [x] `orders.service.createOrder`: si vienen `quotationId`/`rateId`, **re-consultar la cotización en Skydropx** (`getQuotationRate` en `skydropx.service.ts`, un solo `GET`) y tomar el `total` de ese `rateId` como `shipping` — nunca confiar en un monto que mande el cliente (misma regla que ya aplica `computeTotals` a `subtotal`/`savings`). Si no vienen (fallback), usar `computeShipping` como hoy. **Nota de implementación:** la re-consulta se hace **antes** de abrir la transacción (no dentro, como decía el borrador de este roadmap): es un `GET` de red que no toca la BD, y meterlo dentro mantendría abiertos los locks de `ProductSize` durante la llamada. Un rate ya no disponible → `409` accionable; un fallo de red al re-consultar → `503`.
- [x] Persistir `skydropxQuotationId`/`skydropxRateId` en la orden (columnas nuevas, ver §5) y `shippingCarrier` desde el `carrier` del rate elegido.
- [x] Nota para cuando se implemente: `frontend/lib/cart.ts` deja de ser la fuente de verdad del costo de envío mostrado — el checkout del front debe llamar a `/api/shipping/rates` en vez de calcular localmente, o el monto mostrado en el formulario y el cobrado en la confirmación divergirán (mismo riesgo que ya advierte el comentario en `src/services/cart.ts` sobre la duplicación con el front). *(Backend listo; el cambio en el front queda pendiente.)*

**Cómo verificar:** `POST /api/orders` con un `rateId` de una cotización real → el `shipping`/`total` de la orden creada coincide con el `total` de ese rate, no con `computeShipping`.

---

### Fase 8.5 — Guía automática al pagar

**Objetivo:** que la guía se genere sola en cuanto el pago se confirma, sin intervención manual.

**⚠️ Dos correcciones de spec confirmadas contra sandbox real (2026-07-20, mismo método que la
Fase 8.3 usó para `quotations`):**

1. **Shape de `POST /api/v1/shipments`.** Context7 mezcla cuatro shapes inconsistentes para este
   endpoint (uno plano `{ quotation_id, rate_id, carrier_name, ... }`, uno v1 envuelto en
   `shipment`, uno v2 envuelto en `shipment` con `parcels`, y uno estilo JSON:API con
   `data.attributes`). El correcto, verificado con una guía real creada en sandbox, es:
   ```json
   POST /api/v1/shipments
   {
     "shipment": {
       "rate_id": "<id de un rate ya cotizado>",
       "address_from": { "street1": "...", "name": "...", "company": "...", "phone": "...", "email": "...", "reference": "..." },
       "address_to":   { "street1": "...", "name": "...", "company": "...", "phone": "...", "email": "...", "reference": "..." },
       "packages": [ { "package_number": "1", "package_type": "4G", "consignment_note": "53102400" } ]
     }
   }
   ```
   Responde `202` con `{ data: { id, attributes: { carrier_name, workflow_status } } }`. Dos campos
   de `packages[]` que la doc marca como opcionales/de texto libre en realidad son **obligatorios y
   validados contra catálogos**: `consignment_note` no es un "Waybill ID" arbitrario sino una clave
   del catálogo SAT `c_ClaveProdServ` (México exige Carta Porte para transporte terrestre de
   mercancías desde 2022) — un valor inventado da `422 "no está incluido en la lista"`; se usa
   `53102400` ("Calzado", acorde al giro de la tienda). `package_type` también es obligatorio; se
   usa `"4G"`, el valor de ejemplo de la doc oficial (confirmado válido).
2. **La creación de la guía es asíncrona.** La respuesta del `POST` (y de `GET /shipments/{id}`
   pollado 6 veces a lo largo de ~12s) llega con `workflow_status: "in_progress"` y
   `tracking_number`/`label_url` en `null` — la paquetería procesa la guía en su propio tiempo, que
   puede ser de minutos a horas. Esto **mueve el alcance**: `createShipmentForOrder` (Fase 8.5) solo
   puede persistir el `skydropxShipmentId` (disponible de inmediato); poblar
   `trackingNumber`/`trackingUrl`/`labelUrl` y enviar el correo "tu pedido fue enviado" con
   `tracking` **se recorren a la Fase 8.6**, que es precisamente el webhook diseñado para recibir
   ese dato cuando esté listo — no tiene sentido hacer polling bloqueante aquí.

**Tareas:**
- [x] `createShipmentForOrder(order)` en `src/services/payment.service.ts`: llama
      `POST /api/v1/shipments` con la dirección del cliente (`order.street`/`customerName`/
      `customerPhone`/`customerEmail`/`neighborhood`) y la dirección de origen (`SHIP_FROM_*`,
      ahora **hard-require** en `config/skydropx.ts` — antes reservadas/opcionales) y el `rate_id`
      guardado en la orden; guarda `skydropxShipmentId`. Tolerante a que la orden no tenga
      cotización de Skydropx (fallback de tarifa plana): en ese caso no hay `rate_id` que convertir
      en guía, se omite con un log y el dueño la genera manualmente.
- [x] Enganchada dentro de `markOrderPaidFromWebhook`, justo después del guard `affected === 1`
      que ya dispara `sendOrderConfirmationEmail` — es el único punto por el que una orden pasa a
      `paid`.
- [x] **Guard de idempotencia propio.** Como el `id` real de la guía solo se conoce DESPUÉS del
      `POST` (que ya cuesta dinero real — no se puede usar como guard de antemano como el patrón
      literal del email), se reclama el derecho a crearla con un valor centinela
      (`Order.update({ skydropxShipmentId: "creating" }, { where: { id, skydropxShipmentId: null } })`)
      ANTES de llamar a Skydropx; si el `UPDATE` no afecta ninguna fila, otra llamada ya está
      creando (o ya creó) la guía y esta se retira sin llamar a Skydropx. Si la creación falla, el
      centinela se libera (`skydropxShipmentId` vuelve a `null`) para permitir un reintento
      posterior. Verificado: una segunda llamada sobre una orden que ya tiene `skydropxShipmentId`
      no dispara ninguna llamada HTTP a Skydropx.
- [x] Disparo **fire-and-forget** (`void createShipmentForOrder(order)`, sin `await`) — igual que
      el email: si Skydropx responde lento, no debe bloquear el `200` del webhook de Stripe.
- [x] Si el `rate_id`/`quotationId` guardado ya no está disponible (cotización vencida —vigentes
      24h— o la memoria en proceso de `getQuotationRate` se perdió en un reinicio), se re-cotiza
      desde cero (reconstruyendo el parcel con `Product.weightKg/lengthCm/widthCm/heightCm`
      actuales de los `OrderItem` de la orden) y se persiste el `quotationId`/`rateId` frescos —
      **sin tocar** `order.shipping`/`order.total` (ya cobrados). Verificado end-to-end contra una
      orden real con cotización vencida: re-cotizó y generó la guía correctamente.
- [ ] Email "tu pedido fue enviado" con `tracking` poblado — **movido a la Fase 8.6** (ver
      corrección de spec arriba): no hay `tracking_number` que enviar hasta que el webhook lo
      reporte.

**Cómo verificar:** ✅ Probado contra sandbox real con una orden `paid` existente:
`createShipmentForOrder` detectó la cotización vencida, re-cotizó, creó la guía
(`skydropxShipmentId` poblado, `202` de Skydropx) y una segunda llamada sobre la misma orden no
generó una guía duplicada (guard funcionando). Pendiente confirmar el flujo completo disparado por
un webhook real de Stripe en lugar de una llamada directa (mecánicamente idéntico: mismo guard,
mismo `void`).

---

### Fase 8.6 — Webhook de Skydropx

**Objetivo:** que los cambios de estado del paquete (`in_transit`, `delivered`, etc.) actualicen la orden sin polling manual — y, ya que es el primer punto que recibe ese dato, que también pueble `trackingNumber`/`trackingUrl`/`labelUrl` y dispare el correo de envío (ver la corrección de spec de la Fase 8.5: la creación de la guía es asíncrona, así que ese trabajo no podía hacerse ahí).

**Tareas:**
- [ ] `POST /api/webhooks/skydropx` en `src/routes/webhook.routes.ts` (mismo archivo que el de Stripe) — el mount `/api/webhooks` en `app.ts` **ya** usa `express.raw({ type: "application/json" })`, así que el cuerpo crudo que necesita la verificación HMAC ya está disponible sin cambios adicionales al middleware.
- [ ] Verificación de firma: **HMAC-SHA512** sobre el cuerpo crudo con `SKYDROPX_WEBHOOK_SECRET`, comparación con `crypto.timingSafeEqual` (no `===`, para evitar timing attacks) contra el header `Authorization: HMAC <firma>`.
- [ ] Manejar evento tipo `packages`: extraer el `shipment_id`/`tracking_number` para localizar la orden (`Order.findOne({ where: { skydropxShipmentId } })` — más directo que buscar por `trackingNumber`, que nace `null` y solo este webhook lo llena) y mapear `attributes.status` → `Order.status` (`shipped`/`delivered`) + `Order.shipmentStatus`.
- [ ] **Heredado de la Fase 8.5** (ver su corrección de spec — la creación de la guía es asíncrona, `POST /shipments` no devuelve tracking): este webhook es el que primero recibe `tracking_number`/`label_url` (y la URL de rastreo del carrier, si el payload la trae), así que aquí se pueblan `Order.trackingNumber`/`trackingUrl`/`labelUrl` por primera vez.
- [ ] **Heredado de la Fase 8.5**: en cuanto `trackingNumber` pasa de `null` a un valor (primera vez que este webhook lo reporta para la orden — guard idempotente igual que el correo de confirmación, para no reenviar en eventos de actualización posteriores como `delivered`), disparar el correo "tu pedido fue enviado" (`orderConfirmationTemplate` con `tracking: { number, url, carrier }`, fire-and-forget igual que `sendOrderConfirmationEmail`).
- [ ] Firma inválida o ausente → `400`. Evento verificado (aunque el tipo no se maneje) → siempre `200 { received: true }`, mismo patrón que el webhook de Stripe, para que Skydropx no reintente en bucle.

**Cómo verificar:** enviar un payload de prueba con firma HMAC válida (generado con el mismo algoritmo) → `200` y la orden correspondiente cambia de estado. Con firma inválida → `400`, la orden no cambia.

---

### Fase 8.7 — Swagger

**Objetivo:** documentar los endpoints nuevos antes de comitear, por el Workflow de [CLAUDE.md](CLAUDE.md) ("Whenever a commit/push adds or changes routes... la documentación Swagger MUST be written/updated first").

**Tareas:**
- [ ] `components.schemas` nuevos en `src/config/swagger.ts`: `ShippingRatesInput`, `ShippingRate`, `ShippingRatesResponse`.
- [ ] Tag nuevo `Shipping` (o reutilizar `Orders` si se prefiere agrupar).
- [ ] Bloques `@openapi` JSDoc sobre `POST /api/shipping/rates` y `POST /api/webhooks/skydropx`.
- [ ] Actualizar los schemas existentes `CreateOrderInput` (agregar `quotationId`/`rateId`) y `Order` (agregar las columnas nuevas de §5).

**Cómo verificar:** `GET /api/docs.json` incluye los schemas y paths nuevos; `/api/docs` los renderiza correctamente en la UI.

---

## 5. Modelo de datos

Columnas nuevas en `Order` (todas nullable — `sequelize.sync({ alter: true })` en dev las crea sin migración manual):

| Columna | Tipo | Propósito |
|---|---|---|
| `skydropxQuotationId` | STRING, nullable | Cotización usada para re-consultar el `total` autoritativo en `createOrder` |
| `skydropxRateId` | STRING, nullable | Rate elegido por el cliente |
| `skydropxShipmentId` | STRING, nullable | Envío creado en Skydropx — su presencia (más allá del centinela `"creating"` transitorio) es el guard anti-doble-guía |
| `trackingNumber` | STRING, nullable | Número de rastreo — `null` hasta el webhook de Skydropx (Fase 8.6): la creación del envío es asíncrona y no lo devuelve |
| `trackingUrl` | STRING, nullable | URL de rastreo del carrier — igual que arriba, poblada por el webhook |
| `labelUrl` | STRING, nullable | PDF de la guía — igual que arriba, poblada por el webhook |
| `shipmentStatus` | STRING, nullable | Último estado reportado por el webhook de Skydropx (`in_transit`, `delivered`, etc.) |

**Ya implementadas (Fase 8.5)**, todas nullable, creadas por `sequelize.sync({ alter: true })` sin migración manual.

`shippingCarrier` (ya existente, string libre) se sigue llenando, ahora desde el `carrier` del rate elegido en vez de quedar vacío.

---

## 6. Contratos de endpoints

```
POST /api/shipping/rates  [público]
Request:  { customer: ShippingData, items: [{ productId, size, quantity }] }
Response: 200 { quotationId: string | null, rates: [{ rateId, carrier, service, amount, total, days }] }
          (quotationId: null cuando se usó el fallback de tarifa plana)

POST /api/orders  [público] — extiende el contrato actual
Request:  { items, customer, shippingCarrier?, quotationId?, rateId? }
Response: 201 { order, clientSecret }
          (shipping/total de `order` viene del rate re-consultado si quotationId/rateId vienen, si no de computeShipping)

POST /api/webhooks/skydropx  [firma HMAC]
Request:  evento Skydropx (raw body) + header Authorization: HMAC <firma>
Response: 200 { received: true } | 400 (firma inválida)
```

---

## 7. Variables de entorno

- `SKYDROPX_CLIENT_ID` — ✅ ya en `.env` (requerida, hard-fail al arrancar si falta; **credencial sandbox** por defecto, ver §1).
- `SKYDROPX_CLIENT_SECRET` — ✅ ya en `.env` (requerida, hard-fail al arrancar si falta; **credencial sandbox** por defecto, ver §1).
- `SKYDROPX_BASE_URL` — ✅ ya en `.env` (`https://sb-pro.skydropx.com` por defecto; `https://pro.skydropx.com` guardado como `SKYDROPX_BASE_URL_PROD` para el lanzamiento).
- `SKYDROPX_WEBHOOK_SECRET` — ❌ falta, agregar para verificar HMAC en Fase 8.6.
- `SHIP_FROM_POSTAL_CODE`, `SHIP_FROM_STATE`, `SHIP_FROM_CITY`, `SHIP_FROM_NEIGHBORHOOD` — ✅ ya en `.env` (requeridas desde Fase 8.3, `address_from` de cada cotización).
- `SHIP_FROM_STREET`, `SHIP_FROM_EXTERNAL_NUMBER`, `SHIP_FROM_NAME`, `SHIP_FROM_PHONE` — ✅ ya en `.env` (requeridas desde Fase 8.5 — antes reservadas/opcionales, ahora hard-require: `createShipmentForOrder` las usa para el `address_from` de `POST /shipments`).

**Ya retirada:** `SKYDROPX_API_KEY` — obsoleta (llave estática), reemplazada por `SKYDROPX_CLIENT_ID`/`SKYDROPX_CLIENT_SECRET` (ver §1).

---

## 8. Riesgos y decisiones abiertas

- ~~**Doble guía = dinero real.**~~ **Resuelto (Fase 8.5):** cada `POST /api/v1/shipments` consume saldo de la cuenta, así que `createShipmentForOrder` reclama el derecho a crear la guía con un valor centinela (`skydropxShipmentId: "creating"`) vía `UPDATE ... WHERE skydropxShipmentId IS NULL` **antes** de llamar a Skydropx — mismo razonamiento que el guard `WHERE paymentStatus != 'paid'` del email de confirmación (documentado en `CLAUDE.md`): un guard en memoria no serializa dos llamadas concurrentes. Verificado: una segunda llamada sobre una orden que ya tiene guía no dispara ninguna llamada HTTP a Skydropx. **Endurecido (revisión post-8.5):** el `catch` distingue si `createShipment` ya llegó a responder antes de fallar — si el `POST /shipments` tuvo éxito pero el `UPDATE` que persiste el `shipmentId` real falla después, el centinela **no** se libera (se registra como `CRÍTICO` para reconciliación manual) en vez de resetear a `null`, que habría dejado la orden lista para que un reintento futuro pagara una segunda guía. También se cerró el hueco de que el `UPDATE` de reclamo del centinela vivía fuera de cualquier `try/catch`: al dispararse fire-and-forget y no existir un handler global de `unhandledRejection`, un fallo de DB justo ahí podía tumbar el proceso completo.
- **Caja apilada sobrestima.** Un pedido de 5 sombreros da 100cm de alto en una sola caja; algunas paqueterías cobran por peso volumétrico o rechazan medidas fuera de rango. Revisar con pedidos reales tras el lanzamiento y ajustar `buildParcel` si hace falta.
- ~~**Rate expirado.**~~ **Resuelto (Fase 8.5):** las cotizaciones son válidas 24h; `PENDING_ORDER_TTL_MINUTES` es 30 minutos, así que normalmente el rate sigue fresco al pagar, pero la ruta de recuperación del `pendingOrderSweeper` puede marcar una orden `paid` mucho después de creada. `createShipmentForOrder` detecta un rate/quotation ya no disponible (vía `getQuotationRate`) y re-cotiza desde cero antes de crear el envío, sin tocar el monto ya cobrado. Probado end-to-end contra una orden real con cotización vencida.
- **Guía asíncrona sin tracking inmediato.** Confirmado contra sandbox real (2026-07-20, ver la corrección de spec en Fase 8.5): `POST /shipments` responde `202` con `workflow_status: "in_progress"` y `tracking_number`/`label_url` en `null` — no se resolvieron tras 6 pollings a lo largo de ~12s. Por diseño, esos campos (y el correo "pedido enviado") quedan pendientes hasta el webhook de Skydropx (Fase 8.6).
- **Saldo insuficiente en Skydropx.** La guía puede fallar aunque el pedido ya esté pagado. Nunca debe tumbar el webhook de Stripe — `createShipmentForOrder` ya loguea el fallo y libera el centinela (`skydropxShipmentId` vuelve a `null`) para reintento manual o automático posterior (ese reintento en sí no existe todavía). Monitorear saldo vía `GET /api/v1/finance/credits`.
- ~~**No hay sandbox para esta cuenta.**~~ **Resuelto 2026-07-17:** se abrió una cuenta sandbox separada ($1000 MXN de saldo de prueba) que sí acepta `sb-pro.skydropx.com`. `.env` apunta a sandbox por defecto, así que las Fases 8.3–8.6 pueden probarse libremente, igual que Stripe test mode. La cuenta de **producción** sigue sin sandbox propio — antes de lanzar, cambiar `.env` a las credenciales `_PROD` y retomar la cautela original (minimizar `POST /shipments` de prueba, monitorear `GET /api/v1/finance/credits`, cancelar envíos de prueba con `POST /shipments/{id}/cancellations`).
- **`computeShipping` duplicado en el frontend.** Al pasar a tarifas en vivo, el checkout del front debe llamar a `/api/shipping/rates` en vez de calcular localmente con `frontend/lib/cart.ts`, o el monto mostrado en el formulario y el cobrado al confirmar divergirán — el comentario en `src/services/cart.ts` ya advierte sobre esta duplicación.

---

## 9. Checklist maestro

**Fase 8.1 — Cimientos**
- [x] Confirmar host real de la API
- [x] `src/config/skydropx.ts` (hard-require + fail-fast)
- [x] Cliente HTTP con caché de token OAuth2 + throttle 2 req/s

**Fase 8.2 — Dimensiones obligatorias**
- [x] `productSchema`/`productUpdateSchema` exigen dimensiones > 0
- [x] Backfill de productos existentes
- [x] `seed.ts` actualizado

**Fase 8.3 — Empaque + cotización**
- [x] `src/services/packing.ts` (`buildParcel`)
- [x] `src/services/skydropx.service.ts` (`createQuotation` + poll)
- [x] `POST /api/shipping/rates` + fallback a tarifa plana

**Fase 8.4 — Órdenes con tarifa real**
- [x] `createOrderSchema` acepta `quotationId`/`rateId`
- [x] `createOrder` re-consulta el monto autoritativo
- [x] Columnas `skydropxQuotationId`/`skydropxRateId` persistidas

**Fase 8.5 — Guía automática al pagar**
- [x] `createShipmentForOrder` enganchado en `markOrderPaidFromWebhook`
- [x] Guard de idempotencia propio (centinela `skydropxShipmentId` antes del `POST`, ver corrección de spec)
- [x] Disparo fire-and-forget
- [x] Re-cotización automática cuando el rate/quotation guardado ya no está disponible
- [ ] Email "pedido enviado" con `tracking` poblado — movido a la Fase 8.6 (la guía se crea async, sin tracking disponible al pagar)

**Fase 8.6 — Webhook de Skydropx**
- [ ] `POST /api/webhooks/skydropx` con verificación HMAC-SHA512
- [ ] Actualización de `Order.status`/`shipmentStatus` desde eventos `packages`
- [ ] Poblar `trackingNumber`/`trackingUrl`/`labelUrl` (heredado de la Fase 8.5, ver su corrección de spec)
- [ ] Disparar el correo "pedido enviado" con `tracking` poblado (heredado de la Fase 8.5)

**Fase 8.7 — Swagger**
- [ ] Schemas `ShippingRate`/`ShippingRatesInput`/`ShippingRatesResponse`
- [ ] `@openapi` en rutas nuevas
- [ ] `CreateOrderInput`/`Order` actualizados

**Al terminar:** marcar la casilla `Skydropx POST /api/shipping/rates` en [ROADMAP.md](ROADMAP.md) §Fase 8 y §7 (checklist maestro).
