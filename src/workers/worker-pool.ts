import type { WorkerRequest, WorkerResponse, ProgressMessage } from '../types/worker-messages';

export type WorkerModule = 'pdf' | 'pdfjs' | 'mupdf' | 'image';

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

const WORKER_URLS: Record<WorkerModule, () => URL> = {
  pdf:   () => new URL('./pdf-worker.ts',   import.meta.url),
  pdfjs: () => new URL('./pdfjs-worker.ts', import.meta.url),
  mupdf: () => new URL('./mupdf-worker.ts', import.meta.url),
  image: () => new URL('./image-worker.ts', import.meta.url),
};

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
    return new Worker(WORKER_URLS[module](), { type: 'module' });
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
