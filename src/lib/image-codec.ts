/**
 * Shared image codec built on jSquash (mozjpeg / libwebp / png in WASM), used by
 * both the image worker and the main-thread image tools. These consistently beat
 * the browser's canvas encoders on quality-per-byte (especially JPEG via
 * mozjpeg) and give us one place to add AVIF/HEIC.
 *
 * Works in both a Web Worker and the main thread (uses OffscreenCanvas for
 * decode, which is available in both in modern browsers).
 */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';

/** Encode raw pixels to the target format. `quality` is 0–100 (ignored for PNG). */
export async function encodeImageData(
  data: ImageData,
  format: ImageFormat,
  quality = 75,
): Promise<ArrayBuffer> {
  switch (format) {
    case 'jpeg': {
      const { encode } = await import('@jsquash/jpeg');
      return encode(data, { quality });
    }
    case 'webp': {
      const { encode } = await import('@jsquash/webp');
      return encode(data, { quality });
    }
    case 'avif': {
      const { encode } = await import('@jsquash/avif');
      return encode(data, { quality });
    }
    case 'png': {
      const { encode } = await import('@jsquash/png');
      return encode(data);
    }
  }
}

/**
 * Decode an encoded image (any format the browser's `createImageBitmap`
 * understands) into ImageData. Optionally composite onto a solid background
 * (used when converting a transparent PNG to an opaque format like JPEG).
 */
export async function bufferToImageData(
  buffer: ArrayBuffer,
  background?: string,
): Promise<ImageData> {
  const blob = new Blob([buffer]);
  let bitmap: ImageBitmap;
  try {
    // Handles JPEG/PNG/WebP/GIF/BMP and (in modern browsers) AVIF natively.
    bitmap = await createImageBitmap(blob);
  } catch {
    // HEIC/HEIF: the browser can't decode it, so fall back to libheif (heic-to).
    const { heicTo } = await import('heic-to');
    bitmap = await heicTo({ blob, type: 'bitmap' });
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** MIME type for a given output format. */
export function formatMime(format: ImageFormat): string {
  switch (format) {
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'avif': return 'image/avif';
    case 'webp':
    default: return 'image/webp';
  }
}
