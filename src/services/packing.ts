/**
 * Empaque de un pedido en cajas reales (Fase N.6).
 *
 * Hasta esta fase el pedido entero se cotizaba como **un solo bulto apilado**: el peso y el
 * alto se sumaban por unidad y largo/ancho tomaban el máximo del carrito. El volumen salía
 * bien, pero la caja no existía — 3 botas + 1 sombrero daba 45×45×**80 cm**, un bulto que la
 * tienda nunca arma y que rebasa el límite de varios servicios. Y como la paquetería cobra
 * **por bulto**, la factura real llegaba más cara que lo cotizado.
 *
 * Aquí se acomoda el carrito en el catálogo de cajas que la tienda realmente usa
 * (`DEFAULT_CARTONS`), y el resultado alimenta a los tres consumidores del costo de envío:
 * la cotización en vivo de Skydropx, la tarifa plana de respaldo (`cart.computeShipping`) y
 * la cantidad de bultos que declara la guía (`skydropx.createShipment`). Que los tres salgan
 * de la misma función es justo el punto: el monto cobrado, el bulto cotizado y el bulto
 * declarado describen el mismo envío físico.
 *
 * Todo el sesgo de los casos borde es **a no subcotizar**, misma política que ya rige los
 * precios en este repo: sobrecobrar unos pesos se corrige capturando bien un producto,
 * subcobrar se paga de la utilidad y no se entera nadie.
 */

export interface ParcelLineItem {
  product: {
    type: "bota" | "sombrero" | "ropa";
    weightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
  };
  quantity: number;
}

export interface Parcel {
  weight: number;
  length: number;
  width: number;
  height: number;
}

/** Una caja física del catálogo de la tienda. */
export interface CartonSpec {
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** Tope de peso del contenido + la propia caja. */
  maxWeightKg: number;
  /** Peso de la caja vacía: la paquetería pesa el bulto completo, no el contenido. */
  tareKg: number;
}

/**
 * Catálogo de cajas de la tienda, de menor a mayor. **Este es el único lugar que hay que
 * editar** cuando el dueño mida sus cajas reales: la cotización, la guía y la tarifa plana
 * se mueven todas con él.
 *
 * Debe quedar ordenado ascendentemente por volumen — `smallestCartonFor` recorre el arreglo
 * en orden y se queda con el primero que aguante.
 */
export const DEFAULT_CARTONS: CartonSpec[] = [
  { name: "chica", lengthCm: 40, widthCm: 35, heightCm: 25, maxWeightKg: 8, tareKg: 0.3 },
  { name: "mediana", lengthCm: 55, widthCm: 40, heightCm: 35, maxWeightKg: 15, tareKg: 0.5 },
  { name: "grande", lengthCm: 60, widthCm: 45, heightCm: 50, maxWeightKg: 25, tareKg: 0.7 },
];

/**
 * Fracción del volumen de una caja que se considera aprovechable. El 20% restante son los
 * huecos de aire entre cajas de zapato que no teselan, el relleno y el cartón mismo.
 *
 * Es **la constante que decide entre subcotizar y sobrecotizar**: subirla mete más piezas por
 * caja (envío más barato, riesgo de que en la realidad no cierren) y bajarla abre cajas de
 * más. 0.8 es deliberadamente conservador — el modo de fallo caro es el que no se ve.
 */
const FILL_FACTOR = 0.8;

/**
 * Tope de bultos que se cotizan en vivo. Un carrito puede traer hasta 50 renglones × 99
 * piezas (`createOrderSchema`), o sea miles de unidades: mandarle cientos de `parcels` a
 * Skydropx es una petición que ninguna paquetería va a cotizar y que solo agota el
 * presupuesto de 8s del poll. Por arriba de este tope el llamador se va directo a la tarifa
 * plana, que desde esta fase también cobra por caja y por lo tanto tampoco subcotiza.
 */
export const MAX_PARCELS_QUOTED = 10;

/** Una caja ya armada: el bulto que se cotiza y qué lleva dentro. */
export interface PackedBox {
  parcel: Parcel;
  /**
   * Nombre del cartón usado, o `null` cuando la pieza es más grande que **cualquier** cartón
   * del catálogo y viaja sola con sus propias medidas.
   */
  carton: string | null;
  /** Tipos de producto que lleva la caja. Es lo que la tarifa plana necesita para cobrarla. */
  types: Array<ParcelLineItem["product"]["type"]>;
  units: number;
}

