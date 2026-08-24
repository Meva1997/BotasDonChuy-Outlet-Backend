# Importación/restock masivo de productos

`src/services/productImport.service.ts`, `src/schemas/productImport.ts`, `src/utils/excelCell.ts`,
`src/utils/sizesSpec.ts`.

El dueño da de alta mercancía nueva y restockea la existente subiendo una hoja de cálculo. Son **dos
pasos**, y esa separación es la decisión central de la fase:

1. `POST /api/admin/products/import/preview` `[auth]` — recibe el `.xlsx` por multipart/form-data (campo
   `file`, máx. 2 MB, máx. **500 filas**, `uploadProductImportFile`, mismo patrón `memoryStorage()` que las
   imágenes, mimetype fijo de OOXML) y devuelve el plan **sin escribir nada**: por fila, su `action`
   (`create`/`update`/`unchanged`/`error`), el producto con el que empareja (`before`, `null` si se
   creará), cómo quedaría (`after`), los campos que cambian (`changes`) y el stock por talla
   (`sizeChanges`, con `before`/`added`/`after`).
2. `POST /api/admin/products/import` `[auth]` — recibe **JSON** `{ rows }` (los `input` que devolvió el
   preview, con las ediciones que el dueño haya hecho en pantalla) y los aplica.

Es JSON y no el `.xlsx` original a propósito: lo que se escribe es lo que se revisó y corrigió. El paso de
revisión **no es cosmético** — el restock SUMA stock y no hay forma de deshacerlo desde la app, así que
aplicar un archivo a ciegas (con una fórmula que no se leyó, una columna mal escrita o un nombre que
empareja con el producto equivocado) sale caro. Por eso el diseño entero está sesgado a **fallar la fila
antes que aplicarla en silencio**: el modo de fallo caro no es el error visible, es la fila que responde
"actualizado" sin haber actualizado nada.

**Lectura de celdas** (`src/utils/excelCell.ts`): `exceljs` (no `xlsx`/SheetJS — sin historial de CVEs de
prototype pollution) parsea el workbook, pero `ExcelJS.CellValue` **no es solo `string | number`**: una
celda llega como `{ formula, result }`, `{ sharedFormula, result }`, `{ richText }`, `{ text, hyperlink }`
o `{ error }`. Sin desempaquetar cada forma, `String(value)` da `"[object Object]"` — que en una columna
de texto se guardaba tal cual como nombre del producto y en una numérica se volvía `NaN`.
`readCellText`/`readCellNumber`/`readCellBoolean` distinguen **tres** resultados:
- **vacío** → la clave se OMITE de la fila, así que una actualización parcial no toca esa columna (crítico
  porque `code`/`description` aceptan cadena vacía como valor válido en el schema base: una clave presente
  con `""` blanquearía la columna al hacer `existing.update(fields)`);
- **`problem`** → la celda tiene contenido pero es ilegible (fórmula sin `result` calculado, `#REF!`,
  `Visible: "quizá"`) → se acumula en `cellErrors` y **la fila falla**;
- **`warning`** → se leyó con una interpretación a confirmar (coma decimal `"1,5"` → `1.5` en vez de los
  `15` que salían al quitar todas las comas; celda con formato de fecha, que es como Excel autoformatea un
  código tipo `1-2`). El preview los muestra y el dueño decide.

**Encabezados**: canónico en español (`Código | Nombre | Categoría | Descripción | Precio original |
Precio oferta | Costo unitario | Tallas | Peso (kg) | Largo (cm) | Ancho (cm) | Alto (cm) | Visible`),
insensible a acentos/mayúsculas y con alias comunes (`sku`→`code`, `tipo`→`type`, …) vía `HEADER_ALIASES`.
Una columna **no reconocida** no se descarta en silencio: se reporta en el `warnings` a nivel archivo. Dos
columnas que normalizan al **mismo** campo son un **400** — antes ganaba la última no vacía.

**Tallas** (`src/utils/sizesSpec.ts`): además de la notación heredada del `ProductForm` (`"25, 26, 26"`,
una ocurrencia = una unidad) se acepta **`"26x20"`** (20 piezas de la talla 26), mezclables
(`"25x3, 26, 27x2"`). La notación `x` existe porque el caso de uso central es el **restock**: repetir
`"26,"` veinte veces es inviable en una hoja de cálculo. Hay topes (talla 1–999, 9 999 piezas por entrada,
60 tallas distintas, 10 000 piezas por fila) porque el modelo no valida tallas: sin ellos entraba una talla
de 8 dígitos sin chistar.

**Emparejamiento**: si la fila trae `código`, por `code` **insensible a mayúsculas** (columna con **índice
único parcial**); si no, por `nombre` exacto insensible a mayúsculas usando `lower(name) = lower(?)` —
**nunca `iLike`**, que interpreta `%`/`_` como comodines: una fila llamada `"Bota%Premium"` emparejaba con
`"Bota Roja Premium"` y, al aplicarse el campo `name`, la **renombraba**. Un valor que empareja con **más
de un producto** es ambiguo (`name` no tiene índice único) y la fila falla pidiendo un código, en vez del
`findOne` arbitrario de antes. Si el código de la hoja solo difiere en mayúsculas del guardado, empareja
pero **no** reescribe el código (sería renombrar la clave del catálogo por una diferencia de tecleo).

