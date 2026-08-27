import type { WorkerRequest, WorkerResponse, ProgressMessage } from '../types/worker-messages';
import { supportsOffscreenCanvas } from '../lib/canvas-2d';

// Vite ?worker&url imports — ensures workers are compiled to JS at build time
import pdfWorkerUrl from './pdf-worker.ts?worker&url';
import pdfjsWorkerUrl from './pdfjs-worker.ts?worker&url';
import imageWorkerUrl from './image-worker.ts?worker&url';

export type WorkerModule = 'pdf' | 'pdfjs' | 'image';

export interface JobOptions {
  module: WorkerModule;
  message: WorkerRequest;
  transfer?: Transferable[];
  onProgress?: (msg: ProgressMessage) => void;
  signal?: AbortSignal;
}

interface WorkerEntry {
  worker: Worker;
  busy: boolean;
}

interface PendingJob {
  options: JobOptions;
  resolve: (response: WorkerResponse) => void;
  reject: (err: Error) => void;
}

const WORKER_URLS: Record<WorkerModule, string> = {
  pdf: pdfWorkerUrl,
  pdfjs: pdfjsWorkerUrl,
  image: imageWorkerUrl,
};

/**
 * Ops whose implementation needs a 2D drawing surface. A Web Worker without
 * `OffscreenCanvas` cannot draw at all, so on those browsers these run inline on
 * the main thread via the same functions the worker would have called.
 */
const CANVAS_OPS: ReadonlySet<string> = new Set(['compress-image', 'resize-image', 'compress-pdf']);

class WorkerPool {
  private pools = new Map<WorkerModule, WorkerEntry[]>();
  private queues = new Map<WorkerModule, PendingJob[]>();
  private readonly maxWorkers: number;

  constructor() {
    this.maxWorkers = typeof navigator !== 'undefined'
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 2;
  }

  private getPool(module: WorkerModule): WorkerEntry[] {
    if (!this.pools.has(module)) {
      this.pools.set(module, []);
      this.queues.set(module, []);
    }
    return this.pools.get(module)!;
  }

  private getQueue(module: WorkerModule): PendingJob[] {
    this.getPool(module); // ensure initialized
    return this.queues.get(module)!;
  }

  private createWorker(module: WorkerModule): Worker {
    return new Worker(WORKER_URLS[module], { type: 'module' });
  }

  /** Drop a worker from its pool and terminate it. */
  private evict(module: WorkerModule, entry: WorkerEntry): void {
    const pool = this.getPool(module);
    const idx = pool.indexOf(entry);
    if (idx !== -1) pool.splice(idx, 1);
    try { entry.worker.terminate(); } catch { /* already gone */ }
  }

  private dispatch(module: WorkerModule, entry: WorkerEntry, job: PendingJob): void {
    entry.busy = true;
    const { options, resolve, reject } = job;

    // Set up progress channel
    const { port1, port2 } = new MessageChannel();

    if (options.onProgress) {
      port1.onmessage = (e: MessageEvent<ProgressMessage>) => {
        options.onProgress!(e.data);
      };
    }

    // Abort support
    let aborted = false;
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        entry.worker.terminate();
        // Replace the terminated worker
        const pool = this.getPool(module);
        const idx = pool.indexOf(entry);
        if (idx !== -1) pool.splice(idx, 1);
        port1.close();
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }

    entry.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (aborted) return;
      port1.close();
      entry.busy = false;
      resolve(e.data);
      this.drainQueue(module);
    };

    entry.worker.onerror = (e) => {
      if (aborted) return;
      port1.close();
      entry.busy = false;
      // A worker that errors here has usually failed to LOAD (bad script, or a
      // policy refusal) rather than failed one job. It never becomes usable, so
      // leaving it in the pool means every later job routed to it fails the same
      // way. Evict it; the next submit builds a fresh one.
      this.evict(module, entry);
      reject(new Error(e.message || 'Worker error'));
      this.drainQueue(module);
    };

    const transfer: Transferable[] = [port2, ...(options.transfer ?? [])];
    const msgWithPort = { ...options.message, progressPort: port2 };
    entry.worker.postMessage(msgWithPort, transfer);
  }

  private drainQueue(module: WorkerModule): void {
    const queue = this.getQueue(module);
    if (queue.length === 0) return;

    const pool = this.getPool(module);
    let freeEntry = pool.find(e => !e.busy);

    if (!freeEntry && pool.length < this.maxWorkers) {
      const worker = this.createWorker(module);
      freeEntry = { worker, busy: false };
      pool.push(freeEntry);
    }

    if (freeEntry) {
      const job = queue.shift()!;
      this.dispatch(module, freeEntry, job);
    }
  }

  submit(options: JobOptions): Promise<WorkerResponse> {
    // No OffscreenCanvas means a Web Worker has no drawing surface at all, so
    // canvas-backed ops have to run inline instead of being dispatched.
    if (!supportsOffscreenCanvas && CANVAS_OPS.has(options.message.op)) {
      return this.runOnMainThread(options);
    }
    return new Promise((resolve, reject) => {
      const pool = this.getPool(options.module);
      const queue = this.getQueue(options.module);

      let freeEntry = pool.find(e => !e.busy);
      if (!freeEntry && pool.length < this.maxWorkers) {
        const worker = this.createWorker(options.module);
        freeEntry = { worker, busy: false };
        pool.push(freeEntry);
      }

      if (freeEntry) {
        this.dispatch(options.module, freeEntry, { options, resolve, reject });
      } else {
        // All workers busy — queue the job
        queue.push({ options, resolve, reject });
      }
    });
  }

  /**
   * Run a canvas-backed op on the main thread, for browsers with no
   * OffscreenCanvas. Deliberately calls the *same* functions as the worker so
   * the two paths cannot drift apart.
   */
  private async runOnMainThread(options: JobOptions): Promise<WorkerResponse> {
    const { message, signal } = options;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sendProgress = (percent: number, label?: string) => options.onProgress?.({ percent, label });

    try {
      const { compressImage, resizeImage } = await import('../lib/image-ops');
      let result: ArrayBuffer;
      if (message.op === 'compress-image') {
        result = await compressImage(message.buffer, message.options, sendProgress);
      } else if (message.op === 'resize-image') {
        result = await resizeImage(message.buffer, message.mimeType, message.options, sendProgress);
      } else if (message.op === 'compress-pdf') {
        const { compressPdf } = await import('../lib/pdf-compress');
        const out = await compressPdf(message.buffer, message.options, sendProgress);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return {
          status: 'success',
          result: out.buffer,
          stats: {
            originalSize: message.buffer.byteLength,
            outputSize: out.buffer.byteLength,
            imagesTotal: out.imagesTotal,
            imagesRecompressed: out.imagesRecompressed,
          },
        };
      } else {
        return { status: 'error', message: `Operation "${message.op}" has no main-thread fallback` };
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return { status: 'success', result };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Terminate all workers (e.g., on page unload) */
  terminate(): void {
    for (const pool of this.pools.values()) {
      for (const entry of pool) {
        entry.worker.terminate();
      }
    }
    this.pools.clear();
    this.queues.clear();
  }
}

// Singleton — shared across all tool islands
export const workerPool = typeof window !== 'undefined' ? new WorkerPool() : null;

/** Convenience wrapper: submit a job and return a typed success result */
export async function runWorkerJob<T extends WorkerResponse>(
  options: JobOptions
): Promise<T> {
  if (!workerPool) throw new Error('Worker pool not available (SSR)');
  const response = await workerPool.submit(options);
  if (response.status === 'error') {
    throw new Error(response.message);
  }
  return response as T;
}
