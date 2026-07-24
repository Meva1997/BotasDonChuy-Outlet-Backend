/**
 * Mock reutilizable del cliente Cloudinary (`src/config/cloudinary`). Scaffolding para
 * la Parte 8: ninguna subida/borrado de imagen debe tocar Cloudinary real.
 *
 * Uso en un test (el `jest.mock` va en el propio archivo de test, por el hoisting de
 * Jest — ver el mismo patrón en tests/setup/mocks/stripe.ts):
 *
 *   const cloudinaryMock = buildCloudinaryMock();
 *   jest.mock("../../src/config/cloudinary", () => ({
 *     cloudinary: cloudinaryMock,
 *     CLOUDINARY_PRODUCTS_FOLDER: "botasdonchuy/products",
 *     CLOUDINARY_BRAND_FOLDER: "botasdonchuy/brand",
 *   }));
 *
 *   beforeEach(() => resetCloudinaryMock(cloudinaryMock));
 *
 * `image.service.ts`'s `uploadImageBuffer` calls `cloudinary.uploader.upload_stream(options,
 * callback)` and writes the buffer via the returned stream's `.end()` — the default
 * implementation here invokes the callback synchronously from `.end()` with an
 * incrementing fake `public_id`/`secure_url`, so `Promise.allSettled` over several
 * uploads resolves each with a distinct identity.
 */
type UploadCallback = (error: unknown, result?: { secure_url: string; public_id: string }) => void;

export function buildCloudinaryMock() {
  return {
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  };
}

export type CloudinaryMock = ReturnType<typeof buildCloudinaryMock>;

/**
 * Restaura el comportamiento por defecto (subidas y borrados exitosos). Se llama en
 * `beforeEach` en vez de confiar solo en `clearMocks`, porque `clearMocks` no deshace
 * un `mockImplementationOnce`/`mockResolvedValue` que un test anterior haya dejado
 * encolado (p. ej. `failNextUpload`).
 */
export function resetCloudinaryMock(mock: CloudinaryMock): void {
  let counter = 0;
  mock.uploader.upload_stream.mockReset().mockImplementation(
    (_options: unknown, callback: UploadCallback) => ({
      end: (_buffer: Buffer) => {
        counter += 1;
        callback(null, {
          secure_url: `https://cloudinary.test/image-${counter}.jpg`,
          public_id: `test-public-id-${counter}`,
        });
      },
    }),
  );
  mock.uploader.destroy.mockReset().mockResolvedValue({ result: "ok" });
}

/** Hace que las próximas `times` subidas fallen (para probar el cleanup "todo o nada"). */
export function failNextUpload(mock: CloudinaryMock, times = 1): void {
  for (let i = 0; i < times; i++) {
    mock.uploader.upload_stream.mockImplementationOnce(
      (_options: unknown, callback: UploadCallback) => ({
        end: (_buffer: Buffer) => callback(new Error("cloudinary upload failed (test)")),
      }),
    );
  }
}
