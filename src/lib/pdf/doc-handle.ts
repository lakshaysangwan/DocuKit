/**
 * PdfDocHandle: one open pdf.js document for one file, shared by everything
 * that looks at it.
 *
 *     const doc = await openPdf(file);          // opened once
 *     doc.pageCount                             // known immediately
 *     const geom = await doc.geometry(0);       // how the page maps to the file
 *     const { url } = await doc.renderPage(0, { cssWidth: 720 });   // <img src>
 *     doc.requestThumb(3, 200);                 // rendered in idle time
 *     await doc.destroy();                      // on file removal / unmount
 *
 * What it guarantees, because every preview used to get these wrong on its own:
 *
 *   • ONE pdf.js document per handle. The count, thumbnails, the main page,
 *     text and geometry all come from it; nothing re-opens the file.
 *   • Rasters are `blob:` URLs for `<img>`, owned by the handle. Never a data
 *     URL (megabytes of base64 in React state) and never a canvas per page: one
 *     scratch canvas is shared by every render and emptied after each.
 *   • Renders go through the shared scheduler — one at a time, visible first,
 *     the rest in idle time — and stay under a pixel budget.
 *   • `destroy()` cancels what is pending, revokes every URL the handle made and
 *     resolves only once pdf.js has torn the document down.
 *
 * Page indexes are ZERO-based everywhere in this API (pdf.js itself is 1-based).
 *
 * Reading the source: a `File` is read once and its bytes are handed to pdf.js,
 * which transfers them to its worker — no copy stays on the main thread. An
 * `ArrayBuffer` has to be copied first, because that transfer would otherwise
 * detach the caller's buffer. So tools should keep the `File` and pass that.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { getPdfjs, PDFJS_DOC_ASSETS } from '../pdfjs';
import { makePageGeometry, type PageGeometry } from './page-geometry';
import {
  PRIORITY_BACKGROUND,
  PRIORITY_VISIBLE,
  RenderCancelledError,
  renderScheduler,
  type RenderScheduler,
  type ScheduledTask,
} from './render-scheduler';

export type { TextItem };

/* ── Pixel budget ─────────────────────────────────────────────────────────── */

/** Largest raster a render may produce on an ordinary device: about 8 megapixels. */
export const PIXEL_BUDGET_DEFAULT = 8_000_000;
/** Largest raster on a low-memory device: about 3 megapixels. */
export const PIXEL_BUDGET_LOW_MEMORY = 3_000_000;
/** `navigator.deviceMemory` (GiB) at or below which a device counts as low-memory. */
export const LOW_MEMORY_DEVICE_GB = 4;
/** No canvas side is ever asked to be longer than this, whatever the budget allows. */
export const MAX_CANVAS_EDGE_PX = 8192;
/** Thumbnails kept per document before the least recently used unwatched ones go. */
export const THUMB_CACHE_LIMIT = 300;

const PAGE_JPEG_QUALITY = 0.9;
const THUMB_JPEG_QUALITY = 0.8;

/** The parts of the environment `isLowMemoryDevice` reads; injectable for tests. */
export interface DeviceHints {
  /** `navigator.deviceMemory` in GiB. Chromium only; absent elsewhere. */
  deviceMemory?: number;
  /** True when the primary pointer is a finger (`matchMedia('(pointer: coarse)')`). */
  coarsePointer?: boolean;
}

function readDeviceHints(): DeviceHints {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
  let coarsePointer = false;
  try {
    coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    // No matchMedia (worker, old engine): treat as a desktop.
  }
  return { deviceMemory: nav?.deviceMemory, coarsePointer };
}

/**
 * Whether to use the small pixel budget.
 *
 * Where the browser reports its memory (Chromium, `navigator.deviceMemory`),
 * believe it: 4 GiB or less is low. Safari and Firefox report nothing, so fall
 * back to the primary pointer: a touch-first device is a phone or tablet, and
 * those are the engines with hard canvas memory ceilings (iOS Safari drops
 * canvases, or the whole tab, well before a desktop would notice).
 */
