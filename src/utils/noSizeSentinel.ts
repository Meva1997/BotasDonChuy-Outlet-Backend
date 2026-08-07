/**
 * Valor de `size` para la única fila de `ProductSize` (y de `OrderItem.size`) de un producto
 * con `hasSizes: false` — mercancía como un corbatín o una hebilla, que solo tiene cantidad en
 * existencia, sin tallas.
 *
 * Es seguro como centinela porque toda talla real capturada en el repo se valida `>= 1`
 * (`sizesSpec.ts`, `productSchema`), y el filtro público `?talla=` también exige `> 0` antes de
 * interpolarse (`product.controller.ts`), así que `0` nunca puede matchear con una talla legítima.
 */
export const NO_SIZE_SENTINEL = 0;
