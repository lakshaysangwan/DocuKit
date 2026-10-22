import type { PDFDocumentProxy } from 'pdfjs-dist';
// Relative imports: the unit test runs under Vitest, which has no "@/" alias.
import { encodeImageData, formatMime, type ImageFormat } from '../../../lib/image-codec';
import { isLowMemoryDevice } from '../../../lib/pdf/doc-handle';

/**
 * How PDF to Image turns a page into an image file — one function used both
 * for the files it hands over and for the enlarged preview, so the preview is
 * the exported image (same raster size, same pixels, same encoder and
 * quality) unless it had to be made smaller to fit in memory.
 */

/** A PDF point is 1/72 inch. */
export const POINTS_PER_INCH = 72;

/** The export DPI presets. */
export type ExportDpi = 72 | 150 | 300 | 600;

/** Keeps 1274.9999999 from losing a whole pixel to floating point. */
const EPSILON = 1e-6;

/** The most pixels an enlarged preview is rendered with; above it the preview is drawn at a lower DPI. */
export const PREVIEW_MAX_PIXELS = 12_000_000;
/** The same, on a phone or a device that reports 4 GB of memory or less. */
export const PREVIEW_MAX_PIXELS_LOW_MEMORY = 6_000_000;

export function previewPixelBudget(): number {
  return isLowMemoryDevice() ? PREVIEW_MAX_PIXELS_LOW_MEMORY : PREVIEW_MAX_PIXELS;
}

/** A page's displayed size in points (after /Rotate and UserUnit). */
export interface PageSizePt {
  widthPt: number;
  heightPt: number;
}

/** The pixel size of the image a page becomes at `dpi`. */
export function exportPixelSize({ widthPt, heightPt }: PageSizePt, dpi: number): { width: number; height: number } {
  const scale = dpi / POINTS_PER_INCH;
  return {
    width: Math.max(1, Math.floor(widthPt * scale + EPSILON)),
    height: Math.max(1, Math.floor(heightPt * scale + EPSILON)),
  };
}

/**
 * The DPI the preview is drawn at: `dpi` itself when the image fits in
 * `maxPixels`, otherwise the highest whole DPI that does.
 */
export function previewDpi(size: PageSizePt, dpi: number, maxPixels: number): number {
  const full = exportPixelSize(size, dpi);
  if (full.width * full.height <= maxPixels) return dpi;
  let d = Math.max(1, Math.floor(dpi * Math.sqrt(maxPixels / (full.width * full.height))));
  while (d > 1) {
    const s = exportPixelSize(size, d);
    if (s.width * s.height <= maxPixels) break;
    d--;
  }
  return d;
}

/**
 * The file size of the full image, from a preview drawn smaller: the preview's
 * bytes scaled by the pixel count. Exact when the preview is the full image.
 */
export function estimateBytes(previewBytes: number, previewPixels: number, exportPixels: number): number {
  if (previewPixels <= 0) return previewBytes;
  return Math.round(previewBytes * (exportPixels / previewPixels));
}

export interface ExportedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Render page `pageIndex` of `doc` at `dpi` and encode it as `format`
 * (`quality` 1–100, ignored for PNG). `size` is the page's displayed size in
 * points, so the raster's size is `exportPixelSize(size, dpi)` exactly.
 */
export async function renderAsExported(
  doc: PDFDocumentProxy,
  pageIndex: number,
  size: PageSizePt,
  dpi: number,
  format: ImageFormat,
  quality: number,
  signal?: AbortSignal,
): Promise<ExportedImage> {
  const page = await doc.getPage(pageIndex + 1);
  try {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const { width, height } = exportPixelSize(size, dpi);
    const viewport = page.getViewport({ scale: dpi / POINTS_PER_INCH });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not provide a canvas to draw the page.');
    const task = page.render({ canvasContext: ctx, canvas, viewport });
    const stop = () => task.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await task.promise;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const data = ctx.getImageData(0, 0, width, height);
    // Let the browser drop the canvas memory before the encoder takes its own.
    canvas.width = 0;
    canvas.height = 0;
    // Encoded with jSquash, so AVIF (and better JPEG/WebP) work in every browser.
    const encoded = await encodeImageData(data, format, quality);
    return { blob: new Blob([encoded], { type: formatMime(format) }), width, height };
  } finally {
    page.cleanup();
  }
}
