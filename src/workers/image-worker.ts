/**
 * Image Worker — browser-native image compression using OffscreenCanvas.
 * Operations: compress-image, resize-image, convert-image
 *
 * Uses OffscreenCanvas.convertToBlob() for encoding — no WASM dependencies needed.
 * Supports JPEG, WebP, and PNG output formats.
 *
 * Runs in a Web Worker for off-main-thread processing.
 */
import type { WorkerRequest, WorkerResponse, CompressImageOptions } from '../types/worker-messages';
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
