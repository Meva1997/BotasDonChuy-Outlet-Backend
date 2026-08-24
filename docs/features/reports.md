# Reports

`src/routes/admin/adminReports.routes.ts`, `src/controllers/reports.controller.ts`,
`src/services/reports.service.ts`; mounted at `/api/admin/reports` (`router.use(requireAuth)`).

Both endpoints are computed **in memory** from a single shared fetch (`loadReportData`) of
`paymentStatus: "paid"` orders (with `items`, `attributes` trimmed to `id`/`createdAt` on `Order` and
`productId`/`quantity` on `items` — the only fields the aggregation reads) + **all** products (with
`productSizes` via the shared `productSizesInclude` from `src/utils/productSizesInclude.ts` — also reused
by `dashboard.service.ts` and `product.controller.ts` — so the `Product.stock` virtual resolves). Since
neither report can be time-windowed the way the dashboard's 180-day queries are (they cover full history by
design), `loadReportData` caches its in-flight/settled promise for `REPORT_CACHE_TTL_MS` (60s); a failed
fetch clears the cache immediately instead of repeating the error until the TTL expires. This keeps a
single admin page load hitting both `/monthly` and `/replenishment` from scanning the full order history
twice. It deliberately includes soft-deleted (discontinued) products, since a product with sales history is
soft-deleted precisely because an `OrderItem` references it — excluding them would erase past sales.

**`GET /api/admin/reports/monthly`** returns `MonthlyReport[]`: units sold grouped by
`(UTC month, productId)` from `OrderItem.quantity`, then for **every** month in `[earliest paid-order month
… current UTC month]` (inclusive, no gaps — empty months emitted as `$0`) it builds `byProduct`.
`monthRange` clamps its start to `to` if `from` is somehow after `to` (clock drift, corrupt/future
`createdAt`), so it returns at least the current month instead of `[]`. Each month's `byProduct` includes
**every live product** (`unitsSold` 0 if unsold) **plus any discontinued product that actually sold that
month** (discontinued ones don't appear as $0 rows in months without activity, so they never clutter recent
months); `revenue = unitsSold × Product.salePrice`, **current** price not the frozen `OrderItem` price;
sorted desc by `unitsSold`. `byCategory` (grouped by `type`, `label` from a plural map replicating
`frontend/lib/categories.ts`, sorted desc by revenue) is derived from that `byProduct`, so discontinued
sales flow into their category too. The month equal to the current UTC month is flagged `partial: true`
(`isoMonth`/`formatMonthLabel`/`utcMonthStart` live in the shared `src/utils/date.ts` alongside the
day-granularity `isoDay`/`formatShortDate`/`utcDayStart` — both **UTC-pinned** for the same reason;
`formatMonthLabel` turns `"enero de 2026"` into the front's `"Enero 2026"`).

**`GET /api/admin/reports/replenishment`** returns `ReplenishmentRow[]` computed on-the-fly (never
persisted): per **live** product (discontinued filtered out — you don't restock a soft-deleted product) it
feeds a monthly `unitsSold` series into `computeForecast` (`src/services/forecast.ts`, the Fase 0 port).
The series uses **complete months only** (`monthlyReports.filter(r => !r.partial)`) — except when there are
**zero** complete months yet (the store's first calendar month), where that rule would leave every series
permanently empty and hide a real day-one stockout for up to a month; in that one case the current partial
month is used as a single low-confidence data point. The month range starts at the **whole store's**
earliest paid order, so a recently-added product would carry a tail of leading `$0` months from before it
existed; those are **trimmed** per product (`rawSeries.slice(firstSale)`) so the padding doesn't dilute the
average or push a short-lived product into the 4+-month exponential-smoothing branch seeded at level 0
(understating demand). `$0` months **after** the first sale are kept (real dry-month demand signal); a
product that never sold gets an empty series → `computeForecast` returns `0`/"Sin datos".

`forecastNextMonth` is rounded to an integer, which can round a real-but-thin demand (~0.4 units/month)
down to `0`; an `effectiveForecast` (the raw average of the trimmed series) is used as a floor whenever
that happens, so `diasCobertura`/`suggestedOrder` don't fall back to the "no sales" sentinel for a product
that actually has sales history and zero stock — `forecastNextMonth` in the response still reports the raw
rounded forecast. From that it derives `diasCobertura` (`round(stock / effectiveForecast × 30)`, `999`
sentinel only when there's neither a rounded forecast nor sales history), `suggestedOrder`
(`max(0, round(effectiveForecast × 2) − stock)`, a 2-month target minus stock),
`ingresoMensual`/`margenMensual` (from the avg of the trimmed complete-month series × price/margin),
`costoEstimadoPedido`, and `priority` (`urgente` <15 días · `pronto` <45 · `ok`). Rows are sorted by
priority rank then `margenMensual` desc. Rounding mirrors the frontend mock exactly:
`ingresoMensual`/`margenMensual`/`diasCobertura`/`suggestedOrder`/`forecastNextMonth` are integers, while
`revenue`/`totalRevenue`/`costoEstimadoPedido` are left raw.

Per the ROADMAP, the backend serves only the raw monthly + replenishment rows; derived metrics (% del
total, promedios, tendencia vs mes anterior) are computed by the frontend. Cost fields appear here because
these are authenticated admin routes. The per-product series extraction transposes each month's `byProduct`
into a `Map<productId, unitsSold>` once (`unitsByMonthMaps`) rather than a `.find()` per product×month
pair, keeping it O(months×products) instead of O(months×products²).
