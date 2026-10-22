/**
 * Spawn the MuPDF redaction worker for one job and resolve with the redacted
 * PDF bytes. The worker owns the heavy WASM; we terminate it once done so the
 * ~10 MB module is reclaimed between operations.
 */
import type { RedactJobMark } from './redact/marks';

export type { RedactJobMark };

export interface RedactOptions {
  /** Also drop the XMP packet and embedded file attachments. */
  stripMetadata?: boolean;
  /** Aborting terminates the worker at once and rejects with an `AbortError`. */
  signal?: AbortSignal;
}

export function redactWithMupdf(
  buffer: ArrayBuffer,
  marks: RedactJobMark[],
  options: RedactOptions = {},
): Promise<ArrayBuffer> {
  const { stripMetadata = false, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Redaction cancelled', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('../workers/mupdf-worker.ts', import.meta.url), {
      type: 'module',
    });
    const onAbort = () => {
      worker.terminate();
      reject(new DOMException('Redaction cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: ArrayBuffer; error?: string }>) => {
      const data = e.data;
      done();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error || 'Redaction failed'));
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'MUPDF worker failed to load'));
    };

    const copy = buffer.slice(0);
    worker.postMessage({ buffer: copy, marks, stripMetadata }, [copy]);
  });
}
