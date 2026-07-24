import { computeForecast } from "../../../src/services/forecast";

describe("computeForecast", () => {
  it("serie vacía → 0 / Sin datos", () => {
    expect(computeForecast([])).toEqual({
      forecastNextMonth: 0,
      method: "promedio-simple",
      methodLabel: "Sin datos",
      trend: "estable",
      confidence: "baja",
    });
  });

  describe("1-2 meses → Nivel 1: promedio simple (confianza baja)", () => {
    it("1 mes: el pronóstico es ese mismo valor", () => {
      const result = computeForecast([10]);
      expect(result.forecastNextMonth).toBe(10);
      expect(result.method).toBe("promedio-simple");
      expect(result.trend).toBe("estable");
      expect(result.confidence).toBe("baja");
    });

    it("2 meses: el pronóstico es el promedio redondeado", () => {
      const result = computeForecast([10, 20]);
      expect(result.forecastNextMonth).toBe(15);
      expect(result.method).toBe("promedio-simple");
      expect(result.confidence).toBe("baja");
    });
  });

  describe("3 meses → Nivel 2: promedio ponderado + tendencia (confianza media)", () => {
    it("ratio estable (dentro de [0.85, 1.15]) → trend estable", () => {
      const result = computeForecast([10, 10, 10]);
      expect(result.forecastNextMonth).toBe(10);
      expect(result.method).toBe("tendencia");
      expect(result.trend).toBe("estable");
      expect(result.confidence).toBe("media");
    });

    it("último mes creció >15% respecto al anterior → trend creciendo", () => {
      // weightedAvg = (10*1 + 10*2 + 20*3) / 6 = 15; ratio = 20/10 = 2 → cap a 1.6
      // forecast = 15 * 1.6 = 24
      const result = computeForecast([10, 10, 20]);
      expect(result.forecastNextMonth).toBe(24);
      expect(result.trend).toBe("creciendo");
      expect(result.method).toBe("tendencia");
    });

    it("último mes bajó >15% respecto al anterior → trend bajando", () => {
      // weightedAvg = (20*1 + 20*2 + 5*3) / 6 = 12.5; ratio = 5/20 = 0.25 → floor a 0.5
      // forecast = 12.5 * 0.5 = 6.25 → round 6
      const result = computeForecast([20, 20, 5]);
      expect(result.forecastNextMonth).toBe(6);
      expect(result.trend).toBe("bajando");
      expect(result.method).toBe("tendencia");
    });
  });

  describe("4+ meses → Nivel 3: suavización exponencial de Holt (confianza alta)", () => {
    it("serie linealmente creciente → forecast sigue la tendencia y trend creciendo", () => {
      // Serie con pendiente constante +2/mes: level y trend convergen exactamente
      // en 16 y 2 respectivamente → forecast = round(16 + 2) = 18
      const result = computeForecast([10, 12, 14, 16]);
      expect(result.forecastNextMonth).toBe(18);
      expect(result.method).toBe("suavizacion-exponencial");
      expect(result.trend).toBe("creciendo");
      expect(result.confidence).toBe("alta");
    });

    it("serie linealmente decreciente → forecast sigue la tendencia y trend bajando", () => {
      // Pendiente constante -2/mes: level 14, trend -2 → forecast = round(14 - 2) = 12
      const result = computeForecast([20, 18, 16, 14]);
      expect(result.forecastNextMonth).toBe(12);
      expect(result.trend).toBe("bajando");
      expect(result.confidence).toBe("alta");
    });

    it("serie plana → forecast igual al nivel y trend estable", () => {
      const result = computeForecast([10, 10, 10, 10]);
      expect(result.forecastNextMonth).toBe(10);
      expect(result.trend).toBe("estable");
      expect(result.confidence).toBe("alta");
    });

    it("el pronóstico nunca es negativo aunque la tendencia sea fuertemente decreciente", () => {
      const result = computeForecast([5, 3, 1, 0, 0]);
      expect(result.forecastNextMonth).toBeGreaterThanOrEqual(0);
    });
  });
});
