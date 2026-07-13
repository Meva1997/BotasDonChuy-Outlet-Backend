import type { RequestHandler } from "express";
import multer from "multer";
import { AppError } from "./AppError";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB por imagen
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Guardamos el archivo en memoria (no en disco): el buffer se sube directo a
// Cloudinary con upload_stream (ver src/services/image.service.ts) y nunca toca
// el filesystem del servidor.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Un AppError cae en la rama de errorHandler → 400 con mensaje claro.
      cb(new AppError("Tipo de archivo no permitido. Usa PNG, JPEG o WEBP.", 400));
    }
  },
});

/** Sube de 1 a 3 imágenes de producto (campo `images` de un multipart/form-data). */
export const uploadProductImages: RequestHandler = upload.array("images", 3);

/** Sube el logo de la tienda (campo `logo` de un multipart/form-data). */
export const uploadLogo: RequestHandler = upload.single("logo");
