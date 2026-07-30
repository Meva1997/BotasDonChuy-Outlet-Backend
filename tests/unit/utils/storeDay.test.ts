/**
 * Fase N.4, nivel 1 — helpers de día de calendario en la zona de la tienda (Celaya, GTO, UTC−6
 * fijo). Es el corazón del resumen diario: si la ventana se calcula mal, el correo reporta ventas
 * de otro día y el dueño no tiene forma de notarlo.
 */
import {
  MEXICO_CITY_OFFSET,
  formatStoreDayLabel,
  formatStoreTime,
  previousStoreDay,
  storeDay,
  storeDayRange,
  storeHour,
} from "../../../src/utils/storeDay";

describe("storeDay (Fase N.4)", () => {
  it("el corte del día está a las 06:00 UTC, no a medianoche UTC", () => {
    // 05:59 UTC del 30 = 23:59 local del 29. Es EL caso que motiva todo el archivo: en UTC estas
    // dos marcas caen en días distintos, y un resumen "de ayer" en UTC se comería la tarde-noche.
    expect(storeDay(new Date("2026-07-30T05:59:00Z"))).toBe("2026-07-29");
    expect(storeDay(new Date("2026-07-30T06:00:00Z"))).toBe("2026-07-30");
  });

  it("storeHour devuelve 0 y no 24 a la medianoche local", () => {
    // Con `hour12: false` varias versiones de ICU formatean la medianoche como "24"; un
    // `24 >= DAILY_DIGEST_HOUR` mandaría el resumen a medianoche en vez de a las 8.
    expect(storeHour(new Date("2026-07-30T06:00:00Z"))).toBe(0);
    expect(storeHour(new Date("2026-07-30T14:00:00Z"))).toBe(8);
    expect(storeHour(new Date("2026-07-31T05:59:00Z"))).toBe(23);
  });

  it("el offset fijo es el mismo en invierno y en verano (México no tiene DST desde 2022)", () => {
    expect(MEXICO_CITY_OFFSET).toBe("-06:00");
    expect(storeDay(new Date("2026-01-15T06:30:00Z"))).toBe("2026-01-15");
    expect(storeDay(new Date("2026-07-15T06:30:00Z"))).toBe("2026-07-15");
  });
});

describe("storeDayRange (Fase N.4)", () => {
  it("abarca el día local completo, con el fin inclusive", () => {
    const { from, to } = storeDayRange("2026-07-29");
    expect(from.toISOString()).toBe("2026-07-29T06:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-30T05:59:59.999Z");
  });

  it("un pedido a las 23:30 locales cae dentro y uno a las 00:30 del día siguiente, fuera", () => {
    const { from, to } = storeDayRange("2026-07-29");
    const lateSameDay = new Date("2026-07-30T05:30:00Z"); // 23:30 del 29, local
    const earlyNextDay = new Date("2026-07-30T06:30:00Z"); // 00:30 del 30, local

    expect(lateSameDay >= from && lateSameDay <= to).toBe(true);
    expect(earlyNextDay >= from && earlyNextDay <= to).toBe(false);
  });

  it("rechaza un día mal formado en vez de producir fechas inválidas en silencio", () => {
    expect(() => storeDayRange("29-07-2026")).toThrow(/YYYY-MM-DD/);
    expect(() => storeDayRange("")).toThrow(/YYYY-MM-DD/);
  });
});

describe("previousStoreDay (Fase N.4)", () => {
  it("retrocede un día dentro del mismo mes", () => {
    expect(previousStoreDay("2026-07-29")).toBe("2026-07-28");
  });

  it("cruza el cambio de mes y de año", () => {
    expect(previousStoreDay("2026-08-01")).toBe("2026-07-31");
    expect(previousStoreDay("2026-03-01")).toBe("2026-02-28"); // 2026 no es bisiesto
    expect(previousStoreDay("2027-01-01")).toBe("2026-12-31");
  });
});

describe("etiquetas legibles (Fase N.4)", () => {
  it("formatStoreDayLabel nombra el día de la semana correcto en hora local", () => {
    // 2026-07-29 fue miércoles.
    expect(formatStoreDayLabel("2026-07-29")).toMatch(/miércoles/i);
    expect(formatStoreDayLabel("2026-07-29")).toMatch(/29/);
  });

  it("formatStoreTime da la hora local, no la UTC", () => {
    expect(formatStoreTime(new Date("2026-07-29T20:35:00Z"))).toBe("14:35");
  });
});
