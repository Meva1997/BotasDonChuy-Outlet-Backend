export interface ParcelLineItem {
  product: {
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

/**
 * Arma UNA caja apilada por pedido (ver roadmap-skydropx.md §2): el peso y el
 * alto se suman por unidad (cada pieza se apila encima de la anterior), largo
 * y ancho toman el máximo del carrito (la base de la caja es la del artículo
 * más grande). Nunca subcotiza el peso/alto, aunque puede sobrestimar si las
 * cajas anidarían mejor en la realidad.
 *
 * Skydropx exige `length`/`width`/`height` enteros — se redondean hacia arriba
 * para no subdimensionar el paquete cotizado.
 */
export function buildParcel(items: ParcelLineItem[]): Parcel {
  const weight = items.reduce(
    (acc, item) => acc + item.product.weightKg * item.quantity,
    0,
  );
  const length = Math.max(...items.map((item) => item.product.lengthCm));
  const width = Math.max(...items.map((item) => item.product.widthCm));
  const height = items.reduce(
    (acc, item) => acc + item.product.heightCm * item.quantity,
    0,
  );

  return {
    weight: Math.round(weight * 100) / 100,
    length: Math.ceil(length),
    width: Math.ceil(width),
    height: Math.ceil(height),
  };
}
