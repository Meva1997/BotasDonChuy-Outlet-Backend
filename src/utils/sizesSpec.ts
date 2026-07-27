/**
 * Parsea la columna "Tallas" del Excel de importación a filas `{ size, stock }`.
 *
 * Acepta dos notaciones, mezclables en la misma celda:
 *
 *   "25, 26, 26"      → una ocurrencia = una unidad (formato heredado del ProductForm)
 *   "26x20"           → 20 unidades de la talla 26
 *   "25x3, 26, 27x2"  → mezcla
 *
 * La notación `x` existe porque el caso de uso central del importador es el RESTOCK: repetir
 * "26," veinte veces para dar de alta veinte pares es inviable en una hoja de cálculo, que es
 * justo lo que el archivo viene a resolver.
 *
 * Los topes no son decorativos: sin ellos una celda como "26x999999999" persiste ese stock tal
 * cual, y una talla de 8 dígitos entraba sin chistar (no hay validación de talla en el modelo).
 */
const MAX_SIZE = 999;
const MAX_UNITS_PER_ENTRY = 9999;
const MAX_DISTINCT_SIZES = 60;
const MAX_TOTAL_UNITS = 10000;

/** `26x20`, `26 X 20`, `26*20`, `26×20`. */
const ENTRY_PATTERN = /^(\d+)\s*(?:[x×*]\s*(\d+))?$/i;

export class SizesSpecError extends Error {}

export function parseSizesSpec(input: string): { size: number; stock: number }[] {
  const entries = input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (entries.length === 0) {
    throw new SizesSpecError('agrega al menos una talla (p. ej. "25, 26, 26" o "26x20")');
  }

  const bySize = new Map<number, number>();
  let totalUnits = 0;

  for (const entry of entries) {
    const match = ENTRY_PATTERN.exec(entry);
    if (!match) {
      throw new SizesSpecError(
        `"${entry}" no es una talla válida; usa números separados por comas ("25, 26") o talla por cantidad ("26x20")`,
      );
    }

    const size = Number(match[1]);
    const quantity = match[2] === undefined ? 1 : Number(match[2]);

    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
      throw new SizesSpecError(`la talla "${entry}" está fuera de rango (debe ser un número entre 1 y ${MAX_SIZE})`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_UNITS_PER_ENTRY) {
      throw new SizesSpecError(
        `la cantidad de la talla ${size} está fuera de rango (debe ser un número entre 1 y ${MAX_UNITS_PER_ENTRY})`,
      );
    }

    bySize.set(size, (bySize.get(size) ?? 0) + quantity);
    totalUnits += quantity;

    if (bySize.size > MAX_DISTINCT_SIZES) {
      throw new SizesSpecError(`hay demasiadas tallas distintas (máximo ${MAX_DISTINCT_SIZES})`);
    }
    if (totalUnits > MAX_TOTAL_UNITS) {
      throw new SizesSpecError(`la fila suma más de ${MAX_TOTAL_UNITS} piezas; divídela en varias filas`);
    }
  }

  return [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([size, stock]) => ({ size, stock }));
}

/** Normaliza un `number[]` (una ocurrencia = una unidad) a la misma forma agrupada. */
export function sizesArrayToSpecRows(sizes: number[]): { size: number; stock: number }[] {
  return parseSizesSpec(sizes.join(","));
}
