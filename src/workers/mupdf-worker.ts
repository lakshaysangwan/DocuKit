/**
 * MUPDF Worker — heavy PDF processing
 * Operations: compress-pdf (medium/high), redact, crop-flatten, pdf-to-image
 *
 * Implemented: Week 3 (compress), Week 5 (redact), Week 5 (crop-flatten), Week 6 (pdf-to-image)
 */
import type { WorkerRequest, WorkerResponse } from '../types/worker-messages';

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { progressPort, ...msg } = e.data as WorkerRequest & { progressPort: MessagePort };

  function sendProgress(percent: number, label?: string) {
    progressPort.postMessage({ percent, label });
  }

  try {
    sendProgress(0, 'Loading MUPDF...');

    const response: WorkerResponse = {
      status: 'error',
      message: `Operation "${msg.op}" not yet implemented`,
    };
    self.postMessage(response);
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
