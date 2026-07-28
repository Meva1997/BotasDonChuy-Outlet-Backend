import { IdempotencyStore, fingerprintOf } from "../../../src/utils/idempotency";

describe("fingerprintOf", () => {
  it("da la misma huella para el mismo payload y una distinta al cambiar un valor", () => {
    const a = fingerprintOf({ items: [[1, 2]], customer: ["Ana"] });
    const b = fingerprintOf({ items: [[1, 2]], customer: ["Ana"] });
    const c = fingerprintOf({ items: [[1, 3]], customer: ["Ana"] });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depende del orden de las claves: normalizar es responsabilidad del llamador", () => {
    // Documenta la limitación que obliga a `checkoutFingerprint` a construir una
    // estructura posicional en vez de pasar el objeto del cliente tal cual.
    expect(fingerprintOf({ a: 1, b: 2 })).not.toBe(fingerprintOf({ b: 2, a: 1 }));
  });
});

describe("IdempotencyStore", () => {
  it("devuelve el valor guardado mientras la entrada esté vigente", () => {
    const store = new IdempotencyStore<string>(60_000);
    store.set("k", "valor");

    expect(store.get("k")).toBe("valor");
    expect(store.has("k")).toBe(true);
    expect(store.get("otra")).toBeUndefined();
    expect(store.has("otra")).toBe(false);
  });

  it("olvida la entrada al vencer el TTL", () => {
    jest.useFakeTimers();
    try {
      const store = new IdempotencyStore<string>(60_000);
      store.set("k", "valor");

      jest.advanceTimersByTime(59_000);
      expect(store.get("k")).toBe("valor");

      jest.advanceTimersByTime(2_000);
      expect(store.get("k")).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("`set` renueva la vigencia de una clave existente", () => {
    jest.useFakeTimers();
    try {
      const store = new IdempotencyStore<string>(60_000);
      store.set("k", "primero");

      jest.advanceTimersByTime(50_000);
      store.set("k", "segundo");

      jest.advanceTimersByTime(30_000); // 80s desde el primer set, 30s desde el segundo
      expect(store.get("k")).toBe("segundo");
    } finally {
      jest.useRealTimers();
    }
  });

  it("`has` distingue una clave reclamada de una libre aunque su valor sea `undefined`", () => {
    // Con `has` implementado como `get(k) !== undefined`, una clave ya reclamada se
    // reportaría libre y dos intentos pasarían el guard.
    const store = new IdempotencyStore<string | undefined>(60_000);
    store.set("k", undefined);

    expect(store.has("k")).toBe(true);
    expect(store.has("otra")).toBe(false);
  });

  it("`has` deja de ver la entrada al vencer el TTL", () => {
    jest.useFakeTimers();
    try {
      const store = new IdempotencyStore<string>(60_000);
      store.set("k", "valor");

      jest.advanceTimersByTime(61_000);
      expect(store.has("k")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("`deleteIf` solo borra si el valor vigente sigue siendo el del llamador", () => {
    const store = new IdempotencyStore<string>(60_000);
    store.set("k", "primero");

    // El intento "primero" falla tarde, cuando la clave ya la reclamó otra petición:
    // borrarla dejaría pasar el duplicado que el store existe para evitar.
    store.set("k", "segundo");
    store.deleteIf("k", (value) => value === "primero");
    expect(store.get("k")).toBe("segundo");

    store.deleteIf("k", (value) => value === "segundo");
    expect(store.get("k")).toBeUndefined();
  });

  it("`delete` libera la clave antes de que expire (reintento tras un fallo)", () => {
    const store = new IdempotencyStore<string>(60_000);
    store.set("k", "valor");

    store.delete("k");

    expect(store.get("k")).toBeUndefined();
  });

  it("`clear` vacía todo el mapa", () => {
    const store = new IdempotencyStore<string>(60_000);
    store.set("a", "1");
    store.set("b", "2");

    store.clear();

    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeUndefined();
  });
});
