/**
 * Fase O.4 — el link a la página pública de seguimiento dentro del correo del pedido.
 * Nivel 1 (unitario puro, sin BD): `orderConfirmationTemplate` es una función que devuelve un
 * string.
 *
 * Se prueba solo el bloque que agrega esta fase. Es la mitad visible de O.4: el endpoint puede
 * funcionar perfecto y la fase seguir sin resolver nada si el correo no lleva el enlace, que es
 * justo por donde el cliente llega a él.
 */
import { orderConfirmationTemplate } from "../../../src/services/email/templates/orderConfirmation";

const baseInput = {
  createdAt: new Date("2026-07-20T18:00:00.000Z"),
  customerName: "Juan Pérez",
  items: [
    {
      nameSnapshot: "Bota vaquera",
      size: 26,
      quantity: 1,
      unitSalePrice: 1499,
      unitOriginalPrice: 1899,
    },
  ],
  subtotal: 1899,
  savings: 400,
  shipping: 160,
  total: 1659,
  shippingAddress: {
    street: "Av. Reforma 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "Guanajuato",
    postalCode: "38000",
  },
};

const TRACKING_CODE = "3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13";
const TRACKING_PAGE_URL = `https://tienda.test/pedido/${TRACKING_CODE}`;
const TRACKING_LOOKUP_URL = "https://tienda.test/pedido";

const trackingInput = {
  ...baseInput,
  trackingPageUrl: TRACKING_PAGE_URL,
  trackingCode: TRACKING_CODE,
  trackingLookupUrl: TRACKING_LOOKUP_URL,
};

/**
 * El HTML sin el contenido de ningún atributo `href`. Sirve para afirmar que algo se ve de verdad
 * en el correo y no solo está escondido dentro de un link — que es exactamente el problema que el
 * código copiable resuelve.
 */
function withoutHrefs(html: string): string {
  return html.replace(/href="[^"]*"/g, 'href=""');
}

describe("orderConfirmationTemplate — link de seguimiento (Fase O.4)", () => {
  it("incluye el botón con la URL cuando se le pasa `trackingPageUrl`", () => {
    const html = orderConfirmationTemplate(trackingInput);

    expect(html).toContain(`href="${TRACKING_PAGE_URL}"`);
    expect(html).toContain("Ver el estado de mi pedido");
  });

  it("no renderiza nada cuando no hay URL ni código (pedido sin token), en vez de un link roto", () => {
    const html = orderConfirmationTemplate(baseInput);

    expect(html).not.toContain("Ver el estado de mi pedido");
    expect(html).not.toContain("código de seguimiento");
  });

  it("va también en el correo \"tu pedido va en camino\", no solo en el de confirmación", () => {
    // Los dos correos comparten template y los dos deben llevar el enlace: el cliente puede
    // haber borrado el primero, que es exactamente el escenario que esta fase resuelve.
    const html = orderConfirmationTemplate({
      ...trackingInput,
      tracking: { number: "ESF123", url: "https://rastreo.test/ESF123", carrier: "Estafeta" },
    });

    expect(html).toContain("Tu pedido va en camino");
    expect(html).toContain(`href="${TRACKING_PAGE_URL}"`);
    expect(withoutHrefs(html)).toContain(TRACKING_CODE);
  });
});

describe("orderConfirmationTemplate — código de seguimiento copiable", () => {
  it("pinta el código a la vista, no solo dentro del href del botón", () => {
    // El botón ya llevaba el token en su `href`, pero para usar la página de consulta —que pide el
    // código— había que saber hacer "copiar dirección del enlace". Esta aserción es la fase entera.
    const html = orderConfirmationTemplate(trackingInput);

    expect(withoutHrefs(html)).toContain(TRACKING_CODE);
    expect(html).toContain("código de seguimiento");
  });

  it("no envuelve el código en un `<a>`", () => {
    // Si lo fuera, tocarlo en el móvil navegaría en vez de dejar seleccionar el texto.
    const html = orderConfirmationTemplate(trackingInput);
    const codeIndex = withoutHrefs(html).indexOf(TRACKING_CODE);
    const openTag = html.lastIndexOf("<", codeIndex);

    expect(html.slice(openTag, codeIndex)).not.toContain("<a ");
  });

  it("nombra la página donde se pega el código", () => {
    expect(orderConfirmationTemplate(trackingInput)).toContain(TRACKING_LOOKUP_URL);
  });

  it("sigue mostrando el botón cuando hay código pero no URL de la página del pedido", () => {
    const html = orderConfirmationTemplate({ ...baseInput, trackingCode: TRACKING_CODE });

    expect(html).not.toContain("Ver el estado de mi pedido");
    expect(withoutHrefs(html)).toContain(TRACKING_CODE);
  });

  it("escapa el código antes de interpolarlo", () => {
    const html = orderConfirmationTemplate({ ...baseInput, trackingCode: "<b>X</b>" });

    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});

describe("orderConfirmationTemplate — sin número de pedido", () => {
  // `Order.id` es un consecutivo global de la tienda, no del comprador: "tu pedido #20" le sugiere
  // veinte compras que no hizo, y como referencia no le sirve (la consulta pública es por token).
  it("no menciona ningún número de pedido en la confirmación", () => {
    expect(orderConfirmationTemplate(trackingInput)).not.toMatch(/pedido\s*<strong>#/);
  });

  it("tampoco en el correo \"va en camino\"", () => {
    const html = orderConfirmationTemplate({
      ...trackingInput,
      tracking: { number: "ESF123", carrier: "Estafeta" },
    });

    expect(html).not.toMatch(/pedido\s*<strong>#/);
  });

  it("conserva la fecha del pedido, que es lo que sí distingue dos compras", () => {
    expect(orderConfirmationTemplate(trackingInput)).toContain("20 de julio de 2026");
  });
});

describe("orderConfirmationTemplate — fila del cupón (Fase N.2)", () => {
  it("renderiza el código y el importe descontado", () => {
    const html = orderConfirmationTemplate({
      ...baseInput,
      couponCode: "VERANO25",
      couponDiscount: 150,
      total: 1509,
    });

    expect(html).toContain("Cupón VERANO25");
    expect(html).toContain("$150.00");
  });

  it("la fila del cupón va ANTES de la de Envío", () => {
    // No es cosmético: ese orden es la prueba visual de que el descuento se aplicó a la
    // mercancía y no a la paquetería, que es la regla central de la fase.
    const html = orderConfirmationTemplate({
      ...baseInput,
      couponCode: "VERANO25",
      couponDiscount: 150,
      total: 1509,
    });

    expect(html.indexOf("Cupón VERANO25")).toBeLessThan(html.indexOf("Envío"));
  });

  it("no renderiza la fila cuando no hubo cupón", () => {
    expect(orderConfirmationTemplate(baseInput)).not.toContain("Cupón");
  });

  it("no la renderiza tampoco con un descuento en 0", () => {
    const html = orderConfirmationTemplate({
      ...baseInput,
      couponCode: "VERANO25",
      couponDiscount: 0,
    });

    expect(html).not.toContain("Cupón VERANO25");
  });

  it("escapa el código antes de interpolarlo", () => {
    const html = orderConfirmationTemplate({
      ...baseInput,
      couponCode: "<b>X</b>" as string,
      couponDiscount: 10,
    });

    expect(html).not.toContain("Cupón <b>X</b>");
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});