export function isLowMemoryDevice(hints: DeviceHints = readDeviceHints()): boolean {
  if (typeof hints.deviceMemory === 'number') return hints.deviceMemory <= LOW_MEMORY_DEVICE_GB;
  return hints.coarsePointer === true;
}

export function defaultPixelBudget(hints?: DeviceHints): number {
  return isLowMemoryDevice(hints) ? PIXEL_BUDGET_LOW_MEMORY : PIXEL_BUDGET_DEFAULT;
}

/**
 * The raster size for a page of `widthPt` × `heightPt` asked to be
 * `targetWidthPx` wide: the requested size if it fits, otherwise the largest
 * size of the same shape that stays within `pixelBudget` and `maxEdgePx`.
 * `scale` is raster pixels per displayed point (the pdf.js viewport scale).
 */
export function fitToPixelBudget(
  widthPt: number,
  heightPt: number,
  targetWidthPx: number,
  pixelBudget: number = PIXEL_BUDGET_DEFAULT,
  maxEdgePx: number = MAX_CANVAS_EDGE_PX,
): { widthPx: number; heightPx: number; scale: number } {
  let scale = (Number.isFinite(targetWidthPx) ? Math.max(targetWidthPx, 1) : 1) / widthPt;
  const area = widthPt * heightPt * scale * scale;
  if (area > pixelBudget) scale *= Math.sqrt(pixelBudget / area);
  const longest = Math.max(widthPt, heightPt) * scale;
  if (longest > maxEdgePx) scale *= maxEdgePx / longest;

  let widthPx = Math.max(1, Math.round(widthPt * scale));
  let heightPx = Math.max(1, Math.round(heightPt * scale));
  // Rounding up can step back over the budget by a row or a column.
  while (widthPx * heightPx > pixelBudget && (widthPx > 1 || heightPx > 1)) {
    if (widthPx >= heightPx) widthPx--;
    else heightPx--;
  }
  return { widthPx, heightPx, scale };
}

/* ── Errors ───────────────────────────────────────────────────────────────── */

/** The file is encrypted and no password, or the wrong one, was supplied. */
export class PdfPasswordError extends Error {
  /** `needed`: no password was given. `incorrect`: the one given was wrong. */
  readonly reason: 'needed' | 'incorrect';
  constructor(reason: 'needed' | 'incorrect', options?: { cause?: unknown }) {
    super(
      reason === 'incorrect'
        ? 'The password for this PDF is incorrect.'
        : 'This PDF is protected with a password.',
      options,
    );
    this.name = 'PdfPasswordError';
    this.reason = reason;
  }
}

/** The file could not be read as a PDF (damaged, truncated, or not a PDF at all). */
export class PdfParseError extends Error {
  constructor(message = 'This file could not be read as a PDF.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfParseError';
  }
}

/** The handle was closed or destroyed before, or while, the call ran. */
export class PdfClosedError extends Error {
  constructor() {
    super('The PDF document has been closed.');
    this.name = 'PdfClosedError';
  }
}

/** pdf.js `PasswordResponses`: 1 = a password is needed, 2 = the one given is wrong. */
const PDFJS_INCORRECT_PASSWORD = 2;

/** Map whatever pdf.js rejected with to one of the two typed open errors. */
export function toOpenError(err: unknown): PdfPasswordError | PdfParseError {
  if (err instanceof PdfPasswordError || err instanceof PdfParseError) return err;
  const e = err as { name?: string; code?: number; message?: string } | null;
  if (e?.name === 'PasswordException') {
    return new PdfPasswordError(e.code === PDFJS_INCORRECT_PASSWORD ? 'incorrect' : 'needed', { cause: err });
  }
  return new PdfParseError(undefined, { cause: err });
}

/* ── Public API ───────────────────────────────────────────────────────────── */

export interface OpenPdfOptions {
  /** Password for an encrypted file. Empty or missing means "none supplied". */
  password?: string;
}

