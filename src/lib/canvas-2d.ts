/**
 * Canvas abstraction that works with or without `OffscreenCanvas`.
 *
 * Docukit renders and re-encodes pixels in several places (PDF page rasterising,
 * image compress/resize/convert, redaction flattening). `OffscreenCanvas` is the
 * right tool inside a Web Worker, but it is not universal: Safari only gained it
 * in 16.4, and some WebKit builds (including the one Playwright ships) omit it
 * entirely. Where we are on the main thread we can always fall back to a plain
 * `<canvas>`, so the only hard requirement is: *a worker* needs OffscreenCanvas.
 *
 * `supportsOffscreenCanvas` lets callers on the main thread decide up front
 * whether an operation may be handed to the worker pool or must run inline.
 */

/** Either canvas flavour; both expose a compatible 2D context. */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyCanvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** True when this realm (window or worker) can construct an OffscreenCanvas. */
export const supportsOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

/** True when this realm has a DOM to fall back on (i.e. we're not in a worker). */
const hasDom = typeof document !== 'undefined';

/**
 * Create a 2D drawing surface of the given size, preferring OffscreenCanvas and
 * falling back to a detached `<canvas>` on the main thread.
 *
 * @throws if neither is available (a worker on a build without OffscreenCanvas)
 *   — callers should have checked `supportsOffscreenCanvas` before dispatching.
 */
export function createCanvas2D(width: number, height: number): { canvas: AnyCanvas; ctx: AnyCanvas2D } {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));

  if (supportsOffscreenCanvas) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Could not get a 2D context from OffscreenCanvas');
    return { canvas, ctx };
  }

  if (hasDom) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context from <canvas>');
    return { canvas, ctx };
  }

  throw new Error('This browser has no OffscreenCanvas, so image work cannot run in a worker.');
}

/** Encode a canvas of either flavour to a Blob. */
export async function canvasToBlob(
  canvas: AnyCanvas,
  type = 'image/png',
  quality?: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob() produced no data'))),
      type,
      quality,
    );
  });
}
