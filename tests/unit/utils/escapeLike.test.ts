import { escapeLike } from "../../../src/utils/escapeLike";

describe("escapeLike", () => {
  it("deja intacto un texto sin metacaracteres", () => {
    expect(escapeLike("Bota vaquera")).toBe("Bota vaquera");
  });

  it("escapa el comodín de varios caracteres (%)", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapa el comodín de un carácter (_)", () => {
    expect(escapeLike("BTA_001")).toBe("BTA\\_001");
  });

  it("escapa el propio carácter de escape (\\)", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("no dobla el escape cuando conviven \\ y % en el mismo valor", () => {
    // Una barra y un porcentaje: cada uno gana EXACTAMENTE una barra. Si el escapado se hiciera
    // en dos pasadas (primero `\`, luego `%`), la barra que introduce la segunda pasada volvería
    // a escaparse y el patrón buscaría un texto distinto del que el usuario escribió.
    expect(escapeLike("\\%")).toBe("\\\\\\%");
  });

  it("escapa todas las ocurrencias, no solo la primera", () => {
    expect(escapeLike("%a%b%")).toBe("\\%a\\%b\\%");
  });

  it("devuelve cadena vacía para cadena vacía", () => {
    expect(escapeLike("")).toBe("");
  });
});