export interface RenderPageOptions {
  /** Width the page will be shown at, in CSS pixels. */
  cssWidth: number;
  /** Device pixel ratio to render for. Defaults to `window.devicePixelRatio`. */
  dpr?: number;
  /** Cap on width × height of the raster. Defaults to `defaultPixelBudget()`. */
  pixelBudget?: number;
  /** Aborting it cancels the render; the promise rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Queue position. Defaults to `PRIORITY_VISIBLE`; use `PRIORITY_NEAR` to pre-render. */
  priority?: number;
  /**
   * `'png'` for a lossless raster — where the page is looked at for quality, so
   * the display adds no compression of its own. Defaults to `'jpeg'`.
   */
  format?: 'jpeg' | 'png';
  /** Also hand back the raster's pixels. They are copied, so keep such renders small. */
  pixels?: boolean;
}

export interface RenderedPage {
  /** `blob:` URL of a JPEG (or PNG), for `<img src>`. Owned by the handle. */
  url: string;
  /** Actual raster size; smaller than `cssWidth × dpr` when the budget applied. */
  widthPx: number;
  heightPx: number;
  /** With `pixels: true`: the raster itself, as drawn. */
  imageData?: ImageData;
}

export interface RequestThumbOptions {
  /** Queue position. Defaults to `PRIORITY_BACKGROUND`; pass `PRIORITY_VISIBLE` for on-screen items. */
  priority?: number;
}

export type ThumbListener = (url: string | undefined) => void;

export interface PdfDocHandle {
  /** Number of pages. Known as soon as `openPdf` resolves; nothing is rendered for it. */
  readonly pageCount: number;
  /** True once `destroy()` has been called. */
  readonly destroyed: boolean;

  /** How page `pageIndex` maps between what is displayed and the file. Cached. */
  geometry(pageIndex: number): Promise<PageGeometry>;

  /**
   * Render a page for display. The URL stays valid until `releasePage(url)` or
   * `destroy()`; a viewer that replaces a render (zoom, page change) should
   * release the old one. Rejects with an `AbortError` if `signal` fires, and
   * with `PdfClosedError` if the handle is closed first.
   */
  renderPage(pageIndex: number, options: RenderPageOptions): Promise<RenderedPage>;
  /** Revoke a URL returned by `renderPage` before `destroy()` would. */
  releasePage(url: string): void;

  /**
   * Ask for a thumbnail at least `longEdgePx` on its longer side (no device
   * pixel ratio is applied — ask for what you need). Idempotent: asking again
   * for the same or a smaller size does nothing; a larger size re-renders.
   * Returns a promise for convenience that NEVER rejects — it resolves with the
   * URL, or `undefined` if the render failed or the handle was closed — so it is
   * safe to ignore. Listen with `subscribeThumb`. (A page index outside the
   * document is a programming error and throws `RangeError`, here and in
   * `subscribeThumb`.)
   */
  requestThumb(pageIndex: number, longEdgePx: number, options?: RequestThumbOptions): Promise<string | undefined>;
  /**
   * Be told when page `pageIndex`'s thumbnail URL changes (it arrives, is
   * replaced by a larger one, or is evicted → `undefined`). Only this page's
   * listeners are called. A page with a listener is never evicted. Returns the
   * unsubscribe function.
   */
  subscribeThumb(pageIndex: number, listener: ThumbListener): () => void;
  /** The thumbnail `blob:` URL for the page if one has been rendered. */
  getThumb(pageIndex: number): string | undefined;

  /** The page's text runs (pdf.js `TextItem`s: `str`, `transform`, `width`, `height`…). */
  textContent(pageIndex: number): Promise<TextItem[]>;

  /**
   * Tear down the pdf.js document but keep every URL already handed out alive.
   * For a consumer that only needs rasters (no current caller does): the
   * file's bytes leave the worker as soon as rendering is done. Afterwards
   * `getThumb`/`subscribeThumb` still work; everything that needs the document
   * rejects with `PdfClosedError`. Resolves when pdf.js has finished.
   */
  closeDocument(): Promise<void>;

