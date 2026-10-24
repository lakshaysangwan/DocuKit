/**
 * Shared image codec built on jSquash (mozjpeg / libwebp / png in WASM), used by
 * both the image worker and the main-thread image tools. These consistently beat
 * the browser's canvas encoders on quality-per-byte (especially JPEG via
 * mozjpeg) and give us one place to add AVIF/HEIC.
 *
 * Works in both a Web Worker and the main thread: the drawing surface comes from
 * `createCanvas2D`, which prefers OffscreenCanvas and falls back to a DOM canvas
 * where OffscreenCanvas is missing (older Safari, some WebKit builds).
 */
import { createCanvas2D } from './canvas-2d';

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
 * Decode a HEIC/HEIF image with libheif (heic-to), for browsers that cannot.
 * The /csp build is deliberate: the default one evaluates a string as script,
 * which our Content-Security-Policy (no 'unsafe-eval') blocks.
 */
export async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  const { heicTo } = await import('heic-to/csp');
  return heicTo({ blob, type: 'bitmap' });
}

/**
 * Decode an encoded image to a bitmap, the way it is shown: EXIF orientation
 * applied (`createImageBitmap`'s default). What the browser cannot decode
 * falls back to a codec: AVIF (some WebKit builds) through libavif, HEIC/HEIF
 * through libheif.
 */
export async function decodeToBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    // Handles JPEG/PNG/WebP/GIF/BMP and (in most browsers) AVIF natively.
    return await createImageBitmap(blob);
  } catch (err) {
    const head = new Uint8Array(await blob.slice(0, 40).arrayBuffer());
    const brands = String.fromCharCode(...head.subarray(4, 40));
    if (brands.startsWith('ftyp') && /avi[fs]/.test(brands)) {
      const { decode } = await import('@jsquash/avif');
      const data = await decode(await blob.arrayBuffer());
      if (!data) throw err;
      return createImageBitmap(data);
    }
    // HEIC/HEIF: the browser can't decode it, so fall back to libheif.
    return decodeHeic(blob);
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
  const bitmap = await decodeToBitmap(new Blob([buffer]));
  const { canvas, ctx } = createCanvas2D(bitmap.width, bitmap.height);
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
