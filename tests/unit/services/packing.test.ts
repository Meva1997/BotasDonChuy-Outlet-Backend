import {
  packOrder,
  buildParcels,
  DEFAULT_CARTONS,
  type ParcelLineItem,
} from "../../../src/services/packing";

// Piezas representativas del catálogo sembrado (src/seed.ts).
const BOTA = { type: "bota" as const, weightKg: 2.5, lengthCm: 35, widthCm: 30, heightCm: 20 };
const SOMBRERO = {
  type: "sombrero" as const,
  weightKg: 0.8,
  lengthCm: 45,
  widthCm: 45,
  heightCm: 20,
};
const ROPA = { type: "ropa" as const, weightKg: 0.3, lengthCm: 30, widthCm: 25, heightCm: 10 };

function item(product: ParcelLineItem["product"], quantity: number): ParcelLineItem {
  return { product, quantity };
}

const [CHICA, MEDIANA, GRANDE] = DEFAULT_CARTONS;

describe("packOrder", () => {
  it("carrito vacío → sin cajas", () => {
    expect(packOrder([])).toEqual([]);
  });

  it("una sola pieza baja a la caja más chica donde cabe, no a la maestra", () => {
    // Es el caso mayoritario de la tienda: sin la pasada de downgrade, un pedido de una bota se
    // cotizaría con la caja grande y se sobrecobraría el envío de casi todas las ventas.
    const [box] = packOrder([item(BOTA, 1)]);
    expect(box.carton).toBe(CHICA.name);
    expect(box.units).toBe(1);
    expect(box.parcel).toEqual({
      weight: 2.8, // 2.5 de contenido + 0.3 de tara del cartón
      length: CHICA.lengthCm,
      width: CHICA.widthCm,
      height: CHICA.heightCm,
    });
  });

  it("las dimensiones del bulto son las del CARTÓN, no las del contenido apilado", () => {
    // El modelo anterior sumaba el alto por unidad y producía bultos imposibles (3 botas +
    // 1 sombrero daban 45×45×80 cm). Ahora el bulto es una caja que la tienda realmente tiene.
    const [box] = packOrder([item(BOTA, 3), item(SOMBRERO, 1)]);
    expect(box.carton).toBe(GRANDE.name);
    expect(box.parcel.height).toBe(GRANDE.heightCm);
    expect(box.parcel.weight).toBe(9); // 3×2.5 + 0.8 + 0.7 de tara
  });

  it("el caso del reporte: 3 botas + 1 sombrero van en una sola caja grande", () => {
    const boxes = packOrder([item(BOTA, 3), item(SOMBRERO, 1)]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].units).toBe(4);
    expect(boxes[0].types.sort()).toEqual(["bota", "sombrero"]);
  });

  it("abre una caja más cuando se agota el volumen aprovechable", () => {
    // 8 botas = 168,000 cm³ contra 108,000 aprovechables de la caja grande → 5 + 3.
    const boxes = packOrder([item(BOTA, 8)]);
    expect(boxes).toHaveLength(2);
    expect(boxes.reduce((acc, b) => acc + b.units, 0)).toBe(8);
    expect(boxes.every((b) => b.carton === GRANDE.name)).toBe(true);
  });

  it("abre una caja más cuando se agota el peso, aunque sobre volumen", () => {
    // Pieza chiquita y pesadísima: 12 kg en 10×10×10 cm. El volumen nunca llenaría la caja
    // grande, pero dos piezas ya rebasan sus 25 kg.
    const plomo = { ...BOTA, weightKg: 12, lengthCm: 10, widthCm: 10, heightCm: 10 };
    const boxes = packOrder([item(plomo, 3)]);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      const carton = DEFAULT_CARTONS.find((c) => c.name === box.carton)!;
      expect(box.parcel.weight).toBeLessThanOrEqual(carton.maxWeightKg);
    }
  });

  it("una pieza más grande que cualquier cartón viaja sola con sus propias medidas", () => {
    // Nunca se tumba la cotización por un producto fuera de catálogo: se cotiza tal cual es.
    const mueble = { ...BOTA, lengthCm: 200, widthCm: 80, heightCm: 60, weightKg: 30 };
    const boxes = packOrder([item(mueble, 1), item(ROPA, 1)]);

    const solo = boxes.find((b) => b.carton === null)!;
    expect(solo).toBeDefined();
    expect(solo.units).toBe(1);
    // Dimensiones ordenadas de mayor a menor, sin tara: la caja ES la pieza.
    expect(solo.parcel).toEqual({ weight: 30, length: 200, width: 80, height: 60 });

    // La ropa sigue su camino normal en su propia caja.
    expect(boxes.filter((b) => b.carton !== null)).toHaveLength(1);
  });

  it("una pieza sin dimensiones capturadas ocupa una caja ella sola", () => {
    // Filas anteriores a que `productSchema` exigiera `.positive()`. No se puede afirmar que
    // quepa con nada, así que se cobra un bulto completo — sesgo deliberado a no subcotizar.
    const legado = { ...ROPA, lengthCm: 0, widthCm: 0, heightCm: 0, weightKg: 0 };
    const boxes = packOrder([item(legado, 2), item(ROPA, 1)]);
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.units === 1)).toBe(true);
  });

  it("el acomodo no depende del orden en que se agregó al carrito", () => {
    const a = packOrder([item(SOMBRERO, 1), item(BOTA, 2), item(ROPA, 3)]);
    const b = packOrder([item(ROPA, 3), item(BOTA, 2), item(SOMBRERO, 1)]);
    expect(a).toEqual(b);
  });

  it("una pieza que no cabe en la mediana por ancho se va a la grande, no a la mediana", () => {
    // El sombrero mide 45 cm de lado y la mediana solo 40: por volumen cabría, pero
    // dimensionalmente no. Sin el chequeo de dimensiones se cotizaría una caja donde no entra.
    const [box] = packOrder([item(SOMBRERO, 1)]);
    expect(box.carton).not.toBe(MEDIANA.name);
    expect(box.carton).toBe(GRANDE.name);
  });

  it("respeta el catálogo de cartones que se le pase", () => {
    const unaSola = [
      { name: "única", lengthCm: 100, widthCm: 100, heightCm: 100, maxWeightKg: 50, tareKg: 1 },
    ];
    const boxes = packOrder([item(BOTA, 2)], unaSola);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].carton).toBe("única");
  });
});

describe("buildParcels", () => {
  it("devuelve solo la medida de cada bulto, en el mismo orden que packOrder", () => {
    const items = [item(BOTA, 3), item(SOMBRERO, 1)];
    expect(buildParcels(items)).toEqual(packOrder(items).map((b) => b.parcel));
  });

  it("las dimensiones van en enteros (Skydropx las exige así)", () => {
    const impar = { ...BOTA, lengthCm: 35.4, widthCm: 30.7, heightCm: 20.2 };
    const [parcel] = buildParcels([item(impar, 1)]);
    expect(Number.isInteger(parcel.length)).toBe(true);
    expect(Number.isInteger(parcel.width)).toBe(true);
    expect(Number.isInteger(parcel.height)).toBe(true);
  });
});