Sin match → crea un producto nuevo (mismos campos requeridos que `POST /api/admin/products`). Con match →
actualiza **solo** los campos presentes en la fila **y que realmente cambian** (una columna ausente nunca
borra un valor guardado); si la fila trae `Tallas`, **suma** esas unidades al stock ya guardado por talla
vía un upsert `INSERT ... ON CONFLICT ("productId","size") DO UPDATE SET stock = product_sizes.stock +
EXCLUDED.stock` — **nunca** el destroy+recreate que usa `adminUpdateProduct` para una edición manual,
porque ahí sí se quiere reemplazar. Una fila que empareja pero no cambia nada es `unchanged`, no
`updated`. Un producto **soft-deleted** que hace match se **reactiva** (`deletedAt: null`, y `visible:
true` salvo que la fila diga lo contrario) — restockear implica que vuelve a venderse.

`validateRow`/`projectSnapshot` son **compartidos** entre preview y confirmación: el diff que se muestra y
lo que se escribe salen del mismo código, así que no pueden divergir.

**El preview resuelve contra un catálogo virtual**: el estado real de la BD más lo que las filas anteriores
del mismo archivo ya proyectaron (`pendingByCode`/`pendingByName`/`projectedById`). Sin ese overlay, un
archivo donde la fila 2 crea `BTA-9` y la fila 5 lo restockea mostraría dos altas del mismo producto,
mientras que al confirmar sí sería un update. El preview hace **2 consultas** para todo el archivo.

En la **confirmación**, cada fila corre **independiente** (éxito parcial) y **secuencialmente**, nunca con
`Promise.all` — a propósito, para que una fila pueda crear un producto que una fila posterior del mismo
lote restockee por ese mismo código. El match se hace **dentro** de la transacción y con `FOR UPDATE` sobre
`products` (con `lock: { level, of: Product }`, porque `FOR UPDATE` con el include `hasMany` de
`productSizes` revienta en Postgres — lado nullable de un LEFT JOIN): cargarlo fuera dejaba una ventana
entre la lectura y el update.

**Doble envío**: `assertNotDuplicateCommit` rechaza con **409** el mismo lote enviado dos veces en menos de
60 s (hash sha256 del payload). Es un `Map` en memoria, deliberadamente **no persistido** — misma decisión
y limitación asumida que el contador de `pendingOrderSweeper.ts`. Protege del accidente (doble clic,
reintento del navegador), no del abuso; la barrera dura contra duplicados sigue siendo el índice único de
`code`. Desde la Fase O.2 el mapa con TTL y la huella salen de `src/utils/idempotency.ts`, compartidos con
el guard del checkout; lo que **no** se comparte es la política — aquí un reenvío se rechaza, en
`POST /api/orders` se le devuelve la respuesta del original.

Errores por fila se traducen a un mensaje en español con prefijo `Fila N:` (zod, `AppError`, o un
`UniqueConstraintError` del índice de `code`). Un `ZodError` compone **hasta 3 mensajes de campo** + "(y N
campos más por corregir)", igual que `messageFromDetails` en `errorHandler.ts`: reportar solo `issues[0]`
obligaba a corregir una columna, volver a subir y descubrir la siguiente — y como el restock suma, cada
reintento del archivo completo volvía a sumar el stock de las filas que sí habían funcionado. Cualquier
error no esperado se loguea con `logger.error` antes de degradarse a fila de error. Un `.xlsx` corrupto (o
un `.csv`/`.xls` renombrado, que pasa el filtro de mimetype) da un **400** accionable en vez del 500
genérico. Respuestas: `{ summary: { total, created, updated, unchanged, failed }, warnings, rows }` en el
preview y `{ summary, rows: [{ row, status, code, name, productId?, message }] }` al confirmar.

El límite de `express.json()` en `src/app.ts` está en **1 mb** (no los 100 kb por defecto) porque la
confirmación manda hasta 500 filas de producto en un solo body.

`products.code` (nullable, sin restricción antes de esta fase — líneas como `ropa` legítimamente no lo
usan) ganó un **índice único parcial** (`WHERE code IS NOT NULL AND code != ''`) vía
`20260727120000-products-code-unique-index.ts`; declarado también en `Product.init()`'s `indexes` (mismo
motivo que el índice de `product_sizes`: `tests/setup/db.ts` construye el esquema con
`sync({ force: true })`, no con migraciones). Esta migración falla si ya existen códigos duplicados no
vacíos — intencional, no se deduplica en silencio.

**Nota sobre `.partial()` en zod 4** (aplica a todo el repo): `.partial()` **NO** quita los `.default()`.
`z.object({ visible: z.boolean().default(true) }).partial().parse({})` devuelve `{ visible: true }`. Por eso
tanto `productImportUpdateSchema` como `productUpdateSchema` re-declaran `visible` —y `stock`— como
opcionales puros con un `.extend()` aplicado **después** de `.partial()`. Sin eso, un `PUT` que solo
cambiaba el nombre ponía `visible: true` y **publicaba un producto oculto**. Al agregar un campo con
`.default()` a `productBaseSchema`, hay que replicarlo en ambos `.extend()`.
