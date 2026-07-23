import { formatMoney } from "../../../src/utils/formatMoney";

/**
 * Test de humo (Parte 0): prueba puro sin BD que valida que el pipeline de Jest + ts-jest
 * corre en verde. La cobertura completa de formatMoney se amplía en la Parte 1.
 */
describe("formatMoney", () => {
  it("formatea un entero con símbolo, 2 decimales y separador de miles (es-MX)", () => {
    expect(formatMoney(1920.5)).toBe("$1,920.50");
  });

  it("formatea el cero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });
});