interface Unit {
  type: ParcelLineItem["product"]["type"];
  weightKg: number;
  /** Dimensiones ordenadas de mayor a menor: comparar así permite girar la pieza dentro de la caja. */
  dims: [number, number, number];
  volume: number;
  /** Alguna dimensión llegó en ≤ 0 (fila anterior a que `productSchema` exigiera `.positive()`). */
  unknownSize: boolean;
}

interface OpenBox {
  units: Unit[];
  weightKg: number;
  volume: number;
  /** La pieza no cabe en ningún cartón: la caja es la pieza. */
  oversizeUnit: Unit | null;
}

function sortedDims(l: number, w: number, h: number): [number, number, number] {
  const [a, b, c] = [l, w, h].sort((x, y) => y - x);
  return [a, b, c];
}

/** ¿Las dimensiones de la pieza caben (girándola) dentro de las de la caja? */
function dimsFit(unit: [number, number, number], carton: [number, number, number]): boolean {
  return unit[0] <= carton[0] && unit[1] <= carton[1] && unit[2] <= carton[2];
}

function cartonDims(c: CartonSpec): [number, number, number] {
  return sortedDims(c.lengthCm, c.widthCm, c.heightCm);
}

function cartonVolume(c: CartonSpec): number {
  return c.lengthCm * c.widthCm * c.heightCm;
}

/** ¿Esta pieza cabe, ella sola, en este cartón? */
function unitFitsCarton(unit: Unit, carton: CartonSpec): boolean {
  // Una pieza de tamaño desconocido se trata como si ocupara el cartón entero: no sabemos qué
  // tan grande es y la respuesta honesta es asumir que necesita su propio bulto.
  if (unit.unknownSize) return unit.weightKg + carton.tareKg <= carton.maxWeightKg;
  return (
    dimsFit(unit.dims, cartonDims(carton)) &&
    unit.volume <= cartonVolume(carton) * FILL_FACTOR &&
    unit.weightKg + carton.tareKg <= carton.maxWeightKg
  );
}

/** El cartón más chico que aguanta este contenido completo, o `null` si no hay ninguno. */
function smallestCartonFor(units: Unit[], cartons: CartonSpec[]): CartonSpec | null {
  const volume = units.reduce((acc, u) => acc + u.volume, 0);
  const weight = units.reduce((acc, u) => acc + u.weightKg, 0);
  return (
    cartons.find(
      (carton) =>
        weight + carton.tareKg <= carton.maxWeightKg &&
        volume <= cartonVolume(carton) * FILL_FACTOR &&
        units.every((u) => unitFitsCarton(u, carton)),
    ) ?? null
  );
}

/** Expande cada renglón a unidades sueltas: el acomodo razona pieza por pieza. */
function toUnits(items: ParcelLineItem[]): Unit[] {
  const units: Unit[] = [];
  for (const item of items) {
    const { type, weightKg, lengthCm, widthCm, heightCm } = item.product;
    const unknownSize =
      !(weightKg > 0) || !(lengthCm > 0) || !(widthCm > 0) || !(heightCm > 0);
    const dims = sortedDims(lengthCm, widthCm, heightCm);
    for (let i = 0; i < item.quantity; i += 1) {
      units.push({
        type,
        // Un peso no capturado cuenta como 0, y eso NO subcotiza: `unknownSize` impide que la
        // pieza comparta caja, así que se va sola en una caja chica y se cobra un bulto
        // completo. El peso real del bulto lo pone la paquetería al recibirlo.
        weightKg: weightKg > 0 ? weightKg : 0,
        dims,
        volume: unknownSize ? 0 : lengthCm * widthCm * heightCm,
        unknownSize,
      });
    }
  }
  return units;
}

