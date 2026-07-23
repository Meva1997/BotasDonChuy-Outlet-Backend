import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

// Igual que src/config/stripe.ts: los imports de módulo se evalúan ANTES del
// dotenv.config() de src/app.ts, así que cada config carga su propio .env aquí.
dotenv.config({ quiet: true });

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

// Llaves exigidas: sin ellas ninguna subida/borrado de imágenes funciona, así que
// fallamos rápido al arrancar en vez de descubrirlo en la primera subida.
if (!cloudName || !apiKey || !apiSecret) {
  throw new Error(
    "Cloudinary no está configurado. Agrega CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET al .env.",
  );
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true,
});

/** Cliente Cloudinary compartido (v2). Las llaves viven solo en el .env. */
export { cloudinary };

/** Carpeta de Cloudinary donde viven las imágenes de producto. */
export const CLOUDINARY_PRODUCTS_FOLDER = "botasdonchuy/products";

/** Carpeta de Cloudinary donde vive el logo de la tienda. */
export const CLOUDINARY_BRAND_FOLDER = "botasdonchuy/brand";
