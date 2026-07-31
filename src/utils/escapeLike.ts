/**
 * Escapa los comodines de `LIKE`/`ILIKE` (`%`, `_`) y el propio carácter de escape (`\`) en un
 * valor que viene del usuario, para que se busque como texto literal.
 *
 * Sequelize **parametriza** el valor de `Op.iLike` pero **no** escapa sus metacaracteres, así que
 * sin esto un `?q=100%` haría match con TODO el catálogo y un `?q=_` con cualquier producto de
 * una sola letra — el buscador devolvería resultados que nadie pidió.
 *
 * El repo ya pagó este bug una vez: en `productImport.service.ts` una fila llamada
 * "Bota%Premium" emparejaba con "Bota Roja Premium" y —al aplicarse el campo `name`— la
 * RENOMBRABA. Ahí se resolvió esquivando `iLike` (`lower(name) = lower(?)`), pero una búsqueda
 * por substring no puede esquivarlo: necesita el comodín de verdad en los extremos.
 *
 * `\` es el carácter de escape por defecto de `LIKE` en Postgres, así que no hace falta una
 * cláusula `ESCAPE` explícita — que además obligaría a armar la condición con
 * `sequelize.literal` y perdería el binding del valor.
 */
export function escapeLike(value: string): string {
  // Una sola pasada a propósito: encadenar un `.replace` para `\` y otro para `%` volvería a
  // escapar las barras que la primera pasada acaba de introducir.
  return value.replace(/[\\%_]/g, "\\$&");
}
