/**
 * Nivel 1 (Fase N.2): la identidad de "persona" del límite de un uso por cliente.
 *
 * Lo que se prueba aquí es la mitad de la llave del índice único parcial de
 * `coupon_redemptions`, así que un cambio de comportamiento cambia a quién bloquea la tienda.
 */
import { normalizeEmailIdentity } from "../../../src/utils/emailIdentity";

describe("normalizeEmailIdentity", () => {
  it("recorta, baja a minúsculas y quita el +alias y los puntos de Gmail", () => {
    expect(normalizeEmailIdentity("  Juan.Perez+promo@GMAIL.com ")).toBe(
      "juanperez@gmail.com",
    );
  });

  it("aplica la regla de los puntos también a googlemail.com (el dominio no se reescribe)", () => {
    expect(normalizeEmailIdentity("juan.perez@googlemail.com")).toBe(
      "juanperez@googlemail.com",
    );
  });

  it("NO quita los puntos en otros dominios (ahí sí distinguen buzón)", () => {
    expect(normalizeEmailIdentity("juan.perez@outlook.com")).toBe("juan.perez@outlook.com");
  });

  it("sí recorta el +alias en cualquier dominio (sobre-fusiona a propósito)", () => {
    expect(normalizeEmailIdentity("juan+trabajo@dominio.com")).toBe("juan@dominio.com");
  });

  it("un buzón que empieza con + no queda vacío", () => {
    expect(normalizeEmailIdentity("+raro@dominio.com")).toBe("+raro@dominio.com");
  });

  it("un valor sin @ se devuelve normalizado en lugar de romperse", () => {
    expect(normalizeEmailIdentity("  NoEsCorreo ")).toBe("noescorreo");
  });

  it("es idempotente: normalizar dos veces da lo mismo", () => {
    const once = normalizeEmailIdentity("A.B+x@Gmail.com");
    expect(normalizeEmailIdentity(once)).toBe(once);
  });

  it("dos alias del mismo buzón colapsan en la misma identidad", () => {
    // Es exactamente el caso que el índice único tiene que reconocer como una sola persona.
    expect(normalizeEmailIdentity("bob+casa@gmail.com")).toBe(
      normalizeEmailIdentity("b.o.b+trabajo@gmail.com"),
    );
  });
});