  /**
   * Cancel pending work, revoke every URL this handle created, and resolve once
   * pdf.js has torn the document down. Idempotent. Await it before reusing the
   * memory for something large; it is safe not to.
   */
  destroy(): Promise<void>;
}

/** Open a PDF. Rejects with `PdfPasswordError` or `PdfParseError`, nothing else. */
export async function openPdf(source: File | ArrayBuffer, opts: OpenPdfOptions = {}): Promise<PdfDocHandle> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const data =
      source instanceof ArrayBuffer
        ? new Uint8Array(source.slice(0))
        : new Uint8Array(await source.arrayBuffer());
    const lib = await getPdfjs();
    loadingTask = lib.getDocument({
      ...PDFJS_DOC_ASSETS,
      data,
      password: opts.password || undefined,
    });
    const doc = await loadingTask.promise;
    return new Handle(doc, loadingTask, renderScheduler);
  } catch (err) {
    await loadingTask?.destroy().catch(() => {});
    throw toOpenError(err);
  }
}

/* ── Scratch canvas ───────────────────────────────────────────────────────── */

let scratch: HTMLCanvasElement | null = null;

/** The one canvas every render draws on. Safe because the scheduler runs one render at a time. */
function acquireScratch(width: number, height: number): HTMLCanvasElement {
  scratch ??= document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  return scratch;
}

/** Give the backing store back straight away; a canvas left at page size holds megabytes. */
function releaseScratch(): void {
  if (!scratch) return;
  scratch.width = 0;
  scratch.height = 0;
}

/** How a raster is encoded for its URL. */
interface RasterEncoding {
  type: 'image/jpeg' | 'image/png';
  quality?: number;
  /** Called with the pixels before encoding, when wanted. */
  onPixels?: (pixels: ImageData) => void;
}

function canvasToBlob(canvas: HTMLCanvasElement, encoding: RasterEncoding): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The page could not be encoded.'))),
      encoding.type,
      encoding.quality,
    );
  });
}

/* ── Implementation ───────────────────────────────────────────────────────── */

interface ThumbEntry {
  url?: string;
  /** Long edge the current `url` was rendered for. */
  longEdgePx: number;
  pending?: { longEdgePx: number; task: ScheduledTask<string>; promise: Promise<string | undefined> };
  listeners: Set<ThumbListener>;
  lastUsed: number;
}

class Handle implements PdfDocHandle {
  readonly pageCount: number;
  destroyed = false;

  private closed = false;
  private closing: Promise<void> | null = null;
  private destroying: Promise<void> | null = null;
  private readonly pages = new Map<number, Promise<PDFPageProxy>>();
  private readonly geometries = new Map<number, Promise<PageGeometry>>();
  private readonly urls = new Set<string>();
  private readonly thumbs = new Map<number, ThumbEntry>();
  private readonly tasks = new Set<ScheduledTask<unknown>>();
  /** Renders that have really started and not yet let go of the canvas. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private clock = 0;

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly loadingTask: PDFDocumentLoadingTask,
    private readonly scheduler: RenderScheduler,
  ) {
    this.pageCount = doc.numPages;
  }

  private assertOpen(): void {
    if (this.closed) throw new PdfClosedError();
  }

  private assertPage(pageIndex: number): void {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new RangeError(`Page index ${pageIndex} is outside 0–${this.pageCount - 1}.`);
    }
  }

  private page(pageIndex: number): Promise<PDFPageProxy> {
    let page = this.pages.get(pageIndex);
    if (!page) {
      page = this.doc.getPage(pageIndex + 1);
      this.pages.set(pageIndex, page);
    }
    return page;
  }

  async geometry(pageIndex: number): Promise<PageGeometry> {
    this.assertPage(pageIndex);
    let geom = this.geometries.get(pageIndex);
    if (!geom) {
      this.assertOpen();
      geom = this.page(pageIndex).then((page) =>
        makePageGeometry({ view: page.view, rotate: page.rotate, userUnit: page.userUnit }),
      );
      this.geometries.set(pageIndex, geom);
      geom.catch(() => this.geometries.delete(pageIndex));
    }
    return geom;
  }

  /** Draw the page on the scratch canvas at the given size and encode it. */
  private async raster(
    pageIndex: number,
    size: { widthPx: number; heightPx: number; scale: number },
    encoding: RasterEncoding,
    signal: AbortSignal,
  ): Promise<string> {
    const page = await this.page(pageIndex);
    if (signal.aborted || this.closed) throw new RenderCancelledError();

    const viewport = page.getViewport({ scale: size.scale });
    const canvas = acquireScratch(size.widthPx, size.heightPx);
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser could not provide a canvas to render the page.');
      const renderTask = page.render({ canvasContext: ctx, canvas, viewport });
      const stop = () => renderTask.cancel();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await renderTask.promise;
      } finally {
        signal.removeEventListener('abort', stop);
      }
      if (signal.aborted || this.closed) throw new RenderCancelledError();

