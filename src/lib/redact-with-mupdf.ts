/**
 * Spawn the MuPDF redaction worker for one job and resolve with the redacted
 * PDF bytes. The worker owns the heavy WASM; we terminate it once done so the
 * ~10 MB module is reclaimed between operations.
 */
export interface RedactMark {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function redactWithMupdf(buffer: ArrayBuffer, marks: RedactMark[]): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/mupdf-worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: ArrayBuffer; error?: string }>) => {
      const data = e.data;
      worker.terminate();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error || 'Redaction failed'));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'MUPDF worker failed to load'));
    };

    const copy = buffer.slice(0);
    worker.postMessage({ buffer: copy, marks }, [copy]);
  });
}
