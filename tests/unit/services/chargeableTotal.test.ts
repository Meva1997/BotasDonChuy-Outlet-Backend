/**
 * Nivel 1 (Fase N.2): el guard de mínimo cobrable.
 *
 * Existe porque Stripe rechaza un cargo por debajo de su mínimo, y ese rechazo llegaría
 * **después** de que `createOrder` commiteó — con la clave de idempotencia conservada (Fase O.2),
 * o sea un pedido `pending` que aparta stock y quema el cupón 30 min sin que el comprador pueda
 * reintentar. Se prueba aquí y no por HTTP porque con la tarifa plana de envío (mínimo $100) el
 * caso no se puede provocar de punta a punta.
 */
import {
  assertChargeableTotal,
  MIN_CHARGE_MXN,
} from "../../../src/services/coupon.service";
import { AppError } from "../../../src/middlewares/AppError";

describe("assertChargeableTotal", () => {
  it("deja pasar un total por encima del mínimo", () => {
    expect(() => assertChargeableTotal(MIN_CHARGE_MXN + 1, 0)).not.toThrow();
  });

  it("deja pasar un total exactamente en el mínimo", () => {
    expect(() => assertChargeableTotal(MIN_CHARGE_MXN, 0)).not.toThrow();
  });

  it("rechaza con 409 un total por debajo del mínimo", () => {
    expect(() => assertChargeableTotal(MIN_CHARGE_MXN - 0.01, 0)).toThrow(AppError);
    try {
      assertChargeableTotal(1, 0);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(409);
    }
  });

  it("rechaza un total en 0 (Stripe no acepta un cargo vacío)", () => {
    expect(() => assertChargeableTotal(0, 0)).toThrow(AppError);
  });

  it("cuando la causa es el cupón, el mensaje dice qué hacer con él", () => {
    try {
      assertChargeableTotal(3, 500);
      throw new Error("debió lanzar");
    } catch (err) {
      // El comprador tiene que poder resolverlo solo: agregar algo o quitar el cupón.
      expect((err as AppError).message).toMatch(/cupón/i);
      expect((err as AppError).message).toMatch(/quita el cupón/i);
    }
  });

  it("sin cupón el mensaje no lo menciona (el problema es el carrito)", () => {
    try {
      assertChargeableTotal(3, 0);
      throw new Error("debió lanzar");
    } catch (err) {
      expect((err as AppError).message).not.toMatch(/cupón/i);
    }
  });
});
