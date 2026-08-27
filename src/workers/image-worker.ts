/**
 * Image Worker — compress / resize, off the main thread.
 *
 * The actual pixel work lives in `src/lib/image-ops.ts` so the identical
 * implementation can also run inline on the main thread for browsers without
 * `OffscreenCanvas` (a worker cannot draw at all there). This file is just the
 * message plumbing.
 */
import type { WorkerRequest, WorkerResponse } from '../types/worker-messages';
import { compressImage, convertImage, resizeImage } from '../lib/image-ops';

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
    } else if (msg.op === 'convert-image') {
      const result = await convertImage(msg.buffer, msg.options, sendProgress);
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
