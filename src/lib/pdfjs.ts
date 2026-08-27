/**
 * Central pdf.js loader — the single place the worker and its runtime assets
 * are configured.
 *
 * Every caller (thumbnails, edit, redact, pdf-to-image, merge, …) must go
 * through `getPdfjs()` / `loadPdfDocument()` so the worker is:
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

/**
 * Asset bundles pdf.js fetches lazily while rendering. These MUST be passed to
 * every `getDocument()` call — pdf.js has no global for them.
 *
 * Omitting them looks fine on a desktop Chrome/Firefox, because pdf.js only
 * reaches for `standard_fonts` when the host has no system font matching one of
 * the 14 PDF base fonts. On a machine without Helvetica it does reach for them,
 * and rendering fails with "Ensure that the `standardFontDataUrl` API parameter
 * is provided." All four are served locally by scripts/sync-pdfjs-worker.mjs.
 */
const assetBase = (p: string) =>
  typeof self === 'undefined' ? p : new URL(p, self.location.origin).href;

// Absolute, not root-relative: pdf.js fetches these from inside its worker, and
// that worker may be blob:-backed (see createWorkerPort), where a leading-slash
// path has no valid base to resolve against.
export const PDFJS_DOC_ASSETS = {
  standardFontDataUrl: assetBase('/pdfjs/standard_fonts/'),
  cMapUrl: assetBase('/pdfjs/cmaps/'),
  cMapPacked: true,
  wasmUrl: assetBase('/pdfjs/wasm/'),
  iccUrl: assetBase('/pdfjs/iccs/'),
} as const;

let cached: Promise<typeof PdfjsModule> | null = null;

/**
 * Build the pdf.js worker ourselves from a blob: URL and hand it to pdf.js via
 * `workerPort`, rather than letting pdf.js load it from `workerSrc`.
 *
 * Why: under `Cross-Origin-Embedder-Policy: require-corp`, WebKit refuses to
 * load a worker from a same-origin URL. pdf.js catches the failure, falls back
 * to its main-thread "fake worker", and then cannot import the script either —
 * so the page simply hangs mid-render with no error surfaced to the user.
 * Workers created from a blob: URL are not subject to that check, so this keeps
 * cross-origin isolation (which SharedArrayBuffer — and therefore the
 * multithreaded jSquash encoders — depend on) while still rendering on WebKit.
 *
 * The script is same-origin and byte-identical to what pdf.js would have
 * fetched itself, so nothing leaves the device.
 */
async function createWorkerPort(): Promise<Worker> {
  const res = await fetch(PDFJS_WORKER_SRC);
  if (!res.ok) throw new Error(`Could not load the PDF worker (HTTP ${res.status})`);
  const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  const worker = new Worker(blobUrl, { type: 'module' });
  // The running worker keeps the blob alive; release our URL handle.
  URL.revokeObjectURL(blobUrl);
  return worker;
}

/** Dynamically import pdf.js with the local worker configured exactly once. */
export function getPdfjs(): Promise<typeof PdfjsModule> {
  if (!cached) {
    cached = import('pdfjs-dist').then(async (lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
      try {
        lib.GlobalWorkerOptions.workerPort = await createWorkerPort();
      } catch {
        // Leave workerSrc in place and let pdf.js load the worker its own way.
      }
      return lib;
    });
  }
  return cached;
}

/**
 * Open a PDF with the local worker AND the asset URLs already wired up. Prefer
 * this over calling `getDocument()` directly so no call site can forget them.
 */
export async function loadPdfDocument(
  data: ArrayBuffer | Uint8Array,
  extra: Record<string, unknown> = {}
): Promise<PdfjsModule.PDFDocumentProxy> {
  const lib = await getPdfjs();
  return lib.getDocument({ ...PDFJS_DOC_ASSETS, data, ...extra }).promise;
}
