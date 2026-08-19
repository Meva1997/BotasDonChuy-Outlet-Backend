import { QueryInterface, DataTypes } from "sequelize";

/**
 * Constancia de aceptación de términos (Fase 27): `orders.termsAcceptedAt`,
 * `orders.termsVersion` y `orders.termsAcceptedIp`.
 *
 * Hasta esta fase, el "acepto los términos" del checkout vivía **solo** en el estado de React
 * del navegador: nunca viajaba en `POST /api/orders` y no quedaba registrado en ningún lado.
 * Eso dejaba dos afirmaciones de los documentos legales sin respaldo en el sistema:
 *
 * - Términos §8 dice "sin esa aceptación el proceso no avanza", cuando en realidad la casilla
 *   solo bloqueaba un botón de la interfaz; la API creaba el pedido igual.
 * - Términos §15 y Privacidad §13 prometen que aplica "la versión vigente al momento de la
 *   transacción", pero esa versión no se guardaba en ninguna parte — solo existía implícita en
 *   el historial de git, que no sirve para saber qué texto vio *este* comprador.
 *
 * Qué guarda cada columna:
 * - `termsAcceptedAt`: marca del **servidor** al crear el pedido, nunca un reloj que mande el
 *   cliente. No es el instante del clic en la casilla (paso 1 del checkout) sino el de la
 *   transacción (paso 3) — que es justamente el momento al que se refiere Términos §15.
 * - `termsVersion`: la fecha ISO de los documentos que se le renderizó al comprador. La manda el
 *   frontend porque es el único que sabe qué texto pintó (`LEGAL_VERSION`).
 * - `termsAcceptedIp`: `req.ip`, tomada del request y **nunca del body** — mismo criterio y mismo
 *   dimensionado `STRING(45)` (cabe una IPv6 con IPv4 embebida) que `coupon_redemptions.ip`.
 *   Dato forense: ninguna decisión lo consulta. Ojo: sin `TRUST_PROXY` configurado, `req.ip` es
 *   la del proxy y no la del comprador.
 *
 * **Nullable y sin backfill a propósito.** `null` significa "no hay constancia" —un pedido
 * anterior a esta fase—, jamás "aceptó". Poner las columnas `NOT NULL` obligaría a inventar un
 * valor para los pedidos ya existentes, que es exactamente la clase de afirmación falsa que esta
 * fase existe para eliminar. De aquí en adelante todo pedido nuevo las trae pobladas, porque
 * `createOrderSchema` rechaza con 400 un checkout sin aceptación.
 *
 * Sin índices: nadie consulta ni filtra por estos campos; se leen al abrir un pedido concreto.
 */
export async function up(queryInterface: QueryInterface) {
  await queryInterface.addColumn("orders", "termsAcceptedAt", {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "termsVersion", {
    type: DataTypes.STRING(16),
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("orders", "termsAcceptedIp", {
    type: DataTypes.STRING(45),
    allowNull: true,
    defaultValue: null,
  });
}

export async function down(queryInterface: QueryInterface) {
  await queryInterface.removeColumn("orders", "termsAcceptedIp");
  await queryInterface.removeColumn("orders", "termsVersion");
  await queryInterface.removeColumn("orders", "termsAcceptedAt");
}
