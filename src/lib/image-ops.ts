/**
 * Image operations as plain functions over ArrayBuffers.
 *
 * These live outside the worker on purpose. They get their drawing surface from
 * `createCanvas2D`, so the exact same implementation runs in two realms:
 *
 *   - inside `image-worker.ts` (the normal path — keeps the main thread free), and
 *   - inline on the main thread, when the browser has no `OffscreenCanvas` and a
 *     worker therefore cannot draw at all (see `runsOnMainThread` in the worker pool).
 *
 * Keeping one implementation means the fallback path can't silently drift from
 * the worker path — the e2e suite proves both by running on engines with and
 * without OffscreenCanvas.
 */
import { createCanvas2D, type AnyCanvas, type AnyCanvas2D } from './canvas-2d';
import { encodeImageData, type ImageFormat } from './image-codec';
import type { CompressImageOptions, ResizeImageOptions } from '../types/worker-messages';

export type ProgressFn = (pct: number, label?: string) => void;

/** Map a format option to a jSquash output format. */
export function normalizeFormat(format: string): ImageFormat {
  switch (format) {
    case 'jpeg': return 'jpeg';
    case 'png': return 'png';
    case 'avif': return 'avif';
    case 'webp':
    case 'original':
    default: return 'webp';
  }
}

/** Encode a canvas's pixels via jSquash (mozjpeg/libwebp/png/avif). */
async function encodeCanvas(
  canvas: AnyCanvas,
  ctx: AnyCanvas2D,
  format: ImageFormat,
  quality: number,
): Promise<ArrayBuffer> {
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return encodeImageData(data, format, quality);
}

/**
 * Resize an image: decode via createImageBitmap, scale under the chosen fit mode
 * (white letterbox for fit; centre-crop for cover/fill; distort for stretch),
 * then encode via jSquash.
 */
export async function resizeImage(
  buffer: ArrayBuffer,
  mimeType: string,
  options: ResizeImageOptions,
  sendProgress: ProgressFn,
): Promise<ArrayBuffer> {
  sendProgress(10, 'Decoding image…');
  const bitmap = await createImageBitmap(new Blob([buffer]));
  const nw = bitmap.width;
  const nh = bitmap.height;
  const W = Math.max(1, Math.round(options.width ?? nw));
  const H = Math.max(1, Math.round(options.height ?? nh));

  const { canvas, ctx } = createCanvas2D(W, H);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  if (options.mode === 'stretch') {
    ctx.drawImage(bitmap, 0, 0, W, H);
  } else {
    // 'cover'/'fill' fill the frame (centre-crop); 'fit' letterboxes inside it.
    const cover = options.mode === 'cover' || options.mode === 'fill';
    const scale = cover ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    ctx.drawImage(bitmap, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  bitmap.close();

  sendProgress(60, 'Encoding…');
  const format: ImageFormat = mimeType === 'image/png' ? 'png' : 'jpeg';
  const out = await encodeCanvas(canvas, ctx, format, 92);
  sendProgress(95, 'Finalizing…');
  return out;
}

export async function compressImage(
  buffer: ArrayBuffer,
  options: CompressImageOptions,
  sendProgress: ProgressFn,
): Promise<ArrayBuffer> {
  sendProgress(5, 'Decoding image…');

  const bitmap = await createImageBitmap(new Blob([buffer]));
  const { canvas, ctx } = createCanvas2D(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const quality = options.quality ?? 75;
  const format = normalizeFormat(options.format);

  if (options.mode === 'target-size' && options.targetBytes) {
    return compressToTargetSize(canvas, ctx, buffer, format, options.targetBytes, sendProgress);
  }

  sendProgress(30, 'Compressing…');
  const outputBytes = await encodeCanvas(canvas, ctx, format, quality);
  sendProgress(90, 'Finalizing…');

  // Return the smaller of original vs compressed.
  return outputBytes.byteLength >= buffer.byteLength ? buffer : outputBytes;
}

async function compressToTargetSize(
  canvas: AnyCanvas,
  ctx: AnyCanvas2D,
  originalBuffer: ArrayBuffer,
  format: ImageFormat,
  targetBytes: number,
  sendProgress: ProgressFn,
): Promise<ArrayBuffer> {
  // Force a lossy format for target-size (PNG can't target a size).
  const actualFormat: ImageFormat = format === 'png' ? 'webp' : format;

  let lo = 5;
  let hi = 95;
  let bestResult: ArrayBuffer | null = null;

  // Binary search for the quality that hits the target size.
  for (let i = 0; i < 10 && hi - lo > 2; i++) {
    const mid = Math.round((lo + hi) / 2);
    sendProgress(20 + i * 7, `Trying quality ${mid}%…`);

    const encoded = await encodeCanvas(canvas, ctx, actualFormat, mid);
    if (encoded.byteLength <= targetBytes) {
      lo = mid;
      bestResult = encoded;
    } else {
      hi = mid;
    }
  }

  if (bestResult && bestResult.byteLength <= targetBytes) {
    return bestResult;
  }

  // Try the lowest quality as a last resort.
  const lastResort = await encodeCanvas(canvas, ctx, actualFormat, lo);
  return lastResort.byteLength < originalBuffer.byteLength ? lastResort : originalBuffer;
}