/**
 * Acomoda el carrito en cajas del catálogo.
 *
 * Es un *first-fit-decreasing* por volumen contra el cartón **más grande**, seguido de una
 * pasada de *downgrade* que reasigna cada caja cerrada al cartón más chico que la aguante.
 * Esa segunda pasada es lo que hace que **una sola bota se cotice como caja chica** en vez de
 * como la maestra: sin ella, el acomodo sobrecobraría todos los pedidos de una pieza, que son
 * la mayoría.
 *
 * No es un empaquetado 3D exacto (que es NP-difícil y aquí no vale la pena): aproxima por
 * volumen con `FILL_FACTOR`, exige que cada pieza quepa dimensionalmente en la caja, y respeta
 * el tope de peso. Puede abrir una caja de más; nunca mete más de lo que cabe.
 *
 * Una pieza más grande que cualquier cartón **viaja sola con sus propias medidas**
 * (`carton: null`) en vez de tumbar la cotización — es el mismo criterio que hace que un
 * producto sin dimensiones caiga a la tarifa plana en lugar de dar error.
 */
export function packOrder(
  items: ParcelLineItem[],
  cartons: CartonSpec[] = DEFAULT_CARTONS,
): PackedBox[] {
  const units = toUnits(items);
  if (units.length === 0 || cartons.length === 0) return [];

  const largest = cartons[cartons.length - 1];
  const largestDims = cartonDims(largest);
  const largestUsableVolume = cartonVolume(largest) * FILL_FACTOR;

  // Las piezas grandes primero: FFD acomoda mucho mejor que en orden de llegada, y de paso
  // hace que el resultado no dependa del orden en que el cliente agregó cosas al carrito.
  const sorted = [...units].sort((a, b) => b.volume - a.volume);

  const boxes: OpenBox[] = [];
  for (const unit of sorted) {
    if (!unitFitsCarton(unit, largest)) {
      // Más grande (o más pesada) que la caja maestra: se va sola, con sus medidas reales.
      boxes.push({ units: [unit], weightKg: unit.weightKg, volume: unit.volume, oversizeUnit: unit });
      continue;
    }
    const target = boxes.find(
      (box) =>
        box.oversizeUnit === null &&
        box.weightKg + unit.weightKg + largest.tareKg <= largest.maxWeightKg &&
        box.volume + unit.volume <= largestUsableVolume &&
        // Una pieza de tamaño desconocido no comparte caja: no se puede afirmar que quepa.
        !unit.unknownSize &&
        !box.units.some((u) => u.unknownSize) &&
        dimsFit(unit.dims, largestDims),
    );
    if (target) {
      target.units.push(unit);
      target.weightKg += unit.weightKg;
      target.volume += unit.volume;
    } else {
      boxes.push({ units: [unit], weightKg: unit.weightKg, volume: unit.volume, oversizeUnit: null });
    }
  }

  return boxes.map((box) => toPackedBox(box, cartons));
}

function toPackedBox(box: OpenBox, cartons: CartonSpec[]): PackedBox {
  const types = Array.from(new Set(box.units.map((u) => u.type)));

  if (box.oversizeUnit) {
    const unit = box.oversizeUnit;
    return {
      parcel: {
        weight: roundWeight(unit.weightKg),
        length: Math.ceil(unit.dims[0]),
        width: Math.ceil(unit.dims[1]),
        height: Math.ceil(unit.dims[2]),
      },
      carton: null,
      types,
      units: 1,
    };
  }

  // Downgrade: la caja se cierra con el cartón más chico que la aguante. `smallestCartonFor`
  // no puede devolver null aquí (el acomodo ya verificó contra el cartón más grande), pero el
  // fallback deja la función total en vez de depender de esa invariante.
  const carton = smallestCartonFor(box.units, cartons) ?? cartons[cartons.length - 1];
  return {
    parcel: {
      // La paquetería pesa el bulto completo, así que la tara del cartón entra en el peso.
      weight: roundWeight(box.weightKg + carton.tareKg),
      length: Math.ceil(carton.lengthCm),
      width: Math.ceil(carton.widthCm),
      height: Math.ceil(carton.heightCm),
    },
    carton: carton.name,
    types,
    units: box.units.length,
  };
}

function roundWeight(kg: number): number {
  return Math.round(kg * 100) / 100;
}

/**
 * Los bultos de un pedido, listos para mandarse como `parcels` a la cotización de Skydropx.
 * Azúcar sobre `packOrder` para los llamadores a los que solo les interesa la medida.
 */
export function buildParcels(
  items: ParcelLineItem[],
  cartons: CartonSpec[] = DEFAULT_CARTONS,
): Parcel[] {
  return packOrder(items, cartons).map((box) => box.parcel);
}
