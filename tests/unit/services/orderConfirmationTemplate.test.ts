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
  orderId: 5,
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

const TRACKING_PAGE_URL = "https://tienda.test/pedido/3f1a9c7e-5d24-4b8e-9f01-2a6c8d4b7e13";

describe("orderConfirmationTemplate — link de seguimiento (Fase O.4)", () => {
  it("incluye el botón con la URL cuando se le pasa `trackingPageUrl`", () => {
    const html = orderConfirmationTemplate({ ...baseInput, trackingPageUrl: TRACKING_PAGE_URL });

    expect(html).toContain(`href="${TRACKING_PAGE_URL}"`);
    expect(html).toContain("Ver el estado de mi pedido");
  });

  it("no renderiza nada cuando no hay URL (pedido sin token), en vez de un link roto", () => {
    const html = orderConfirmationTemplate(baseInput);

    expect(html).not.toContain("Ver el estado de mi pedido");
  });

  it("va también en el correo \"tu pedido va en camino\", no solo en el de confirmación", () => {
    // Los dos correos comparten template y los dos deben llevar el enlace: el cliente puede
    // haber borrado el primero, que es exactamente el escenario que esta fase resuelve.
    const html = orderConfirmationTemplate({
      ...baseInput,
      trackingPageUrl: TRACKING_PAGE_URL,
      tracking: { number: "ESF123", url: "https://rastreo.test/ESF123", carrier: "Estafeta" },
    });

    expect(html).toContain("Tu pedido va en camino");
    expect(html).toContain(`href="${TRACKING_PAGE_URL}"`);
  });
});
