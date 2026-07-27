import type ExcelJS from "exceljs";

/**
 * Lectura de una celda del Excel de importación.
 *
 * El punto crítico de este módulo es la diferencia entre las tres formas de "no hay valor":
 *
 * - `{}` (vacío)              → la celda está en blanco. La clave se OMITE de la fila, así que
 *                               una actualización parcial no toca esa columna del producto.
 * - `{ problem }`             → la celda TIENE contenido pero no se pudo leer (fórmula sin
 *                               resultado, `#REF!`, un objeto que exceljs no expone como texto).
 *                               La fila entera se marca como error: tratarla como "vacía" haría
 *                               que el importador reportara "actualizado" sin haber actualizado.
 * - `{ value, warning }`      → se leyó, pero con una interpretación que conviene confirmar
 *                               (coma decimal, celda con formato de fecha).
 *
 * `ExcelJS.CellValue` no es solo `string | number`: una celda puede llegar como
 * `{ formula, result }`, `{ sharedFormula, result }`, `{ richText: [...] }`, `{ text, hyperlink }`
 * o `{ error }`. Sin desempaquetar cada forma, `String(value)` produce `"[object Object]"`, que
 * en una columna de texto se guardaba tal cual como nombre del producto y en una numérica se
 * volvía `NaN` (y por tanto una columna silenciosamente ignorada).
 */
export interface CellRead<T> {
  value?: T;
  /** La celda tiene contenido ilegible: la fila no se puede aplicar. */
  problem?: string;
  /** Se leyó, pero con una interpretación que el dueño debería confirmar en el preview. */
  warning?: string;
}

interface RichTextValue {
  richText: { text?: string }[];
}
interface FormulaValue {
  formula?: string;
  sharedFormula?: string;
  result?: ExcelJS.CellValue;
}
interface ErrorValue {
  error: string;
}
interface HyperlinkValue {
  text?: string;
  hyperlink?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Convierte una celda a texto plano, desempaquetando las formas de objeto de exceljs.
 * `depth` corta la recursión de una fórmula cuyo `result` sea otra fórmula (no debería pasar,
 * pero un workbook corrupto no debe colgar el proceso).
 */
export function readCellText(raw: ExcelJS.CellValue, depth = 0): CellRead<string> {
  if (raw === null || raw === undefined) return {};

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { value: trimmed } : {};
  }

  if (typeof raw === "number" || typeof raw === "boolean") {
    return { value: String(raw) };
  }

  if (raw instanceof Date) {
    // Excel autoformatea como fecha valores tipo "1-2" o "25/26", así que un código de producto
    // puede llegar aquí convertido. Se lee, pero avisando: el preview lo muestra y el dueño
    // decide (normalmente hay que formatear esa columna como Texto en la hoja).
    return {
      value: raw.toISOString(),
      warning: "la celda tiene formato de fecha; si es un código o un texto, formatea esa columna como Texto en Excel",
    };
  }

  if (isObject(raw)) {
    if (Array.isArray((raw as RichTextValue).richText)) {
      const text = (raw as RichTextValue).richText
        .map((part) => part?.text ?? "")
        .join("")
        .trim();
      return text.length > 0 ? { value: text } : {};
    }

    if (typeof (raw as ErrorValue).error === "string") {
      return { problem: `la celda tiene un error de Excel (${(raw as ErrorValue).error})` };
    }

    const formula = raw as FormulaValue;
    if (typeof formula.formula === "string" || typeof formula.sharedFormula === "string") {
      if (formula.result === null || formula.result === undefined) {
        // Un .xlsx generado por una librería (o guardado sin recalcular) puede traer la fórmula
        // sin su valor. No hay forma de evaluarla aquí, así que la fila falla en vez de
        // reportarse como aplicada sin cambios.
        return {
          problem: "la celda tiene una fórmula sin resultado calculado; ábrela en Excel y guárdala de nuevo, o pega el valor",
        };
      }
      if (depth >= 3) return { problem: "no se pudo leer el contenido de la celda" };
      return readCellText(formula.result, depth + 1);
    }

    if (typeof (raw as HyperlinkValue).text === "string") {
      const text = (raw as HyperlinkValue).text!.trim();
      return text.length > 0 ? { value: text } : {};
    }

    return { problem: "no se pudo leer el contenido de la celda" };
  }

  return { problem: "no se pudo leer el contenido de la celda" };
}

/** Separadores de miles es-MX: "1,234.50" → 1234.50. */
const THOUSANDS_PATTERN = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
/** Coma decimal (hoja hecha con locale europeo): "1,5" → 1.5. */
const DECIMAL_COMMA_PATTERN = /^-?\d+,\d{1,2}$/;

export function readCellNumber(raw: ExcelJS.CellValue): CellRead<number> {
  // El caso normal: la celda ya es numérica y no hay nada que interpretar.
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw } : { problem: "el número de la celda no es válido" };
  }

  const text = readCellText(raw);
  if (text.problem || text.value === undefined) return { problem: text.problem };

  // Se aceptan símbolo de moneda y espacios (incl. el espacio duro que mete Excel al formatear
  // moneda) porque una columna de precios formateada como moneda es lo normal en una hoja.
  const cleaned = text.value.replace(/[$\s ]/g, "");
  if (cleaned.length === 0) return {};

  let normalized = cleaned;
  let warning = text.warning;

  if (THOUSANDS_PATTERN.test(cleaned)) {
    normalized = cleaned.replace(/,/g, "");
  } else if (DECIMAL_COMMA_PATTERN.test(cleaned)) {
    // Antes se quitaban TODAS las comas, así que "1,5" se leía como 15 — un peso de 1.5 kg
    // entraba como 15 kg y se iba así a la cotización de Skydropx.
    normalized = cleaned.replace(",", ".");
    warning = `se interpretó "${cleaned}" como ${normalized}; usa punto para los decimales`;
  } else if (cleaned.includes(",")) {
    return { problem: `"${text.value}" no es un número válido (revisa las comas)` };
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return { problem: `"${text.value}" no es un número válido` };
  return warning ? { value: num, warning } : { value: num };
}

const TRUE_VALUES = new Set(["si", "sí", "true", "1", "verdadero", "x", "v"]);
const FALSE_VALUES = new Set(["no", "false", "0", "falso"]);

export function readCellBoolean(raw: ExcelJS.CellValue): CellRead<boolean> {
  if (typeof raw === "boolean") return { value: raw };

  const text = readCellText(raw);
  if (text.problem || text.value === undefined) return { problem: text.problem };

  const normalized = text.value.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return { value: true };
  if (FALSE_VALUES.has(normalized)) return { value: false };
  // Antes un valor no reconocido se descartaba en silencio, así que una fila con
  // Visible: "quizá" creaba el producto visible sin avisar de nada.
  return { problem: `"${text.value}" no es un valor válido para Visible (usa Sí o No)` };
}