      if (encoding.onPixels) encoding.onPixels(ctx.getImageData(0, 0, size.widthPx, size.heightPx));
      const blob = await canvasToBlob(canvas, encoding);
      // Checked again after the encode: a URL created now would outlive destroy().
      if (signal.aborted || this.closed) throw new RenderCancelledError();
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      return url;
    } catch (err) {
      throw signal.aborted || this.closed ? new RenderCancelledError() : err;
    } finally {
      releaseScratch();
      // Drops the page's operator list and decoded images in the worker.
      page.cleanup();
    }
  }

  /** Queue a raster and remember it, so closing can cancel it and wait for the canvas. */
  private enqueue(
    run: (signal: AbortSignal) => Promise<string>,
    priority: number,
    signal?: AbortSignal,
  ): ScheduledTask<string> {
    const task = this.scheduler.schedule(
      (taskSignal) => {
        const work = run(taskSignal);
        this.inFlight.add(work);
        const done = () => this.inFlight.delete(work);
        work.then(done, done);
        return work;
      },
      { priority, signal },
    );
    this.tasks.add(task);
    const forget = () => this.tasks.delete(task);
    task.promise.then(forget, forget);
    return task;
  }

  async renderPage(pageIndex: number, options: RenderPageOptions): Promise<RenderedPage> {
    this.assertPage(pageIndex);
    this.assertOpen();
    const geom = await this.geometry(pageIndex);
    this.assertOpen();

    const dpr = options.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const size = fitToPixelBudget(
      geom.widthPt,
      geom.heightPt,
      options.cssWidth * dpr,
      options.pixelBudget ?? defaultPixelBudget(),
    );
    let imageData: ImageData | undefined;
    const encoding: RasterEncoding =
      options.format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: PAGE_JPEG_QUALITY };
    if (options.pixels) encoding.onPixels = (pixels) => (imageData = pixels);
    const task = this.enqueue(
      (signal) => this.raster(pageIndex, size, encoding, signal),
      options.priority ?? PRIORITY_VISIBLE,
      options.signal,
    );
    try {
      const url = await task.promise;
      return { url, widthPx: size.widthPx, heightPx: size.heightPx, imageData };
    } catch (err) {
      // "Closed" is the more useful answer than "cancelled" when both are true.
      if (this.closed && !options.signal?.aborted) throw new PdfClosedError();
      throw err;
    }
  }

  releasePage(url: string): void {
    if (!this.urls.delete(url)) return;
    URL.revokeObjectURL(url);
  }

  private thumbEntry(pageIndex: number): ThumbEntry {
    let entry = this.thumbs.get(pageIndex);
    if (!entry) {
      entry = { longEdgePx: 0, listeners: new Set(), lastUsed: ++this.clock };
      this.thumbs.set(pageIndex, entry);
    }
    return entry;
  }

  requestThumb(pageIndex: number, longEdgePx: number, options: RequestThumbOptions = {}): Promise<string | undefined> {
    this.assertPage(pageIndex);
    const entry = this.thumbEntry(pageIndex);
    entry.lastUsed = ++this.clock;
    if (this.closed) return Promise.resolve(entry.url);
    if (entry.url && entry.longEdgePx >= longEdgePx) return Promise.resolve(entry.url);

    const priority = options.priority ?? PRIORITY_BACKGROUND;
    if (entry.pending) {
      if (entry.pending.longEdgePx >= longEdgePx) {
        if (options.priority !== undefined) entry.pending.task.setPriority(options.priority);
        return entry.pending.promise;
      }
      entry.pending.task.cancel();
    }

    const task = this.enqueue(async (signal) => {
      const geom = await this.geometry(pageIndex);
      const scale = longEdgePx / Math.max(geom.widthPt, geom.heightPt);
      const size = fitToPixelBudget(geom.widthPt, geom.heightPt, geom.widthPt * scale);
      return this.raster(pageIndex, size, { type: 'image/jpeg', quality: THUMB_JPEG_QUALITY }, signal);
    }, priority);

    const promise = task.promise.then(
      (url) => {
        if (entry.pending?.task === task) entry.pending = undefined;
        const previous = entry.url;
        entry.url = url;
        entry.longEdgePx = longEdgePx;
        entry.lastUsed = ++this.clock;
        this.notify(entry);
        if (previous) this.releasePage(previous);
        this.evictThumbs();
        return url;
      },
      () => {
        if (entry.pending?.task === task) entry.pending = undefined;
        return undefined;
      },
    );
    entry.pending = { longEdgePx, task, promise };
    return promise;
  }

  private notify(entry: ThumbEntry): void {
    for (const listener of [...entry.listeners]) listener(entry.url);
  }

  /** Over the limit: drop the least recently used thumbnails nobody is listening to. */
  private evictThumbs(): void {
    let held = 0;
    for (const entry of this.thumbs.values()) if (entry.url) held++;
    if (held <= THUMB_CACHE_LIMIT) return;

    const idle = [...this.thumbs.values()]
      .filter((e) => e.url && e.listeners.size === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (held <= THUMB_CACHE_LIMIT) break;
      this.releasePage(entry.url!);
      entry.url = undefined;
      entry.longEdgePx = 0;
      held--;
    }
  }

  subscribeThumb(pageIndex: number, listener: ThumbListener): () => void {
    this.assertPage(pageIndex);
    const entry = this.thumbEntry(pageIndex);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  getThumb(pageIndex: number): string | undefined {
    const entry = this.thumbs.get(pageIndex);
    if (entry?.url) entry.lastUsed = ++this.clock;
    return entry?.url;
  }

  async textContent(pageIndex: number): Promise<TextItem[]> {
    this.assertPage(pageIndex);
    this.assertOpen();
    const page = await this.page(pageIndex);
    const content = await page.getTextContent();
    return content.items.filter((item): item is TextItem => 'str' in item);
  }

  closeDocument(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      for (const task of [...this.tasks]) task.cancel();
      this.closing = (async () => {
        // A cancelled render stops at its next await; wait for it to let go of
        // the canvas and the page before the document goes away under it.
        await Promise.allSettled([...this.inFlight]);
        this.pages.clear();
        // Teardown is best-effort: there is nothing a caller could do about a
        // failure here, and most callers do not await this.
        await this.loadingTask.destroy().catch(() => {});
      })();
    }
    return this.closing;
  }

  destroy(): Promise<void> {
    if (!this.destroying) {
      this.destroyed = true;
      const closing = this.closeDocument();
      for (const url of this.urls) URL.revokeObjectURL(url);
      this.urls.clear();
      for (const entry of this.thumbs.values()) {
        entry.url = undefined;
        entry.listeners.clear();
      }
      this.thumbs.clear();
      this.destroying = closing;
    }
    return this.destroying;
  }
}
