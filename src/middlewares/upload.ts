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

const MAX_IMPORT_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB — hoja de cálculo, no imágenes
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// exceljs solo lee .xlsx (OOXML); .xls binario legado se rechaza aquí en vez de fallar
// confuso más adelante durante el parseo (ver src/services/productImport.service.ts).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === XLSX_MIME_TYPE) {
      cb(null, true);
    } else {
      cb(new AppError("Tipo de archivo no permitido. Sube un archivo Excel (.xlsx).", 400));
    }
  },
});

/** Sube el Excel de importación/restock masivo de productos (campo `file` de un multipart/form-data). */
export const uploadProductImportFile: RequestHandler = importUpload.single("file");
