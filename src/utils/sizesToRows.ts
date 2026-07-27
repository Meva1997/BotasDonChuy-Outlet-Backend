/**
 * Agrupa una lista de tallas repetidas (p. ej. `[25, 25, 26]`, una ocurrencia = una unidad de
 * stock) en filas `{ size, stock }` listas para `ProductSize.bulkCreate`. Compartido entre
 * `product.controller.ts` (crear/actualizar producto por API) y `productImport.service.ts`
 * (importación masiva por Excel) para no duplicar la lógica de conteo.
 */
export function sizesToRows(sizes: number[]): { size: number; stock: number }[] {
  const map = new Map<number, number>();
  for (const s of sizes) map.set(s, (map.get(s) ?? 0) + 1);
  return Array.from(map.entries()).map(([size, stock]) => ({ size, stock }));
}
