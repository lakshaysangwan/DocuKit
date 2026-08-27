/**
 * Image Worker — browser-native image compression using OffscreenCanvas.
 * Operations: compress-image, resize-image, convert-image
 *
 * Uses OffscreenCanvas.convertToBlob() for encoding — no WASM dependencies needed.
 * Supports JPEG, WebP, and PNG output formats.
 *
 * Runs in a Web Worker for off-main-thread processing.
 */
import type { WorkerRequest, WorkerResponse, CompressImageOptions, ResizeImageOptions } from '../types/worker-messages';
import { encodeImageData, type ImageFormat } from '../lib/image-codec';

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { progressPort, ...msg } = e.data as WorkerRequest & { progressPort: MessagePort };

  function sendProgress(percent: number, label?: string) {
    progressPort.postMessage({ percent, label });
  }

  try {
    if (msg.op === 'compress-image') {
      const result = await compressImage(msg.buffer, msg.options, sendProgress);
      const response: WorkerResponse = { status: 'success', result };
      (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(response, [result]);
    } else if (msg.op === 'resize-image') {
      const result = await resizeImage(msg.buffer, msg.mimeType, msg.options, sendProgress);
      const response: WorkerResponse = { status: 'success', result };
      (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(response, [result]);
    } else {
      const response: WorkerResponse = {
        status: 'error',
        message: `Operation "${msg.op}" not yet implemented`,
      };
      self.postMessage(response);
    }
  } catch (err) {
    const response: WorkerResponse = {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  } finally {
    progressPort.close();
  }
};

/** Map format option to a jSquash output format. */
function normalizeFormat(format: string): ImageFormat {
  switch (format) {
    case 'jpeg': return 'jpeg';
    case 'png': return 'png';
    case 'avif': return 'avif';
    case 'webp':
    case 'original':
    default: return 'webp';
  }
}

/** Encode an OffscreenCanvas to ArrayBuffer via jSquash (mozjpeg/webp/png). */
async function encodeCanvas(
  canvas: OffscreenCanvas,
  format: ImageFormat,
  quality: number,
): Promise<ArrayBuffer> {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return encodeImageData(data, format, quality);
}

/**
 * Resize an image entirely off the main thread: decode via createImageBitmap,
 * scale into an OffscreenCanvas under the chosen fit mode (white letterbox for
 * fit; centre-crop for cover/fill; distort for stretch), then encode via
 * jSquash. Mirrors the previous main-thread canvas path so output is identical.
 */
async function resizeImage(
  buffer: ArrayBuffer,
  mimeType: string,
  options: ResizeImageOptions,
  sendProgress: (pct: number, label?: string) => void,
): Promise<ArrayBuffer> {
  sendProgress(10, 'Decoding image…');
  const bitmap = await createImageBitmap(new Blob([buffer]));
  const nw = bitmap.width;
  const nh = bitmap.height;
  const W = Math.max(1, Math.round(options.width ?? nw));
  const H = Math.max(1, Math.round(options.height ?? nh));

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
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
  const data = ctx.getImageData(0, 0, W, H);
  const out = await encodeImageData(data, format, 92);
  sendProgress(95, 'Finalizing…');
  return out;
}

async function compressImage(
  buffer: ArrayBuffer,
  options: CompressImageOptions,
  sendProgress: (pct: number, label?: string) => void,
): Promise<ArrayBuffer> {
  sendProgress(5, 'Decoding image…');

  // Decode input image via createImageBitmap (works in Web Workers)
  const blob = new Blob([buffer]);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const quality = options.quality ?? 75;
  const format = normalizeFormat(options.format);

  if (options.mode === 'target-size' && options.targetBytes) {
    return compressToTargetSize(canvas, buffer, format, options.targetBytes, sendProgress);
  }

  sendProgress(30, 'Compressing…');

  const outputBytes = await encodeCanvas(canvas, format, quality);

  sendProgress(90, 'Finalizing…');

  // Return smaller of original vs compressed
  if (outputBytes.byteLength >= buffer.byteLength) {
    return buffer;
  }

  return outputBytes;
}

async function compressToTargetSize(
  canvas: OffscreenCanvas,
  originalBuffer: ArrayBuffer,
  format: ImageFormat,
  targetBytes: number,
  sendProgress: (pct: number, label?: string) => void,
): Promise<ArrayBuffer> {
  // Force a lossy format for target-size (PNG can't target a size)
  const actualFormat: ImageFormat = format === 'png' ? 'webp' : format;

  let lo = 5;
  let hi = 95;
  let bestResult: ArrayBuffer | null = null;

  // Binary search for quality that hits target size
  for (let i = 0; i < 10 && hi - lo > 2; i++) {
    const mid = Math.round((lo + hi) / 2);
    sendProgress(20 + i * 7, `Trying quality ${mid}%…`);

    const encoded = await encodeCanvas(canvas, actualFormat, mid);
    if (encoded.byteLength <= targetBytes) {
      lo = mid;
      bestResult = encoded;
    } else {
      hi = mid;
    }
  }

  // If we found a quality that works, use it
  if (bestResult && bestResult.byteLength <= targetBytes) {
    return bestResult;
  }

  // Try lowest quality as last resort
  const lastResort = await encodeCanvas(canvas, actualFormat, lo);
  if (lastResort.byteLength < originalBuffer.byteLength) {
    return lastResort;
  }

  return originalBuffer;
}
