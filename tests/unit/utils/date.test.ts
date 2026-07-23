import {
  utcDayStart,
  addDays,
  isoDay,
  formatShortDate,
  utcMonthStart,
  isoMonth,
  formatMonthLabel,
} from "../../../src/utils/date";

describe("utcDayStart", () => {
  it("trunca a medianoche UTC del mismo día, sin importar la hora", () => {
    const d = new Date("2026-07-03T15:23:45.678Z");
    expect(utcDayStart(d).toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });
});

describe("addDays", () => {
  it("suma días cruzando el límite de mes", () => {
    const d = new Date(Date.UTC(2026, 0, 30)); // 2026-01-30
    expect(isoDay(addDays(d, 3))).toBe("2026-02-02");
  });

  it("suma días cruzando el límite de año", () => {
    const d = new Date(Date.UTC(2025, 11, 30)); // 2025-12-30
    expect(isoDay(addDays(d, 3))).toBe("2026-01-02");
  });

  it("acepta días negativos para retroceder", () => {
    const d = new Date(Date.UTC(2026, 0, 2));
    expect(isoDay(addDays(d, -3))).toBe("2025-12-30");
  });

  it("no muta la fecha original", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    const original = d.toISOString();
    addDays(d, 5);
    expect(d.toISOString()).toBe(original);
  });
});

describe("isoDay", () => {
  it("devuelve la clave de día en UTC (YYYY-MM-DD)", () => {
    expect(isoDay(new Date("2026-07-03T23:59:59.999Z"))).toBe("2026-07-03");
  });
});

describe("formatShortDate — pinado a UTC", () => {
  it("formatea día y mes corto en es-MX", () => {
    expect(formatShortDate(new Date(Date.UTC(2026, 6, 3)))).toBe("3 jul");
  });

  // El bug real que motivó el pin: sin `timeZone: "UTC"`, un host al oeste de UTC
  // (p. ej. America/Mexico_City, UTC-6) convierte esta hora a las 20:00 del día
  // anterior y la etiqueta retrocede un día. Con el pin, el resultado no depende
  // del huso horario del host que corre el proceso.
  it("no retrocede un día para una hora temprana en UTC (madrugada)", () => {
    const nearMidnightUtc = new Date("2026-01-01T02:00:00Z");
    expect(formatShortDate(nearMidnightUtc)).toBe("1 ene");
  });
});

describe("utcMonthStart", () => {
  it("devuelve el primer día del mes en UTC sin importar el día de origen", () => {
    const d = new Date("2026-07-17T23:59:59.999Z");
    expect(utcMonthStart(d).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("isoMonth", () => {
  it("devuelve la clave de mes en UTC (YYYY-MM)", () => {
    expect(isoMonth(new Date("2026-01-31T23:59:59.999Z"))).toBe("2026-01");
  });
});

describe("formatMonthLabel — pinado a UTC", () => {
  it("formatea el mes y año capitalizados, sin 'de' (Enero 2026)", () => {
    expect(formatMonthLabel(new Date(Date.UTC(2026, 0, 1)))).toBe("Enero 2026");
  });

  // Mismo caso límite que formatShortDate: una hora temprana en UTC no debe
  // rodar al mes anterior en un host al oeste de UTC.
  it("no retrocede al mes anterior para una hora temprana en UTC", () => {
    const firstOfMonthEarlyUtc = new Date("2026-02-01T02:00:00Z");
    expect(formatMonthLabel(firstOfMonthEarlyUtc)).toBe("Febrero 2026");
  });
});
