import type { RequestHandler, Request, Response } from "express";
import { BrandSettings } from "../models/BrandSettings";
import { asyncHandler } from "../middlewares/asyncHandler";
import { AppError } from "../middlewares/AppError";
import { brandSettingsUpdateSchema } from "../schemas/brand";
import { CLOUDINARY_BRAND_FOLDER } from "../config/cloudinary";
import { uploadImageBuffer, destroyImage } from "../services/image.service";

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

/**
 * POST /api/admin/brand/logo
 * Sube el logo (campo multipart `logo`) a Cloudinary y, si había uno anterior,
 * lo destruye para no dejar assets huérfanos.
 */
export const uploadBrandLogo: RequestHandler = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw new AppError(
        'No se recibió ningún archivo. Adjunta el logo en el campo "logo" (PNG, JPEG o WEBP, máximo 5 MB).',
        400,
      );
    }

    const settings = await getOrCreateBrandSettings();
    const previousPublicId = settings.logoPublicId;

    const uploaded = await uploadImageBuffer(req.file.buffer, CLOUDINARY_BRAND_FOLDER);
    await settings.update({ logoUrl: uploaded.url, logoPublicId: uploaded.publicId });

    // Se destruye el anterior solo tras persistir el nuevo (si esto falla, no
    // perdemos el logo actual). Best-effort: un fallo del destroy deja un huérfano
    // en Cloudinary pero no debe tumbar la petición ya persistida.
    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await destroyImage(previousPublicId).catch(() => {});
    }

    res.json(settings);
  },
);

/**
 * DELETE /api/admin/brand/logo
 * Quita el logo de la tienda y lo borra de Cloudinary.
 */
export const deleteBrandLogo: RequestHandler = asyncHandler(
  async (_req: Request, res: Response) => {
    const settings = await getOrCreateBrandSettings();
    const previousPublicId = settings.logoPublicId;

    // Se persiste primero y luego se borra el asset (igual que uploadBrandLogo):
    // así un fallo del destroy deja un huérfano en Cloudinary y no una referencia
    // colgante que rompería el logo en la tienda. El borrado es best-effort.
    await settings.update({ logoUrl: null, logoPublicId: null });
    if (previousPublicId) await destroyImage(previousPublicId).catch(() => {});

    res.json(settings);
  },
);
