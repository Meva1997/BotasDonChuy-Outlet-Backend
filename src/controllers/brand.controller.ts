import type { RequestHandler, Request, Response } from "express";
import { BrandSettings } from "../models/BrandSettings";
import { asyncHandler } from "../middlewares/asyncHandler";
import { brandSettingsUpdateSchema } from "../schemas/brand";

/**
 * Debe coincidir con BRAND_DEFAULTS de src/seed.ts. Duplicado a propósito:
 * seed.ts corre seed() (y process.exit) como side effect al importarse, así
 * que no se puede importar desde un controller sin ejecutar todo el seed.
 */
const BRAND_DEFAULTS = {
  brandName: "Botas Don Chuy Outlet",
  heroText: "Liquidación final · Sin reposición",
  tagline: "Piezas únicas. Sin reposición.\nCuando se acaba, se acaba.",
  cartNotice: "Estos artículos no se reservan",
  footerNote: "Liquidación de inventario · piezas finales · sin reposición",
};

async function getOrCreateBrandSettings(): Promise<BrandSettings> {
  const [settings] = await BrandSettings.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1, ...BRAND_DEFAULTS },
  });
  return settings;
}

export const getBrandSettings: RequestHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const settings = await getOrCreateBrandSettings();
    res.json(settings);
  },
);

export const updateBrandSettings: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const data = brandSettingsUpdateSchema.parse(req.body);

    const settings = await getOrCreateBrandSettings();
    await settings.update(data);
    res.json(settings);
  },
);
