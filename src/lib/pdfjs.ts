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

/**
 * A page (not a worker) in a WebKit browser. Chromium's user agent carries
 * "AppleWebKit" too, so Chromium-based browsers are told apart by their own
 * token; Chrome and Edge on iOS (CriOS, EdgiOS) are WebKit and stay in.
 */
function isWebKitPage(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /AppleWebKit\//.test(ua) && !/\b(Chrome|Chromium|Edg|OPR)\//.test(ua);
}

/** Set once by `getPdfjs()`: the library and the blob-backed worker it runs on. */
let pdfjs: typeof PdfjsModule | null = null;
let workerPort: Worker | null = null;
let sharedWorker: PdfjsModule.PDFWorker | null = null;

/**
 * The one `PDFWorker` every document on the page is opened with.
 *
 * Why it is handed to `getDocument()` explicitly rather than left to
 * `GlobalWorkerOptions.workerPort`: a document that finds its worker through the
 * global port OWNS it. `loadingTask.destroy()` then marks that worker
 * `_pendingDestroy` until the worker thread has acknowledged the teardown, and
 * any `getDocument()` in that window throws "PDFWorker.create - the worker is
 * being destroyed. Please remember to await PDFDocumentLoadingTask.destroy()".
 * Every preview here used to call `doc.destroy()` without awaiting it, so
 * opening the next document straight afterwards failed now and then — Crop PDF's
 * Flatten mode, which opens the file again the moment Crop is clicked, was the
 * one users could hit.
 *
 * A document given `worker` does not own it: destroying the document releases
 * the document and leaves the worker alone, so there is no window to race with,
 * whether or not the caller awaits.
 */
function getSharedWorker(): PdfjsModule.PDFWorker | undefined {
  if (!pdfjs || !workerPort) return undefined;
  if (!sharedWorker || sharedWorker.destroyed) {
    try {
      sharedWorker = pdfjs.PDFWorker.create({ port: workerPort });
    } catch {
      return undefined;
    }
  }
  return sharedWorker;
}

// Absolute, not root-relative: pdf.js fetches these from inside its worker, and
// that worker may be blob:-backed (see createWorkerPort), where a leading-slash
// path has no valid base to resolve against.
export const PDFJS_DOC_ASSETS = {
  standardFontDataUrl: assetBase('/pdfjs/standard_fonts/'),
  cMapUrl: assetBase('/pdfjs/cmaps/'),
  cMapPacked: true,
  wasmUrl: assetBase('/pdfjs/wasm/'),
  iccUrl: assetBase('/pdfjs/iccs/'),
  /**
   * On WebKit (Safari, every iOS browser, GNOME Web) pdf.js is told not to use
   * OffscreenCanvas. With it, pdf.js's worker decodes each image into an
   * ImageBitmap and the page draws that bitmap; Linux WebKit drew a large one
   * solid black — Crop PDF's flattened pages showed as black rectangles while
   * the file itself was right. Without it the worker sends plain pixels, which
   * every engine draws, and which is the only path WebKit builds without
   * OffscreenCanvas (Playwright's on Windows) have ever taken — the one tested.
   * Undefined elsewhere, so pdf.js keeps its own default.
   */
  isOffscreenCanvasSupported: isWebKitPage() ? false : undefined,
  /**
   * The shared worker (see `getSharedWorker`). A getter, so the object spread at
   * every `getDocument({ ...PDFJS_DOC_ASSETS, data })` call picks it up once
   * `getPdfjs()` has resolved. Undefined before that, in the worker pool's own
   * copy of this module, and when the blob worker could not be created — pdf.js
   * then falls back to a worker per document.
   */
  get worker(): PdfjsModule.PDFWorker | undefined {
    return getSharedWorker();
  },
};

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
        workerPort = await createWorkerPort();
        // Still registered globally, so a call that forgets PDFJS_DOC_ASSETS
        // renders on WebKit; it just does not get the teardown guarantee above.
        lib.GlobalWorkerOptions.workerPort = workerPort;
      } catch {
        // Leave workerSrc in place and let pdf.js load the worker its own way.
      }
      pdfjs = lib;
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
