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
import { bufferToImageData, encodeImageData, type ImageFormat } from './image-codec';
import type {
  CompressImageFormat,
  CompressImageOptions,
  CompressImageStats,
  ConvertImageOptions,
  ResizeImageOptions,
} from '../types/worker-messages';
import {
  flattenOnWhite,
  hasQuality,
  hasTransparency,
  mimeForFormat,
  searchTargetQuality,
  sniffImageMime,
} from './compress-image';

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

export interface CompressImageResult {
  buffer: ArrayBuffer;
  stats: CompressImageStats;
}

/**
 * Compress an image at a quality, or to fit a target size.
 *
 * The image is decoded to pixels and re-encoded, so nothing but pixels is
 * carried over (no EXIF). For JPEG, transparent pixels are composited onto
 * white first. Nothing is resized.
 *
 * The input's own bytes come back instead of the encode when the encode is not
 * smaller — in quality mode always, and in target mode only when the original
 * already fits, is the same format that was asked for, and is smaller. The
 * returned `stats.mime` is sniffed from the bytes returned, so it is always
 * their real format.
 */
export async function compressImage(
  buffer: ArrayBuffer,
  options: CompressImageOptions,
  sendProgress: ProgressFn,
): Promise<CompressImageResult> {
  sendProgress(5, 'Decoding image…');
  const format: CompressImageFormat = options.format;
  const originalMime = sniffImageMime(new Uint8Array(buffer));
  const data = await bufferToImageData(buffer);
  const { width, height } = data;

  let flattenedOnWhite = false;
  if (format === 'jpeg' && hasTransparency(data.data)) {
    flattenOnWhite(data.data);
    flattenedOnWhite = true;
  }

  const base = { width, height, flattenedOnWhite, encodedFormat: format };
  const original = (encoded: ArrayBuffer, quality: number | null, target?: CompressImageStats['target']): CompressImageResult => ({
    buffer,
    stats: {
      ...base,
      mime: originalMime ?? 'application/octet-stream',
      encodedQuality: quality,
      encodedBytes: encoded.byteLength,
      returnedOriginal: true,
      target,
    },
  });
  const encodedResult = (encoded: ArrayBuffer, quality: number | null, target?: CompressImageStats['target']): CompressImageResult => ({
    buffer: encoded,
    stats: {
      ...base,
      mime: sniffImageMime(new Uint8Array(encoded)) ?? mimeForFormat(format),
      encodedQuality: quality,
      encodedBytes: encoded.byteLength,
      returnedOriginal: false,
      target,
    },
  });

  if (options.mode === 'target-size' && options.targetBytes && hasQuality(format)) {
    const targetBytes = options.targetBytes;
    let tries = 0;
    const found = await searchTargetQuality(async (q) => {
      sendProgress(Math.min(90, 15 + tries++ * 9), `Trying quality ${q}…`);
      return encodeImageData(data, format, q);
    }, targetBytes);
    sendProgress(95, 'Finalizing…');
    const sameFormat = originalMime === mimeForFormat(format);
    const originalSmaller = buffer.byteLength < found.bytes.byteLength;
    if (found.met) {
      if (sameFormat && originalSmaller && buffer.byteLength <= targetBytes) {
        return original(found.bytes, found.quality, { bytes: targetBytes, met: true });
      }
      return encodedResult(found.bytes, found.quality, { bytes: targetBytes, met: true });
    }
    // Missed: hand back the smallest reached — the original, where that is allowed.
    if (sameFormat && originalSmaller) {
      return original(found.bytes, found.quality, { bytes: targetBytes, met: buffer.byteLength <= targetBytes });
    }
    return encodedResult(found.bytes, found.quality, { bytes: targetBytes, met: false });
  }

  sendProgress(30, 'Compressing…');
  const quality = hasQuality(format) ? Math.max(1, Math.min(100, Math.round(options.quality ?? 75))) : null;
  const encoded = await encodeImageData(data, format, quality ?? undefined);
  sendProgress(90, 'Finalizing…');
  // PNG cannot aim at a size; in target mode it still reports whether it fits.
  const target =
    options.mode === 'target-size' && options.targetBytes
      ? { bytes: options.targetBytes, met: Math.min(encoded.byteLength, buffer.byteLength) <= options.targetBytes }
      : undefined;
  return encoded.byteLength >= buffer.byteLength && originalMime
    ? original(encoded, quality, target)
    : encodedResult(encoded, quality, target && { ...target, met: encoded.byteLength <= target.bytes });
}

/**
 * Convert an image to another format. Transparency is flattened onto white when
 * the target cannot store alpha.
 *
 * Decoding goes through `bufferToImageData`, which falls back to libheif for
 * HEIC/HEIF — that fallback is why this stayed on the main thread longer than
 * the other image ops, but it is worker-safe (libheif is WASM and the 'bitmap'
 * target uses createImageBitmap, which workers have).
 */
export async function convertImage(
  buffer: ArrayBuffer,
  options: ConvertImageOptions,
  sendProgress: ProgressFn,
): Promise<ArrayBuffer> {
  sendProgress(10, 'Decoding image…');
  const format = normalizeFormat(options.format);
  const background = format !== 'png' ? '#FFFFFF' : undefined;
  const data = await bufferToImageData(buffer, background);

  sendProgress(60, 'Encoding…');
  const out = await encodeImageData(data, format, options.quality ?? 85);
  sendProgress(95, 'Finalizing…');
  return out;
}
