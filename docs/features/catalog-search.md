# Catalog search, sort and price range (Fase N.1)

- `q` searches `name` and `code` with `Op.iLike` (`code` is nullable — a `NULL` simply doesn't match
  inside the `OR`), and the value **must** go through **`escapeLike` (`src/utils/escapeLike.ts`)**:
  Sequelize parameterizes the value but does **not** escape LIKE's `%`/`_`, so `?q=100%` would match
  the entire catalog. This repo already paid that bug once — in `productImport.service.ts` a row named
  `"Bota%Premium"` matched `"Bota Roja Premium"` and **renamed it**. `escapeLike` also escapes `\`
  itself (LIKE's default escape char in Postgres, so no explicit `ESCAPE` clause is needed) — without
  it, `?q=\` would leave a dangling escape and Postgres's `22025` would surface as a **500**.
- `orden` accepts `precio_asc`/`precio_desc`/`novedad` (`id DESC`), default `id ASC`. The two price
  orders carry an **`id` tiebreaker in the same direction as the price**: prices tie constantly and
  Postgres guarantees no stable order without it — page 2 would repeat and drop rows — plus it lets the
  `("salePrice","id")` index serve `precio_desc` as a plain backward scan.
- `precioMin`/`precioMax` use **`Number.isFinite` and `>= 0`, not `Number.isInteger`** (`salePrice` is
  `DECIMAL(10,2)`, so `precioMax=1499.99` is legitimate).
- **Every invalid param is silently ignored, never a `400`** — the precedent `talla` set here; a
  `precioMin` above `precioMax` is **not** swapped (zero results is the honest answer).

Two **partial** indexes back this (`20260729120000-products-catalog-indexes.ts`, mirrored in
`Product.init()`'s `indexes` as the rule requires): `products_type_visible` on `type`, and
`products_sale_price_visible` on **`("salePrice","id")`** — composite because a single-column index
can't satisfy `ORDER BY "salePrice", id` without an incremental sort, which is the whole reason it
exists. Both are partial on `visible = true AND "deletedAt" IS NULL`, the predicate every public query
carries verbatim (the one listing that doesn't, `adminGetProducts`, has no `WHERE` at all). A
`pg_trgm` GIN index on `name` was **deliberately deferred**: the blocker isn't the index but
`CREATE EXTENSION`, which `sync({ force: true })` never runs — the test DB and CI's Postgres container
would build a schema where the GIN index fails. Revisit when the seq-scan `ILIKE` shows up in latency.

`availableSizes` (all sizes with stock > 0 matching `categoria`, `q` and the price range, but
**independent of the `talla` already chosen**) is a separate raw `sequelize.query` aggregate over
`product_sizes` joined to `products`, since it must scan the whole filtered set rather than one page.
Each half of that rule guards a different dead-end: excluding `talla` means picking a size never
empties the size selector; including `q`/price means it never offers a size that returns zero products
under the active search. Its predicates are a **hand-maintained copy** of the shared `where` (it's raw
SQL) — **a new filter must be added on both sides**. Every value goes through `replacements`, never
interpolation: unlike `talla` (an already-validated integer), `q` is arbitrary client input.

**Admin product CRUD** lives in `src/routes/admin/adminProduct.routes.ts` (`/api/admin/products`,
`router.use(requireAuth)`) and reuses `product.controller.ts`. Unlike public reads it exposes
non-visible rows and `unitCost`. Create/update validate with `productSchema`/`productUpdateSchema`
(zod) and write tallas/stock to `ProductSize` inside a `sequelize.transaction`; `sizes` accepts a
`"25,25,26"` string or a number array (each repeat = one stock unit). `DELETE` soft-deletes
(`deletedAt` + `visible:false`) when the product is referenced by an `OrderItem`, otherwise
hard-deletes (its `ProductSize` rows cascade).

**Productos sin tallas (`Product.hasSizes`, default `true`)** cubren mercancía que no se vende por
talla — un corbatín, una hebilla — donde la existencia es una sola cantidad capturada a mano. En vez
de una segunda forma de stock, reusa `ProductSize` con un valor centinela de talla,
`NO_SIZE_SENTINEL = 0` (`src/utils/noSizeSentinel.ts`): un producto `hasSizes:false` tiene **una
sola** fila `ProductSize` con `size: 0`, así que `Product.stock`/`Product.sizes` (los `VIRTUAL`s) y
todo el descuento/reingreso atómico de stock (`createOrder`, `releaseOrderStock`,
`cancelOrderByAdmin`) siguen funcionando sin ninguna rama nueva — ya operan genéricamente sobre
`(productId, size)`. `0` es seguro como centinela porque toda talla real se valida `>= 1` en todo el
repo (`sizesSpec.ts`, `productSchema`, el filtro público `?talla=`).

`productSchema`/`productUpdateSchema` agregan `hasSizes` y `stockQuantity` (la cantidad manual,
obligatoria solo cuando `hasSizes:false`; `sizes` sigue siendo obligatorio cuando `hasSizes` es
`true`, el default). Mandar el campo del modo contrario es `400` (mismo patrón de reglas cruzadas que
`couponRuleIssues` en `src/schemas/coupon.ts`). En el `PUT` la obligatoriedad **al cambiar de modo**
se valida en `adminUpdateProduct` contra el `hasSizes` ya guardado (mismo patrón que el cruce de
precios que ya vivía ahí) — un `PUT` parcial que no toca el modo no debe forzar a resituar
`sizes`/`stockQuantity`. `getProducts`'s `availableSizes` filtra `p."hasSizes" = true`, o la fila
centinela se colaría como "talla 0" en el selector público. El checkout acepta `size: 0` en
`orderItemSchema` solo para estos productos — `createOrder` valida que la talla mandada coincida con
el modo del producto (400 en cualquier combinación cruzada) antes del descuento atómico. La
importación masiva por Excel **no** soporta este modo todavía: toda fila importada crea/actualiza un
producto `hasSizes:true`.
