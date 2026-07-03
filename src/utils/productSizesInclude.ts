import { ProductSize } from "../models/ProductSize";

// Include reusado por cualquier consulta a Product que necesite resolver los campos
// VIRTUAL stock/sizes (derivados de la asociación ProductSize) — sin este include
// quedan en 0/[] (ver CLAUDE.md). Centralizado para que sus consumidores
// (product.controller, dashboard.service, reports.service) no puedan divergir en los
// atributos traídos.
export const productSizesInclude = {
  model: ProductSize,
  as: "productSizes",
  attributes: ["size", "stock"],
};
