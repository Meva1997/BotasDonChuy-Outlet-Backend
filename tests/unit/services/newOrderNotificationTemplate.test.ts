/**
 * Fase N.4, nivel 1 — la plantilla del aviso de venta al dueño y su asunto.
 *
 * El asunto se prueba tanto como el cuerpo a propósito: con el volumen de lanzamiento un correo por
 * venta no es ruido, pero para que siga sin serlo a 20–30 diarias tiene que **leerse sin abrirlo**.
 * Y los dos bloques de acción (guía manual / no recoge a domicilio) son la razón de ser del correo:
 * sin ellos es un recibo redundante con el que ya recibe el cliente.
 */
import {
  newOrderNotificationSubject,
  newOrderNotificationTemplate,
  type NewOrderNotificationInput,
} from "../../../src/services/email/templates/newOrderNotification";

const baseInput: NewOrderNotificationInput = {
  orderId: 142,
  createdAt: new Date("2026-07-29T20:35:00.000Z"), // 14:35 hora de Celaya
  customerName: "Juan Pérez",
  customerEmail: "juan@example.com",
  customerPhone: "4611234567",
  items: [
    { nameSnapshot: "Bota vaquera", size: 26, quantity: 2, unitSalePrice: 750 },
    { nameSnapshot: "Sombrero charro", size: 7, quantity: 1, unitSalePrice: 350 },
  ],
  subtotal: 2100,
  savings: 250,
  shipping: 160,
  total: 1850,
  shippingAddress: {
    street: "Av. Reforma 123",
    neighborhood: "Centro",
    city: "Celaya",
    state: "Guanajuato",
    postalCode: "38000",
  },
  shippingCarrier: "fedex",
  hasSkydropxRate: true,
};

describe("newOrderNotificationSubject (Fase N.4)", () => {
  it("lleva total y piezas para poder leerse sin abrir el correo", () => {
    const subject = newOrderNotificationSubject({
      orderId: 142,
      total: 1850,
      pieces: 3,
      hasSkydropxRate: true,
    });

    expect(subject).toBe("Venta #142 — $1,850.00 — 3 piezas");
  });

  it("marca GUÍA MANUAL cuando el pedido cayó a la tarifa plana de respaldo", () => {
    const subject = newOrderNotificationSubject({
      orderId: 142,
      total: 1850,
      pieces: 3,
      hasSkydropxRate: false,
    });

    expect(subject).toContain("GUÍA MANUAL");
  });

  it("singulariza una sola pieza", () => {
    const subject = newOrderNotificationSubject({
      orderId: 7,
      total: 900,
      pieces: 1,
      hasSkydropxRate: true,
    });

    expect(subject).toContain("1 pieza");
    expect(subject).not.toContain("1 piezas");
  });
});

describe("newOrderNotificationTemplate (Fase N.4)", () => {
  it("renderiza artículos con talla y cantidad, y los datos de contacto del cliente", () => {
    const html = newOrderNotificationTemplate(baseInput);

    expect(html).toContain("Bota vaquera");
    expect(html).toContain("Talla 26");
    expect(html).toContain("×2");
    // El contacto SÍ va: a diferencia de la vista pública del pedido (Fase O.4), este correo es del
    // dueño y son justo los datos con los que resuelve un problema de entrega.
    expect(html).toContain("juan@example.com");
    expect(html).toContain("4611234567");
    expect(html).toContain("Av. Reforma 123");
  });

  it("usa la hora local de la tienda, no la UTC", () => {
    expect(newOrderNotificationTemplate(baseInput)).toContain("14:35");
  });

  it("avisa de la guía manual solo cuando no hay tarifa de Skydropx", () => {
    expect(newOrderNotificationTemplate(baseInput)).not.toContain("necesita guía manual");

    const flatRate = newOrderNotificationTemplate({ ...baseInput, hasSkydropxRate: false });
    expect(flatRate).toContain("Esta venta necesita guía manual");
    expect(flatRate).toContain("panel de Skydropx");
  });

  it("avisa del dropoff solo cuando la paquetería no recoge a domicilio", () => {
    expect(newOrderNotificationTemplate(baseInput)).not.toContain("no recoge a domicilio");

    const dropoff = newOrderNotificationTemplate({ ...baseInput, requiresDropoff: true });
    expect(dropoff).toContain("La paquetería no recoge a domicilio");
  });

  it("los dos avisos pueden salir juntos", () => {
    const html = newOrderNotificationTemplate({
      ...baseInput,
      hasSkydropxRate: false,
      requiresDropoff: true,
    });

    expect(html).toContain("Esta venta necesita guía manual");
    expect(html).toContain("La paquetería no recoge a domicilio");
  });

  it("renderiza la fila del cupón solo cuando hubo descuento", () => {
    expect(newOrderNotificationTemplate(baseInput)).not.toContain("Cupón");

    const withCoupon = newOrderNotificationTemplate({
      ...baseInput,
      couponCode: "VERANO25",
      couponDiscount: 250,
    });
    expect(withCoupon).toContain("Cupón VERANO25");
    expect(withCoupon).toContain("− $250.00");
  });

  it("escapa el HTML de los campos que controla el cliente", () => {
    const html = newOrderNotificationTemplate({
      ...baseInput,
      customerName: '<script>alert("x")</script>',
      shippingAddress: { ...baseInput.shippingAddress, street: "Calle & Cía <b>" },
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Calle &amp; Cía &lt;b&gt;");
  });

  it("nunca menciona costos ni margen (un correo no está autenticado)", () => {
    const html = newOrderNotificationTemplate({ ...baseInput, requiresDropoff: true });

    expect(html.toLowerCase()).not.toContain("unitcost");
    expect(html.toLowerCase()).not.toContain("margen");
    expect(html.toLowerCase()).not.toContain("costo");
  });
});
