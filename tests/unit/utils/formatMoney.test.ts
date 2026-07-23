import { formatMoney } from "../../../src/utils/formatMoney";

describe("formatMoney", () => {
  it("formatea un entero con símbolo, 2 decimales y separador de miles (es-MX)", () => {
    expect(formatMoney(1920.5)).toBe("$1,920.50");
  });

  it("formatea el cero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("siempre muestra 2 decimales aunque el monto sea entero", () => {
    expect(formatMoney(500)).toBe("$500.00");
  });

  it("agrega separador de miles en montos grandes", () => {
    expect(formatMoney(1234567.89)).toBe("$1,234,567.89");
  });

  it("redondea a 2 decimales (maximumFractionDigits)", () => {
    expect(formatMoney(19.999)).toBe("$20.00");
  });

  it("formatea negativos con el signo antes del monto", () => {
    expect(formatMoney(-1920.5)).toBe("$-1,920.50");
  });
});
