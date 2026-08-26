/**
 * Central pdf.js loader — the single place the worker source is configured.
 *
 * Every caller (thumbnails, edit, redact, pdf-to-image, merge, …) must go
 * through `getPdfjs()` so the worker is:
 *   • loaded LOCALLY from /pdfjs/pdf.worker.min.mjs (never a CDN — that would
 *     break offline use and the "nothing leaves your device" guarantee), and
 *   • always the same version as the bundled `pdfjs-dist` (the worker file is
 *     copied from node_modules on install by scripts/sync-pdfjs-worker.mjs).
 *
 * A pinned CDN worker drifting from the bundled API is exactly what broke the
 * PDF→Image tool ("API version X does not match the Worker version Y").
 */
import type * as PdfjsModule from 'pdfjs-dist';

export const PDFJS_WORKER_SRC = '/pdfjs/pdf.worker.min.mjs';

let cached: Promise<typeof PdfjsModule> | null = null;

/** Dynamically import pdf.js with the local worker configured exactly once. */
export function getPdfjs(): Promise<typeof PdfjsModule> {
  if (!cached) {
    cached = import('pdfjs-dist').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      return lib;
    });
  }
  return cached;
}
