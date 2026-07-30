/**
 * Escapa los metacaracteres HTML de un texto controlado por el usuario (nombre, dirección, nombre
 * de producto) antes de interpolarlo en un correo. Sin esto, un `&`/`<`/`>` legítimo en una
 * dirección rompe el render y un valor hostil inyectaría markup.
 *
 * Vive en la carpeta de plantillas y no en `src/utils/`: es parte del contrato de renderizado de
 * los correos, no un helper de propósito general. Estaba definida local en `orderConfirmation.ts`
 * —lo correcto mientras hubo una sola plantilla que la necesitaba—; con tres, tres copias de una
 * función de escape es exactamente lo que se desincroniza y abre el hueco que venía a tapar.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
