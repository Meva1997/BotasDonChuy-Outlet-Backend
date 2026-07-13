import type { UploadApiResponse } from "cloudinary";
import { cloudinary } from "../config/cloudinary";

/** URL pública + public_id de un asset subido a Cloudinary. */
export interface UploadedImage {
  url: string;
  publicId: string;
}

/**
 * Sube un buffer en memoria (de multer.memoryStorage) a Cloudinary y devuelve la
 * `secure_url` + `public_id`. Usamos `upload_stream` manual en vez de
 * `multer-storage-cloudinary` porque ese paquete peer-depende de multer 1.x /
 * cloudinary 1.x (aquí son 2.x) y porque así tenemos el `public_id` a la mano
 * para poder borrar el asset después.
 */
export function uploadImageBuffer(
  buffer: Buffer,
  folder: string,
): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result?: UploadApiResponse) => {
        if (error) return reject(error);
        if (!result) return reject(new Error("Cloudinary no devolvió resultado de subida"));
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

/**
 * Borra un asset de Cloudinary por su `public_id`. Idempotente y tolerante:
 * - Sin `publicId` (imágenes seed/legacy que solo son rutas estáticas, no assets
 *   reales de Cloudinary) no hace nada.
 * - Un asset ya inexistente (`result: "not found"`) se trata como éxito, para que
 *   reintentar un borrado no reviente.
 */
export async function destroyImage(publicId: string | undefined | null): Promise<void> {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId, { invalidate: true });
}
