/**
 * The arithmetic behind a movable, resizable box on a page.
 *
 * Every rectangle here is a `RectNorm`: fractions 0–1 of the DISPLAYED page with
 * the origin at the top-left, exactly what `page-geometry.ts` maps into the PDF.
 * Deltas are fractions too (pointer pixels ÷ the page's pixel size), so nothing
 * in this file knows how large the page is on screen.
 *
 * Pure: no DOM, no React. `OverlayBox` calls these for pointer drags, the arrow
 * keys and the "Smaller" / "Larger" buttons, so all three behave identically.
 */
import type { RectNorm } from '../pdf/page-geometry';

export type Corner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';

export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

/** A box is never narrower than this fraction of the page width. */
export const MIN_BOX_WIDTH = 0.03;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Bring a rectangle wholly onto the page. A box larger than the page is scaled
 * down (keeping its shape) first, then moved inside.
 */
export function clampRect(rect: RectNorm): RectNorm {
  const fit = Math.min(1, 1 / rect.width, 1 / rect.height);
  const width = rect.width * fit;
  const height = rect.height * fit;
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  };
}

/** Slide a box by a delta, stopping at the page edges. Size is unchanged. */
export function moveRect(rect: RectNorm, dx: number, dy: number): RectNorm {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Put the centre of a box at a point of the page, stopping at the page edges. */
export function centreRectAt(rect: RectNorm, x: number, y: number): RectNorm {
  return clampRect({ ...rect, x: x - rect.width / 2, y: y - rect.height / 2 });
}

export interface ResizeOptions {
  /** Keep the box's shape (true for images and text). Defaults to true. */
  lockAspect?: boolean;
  /** Smallest width, as a fraction of the page width. Defaults to `MIN_BOX_WIDTH`. */
  minWidth?: number;
}

/**
 * Drag one corner by a delta. The opposite corner stays where it is, the box
 * stays on the page and never gets smaller than the minimum.
 *
 * With the aspect locked the box follows whichever axis the pointer has moved
 * further along, relative to the box's own size — so dragging mostly sideways
 * and dragging mostly downwards both feel like "pull the corner".
 */
export function resizeFromCorner(
  start: RectNorm,
  corner: Corner,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): RectNorm {
  const lockAspect = options.lockAspect ?? true;
  const minWidth = Math.min(options.minWidth ?? MIN_BOX_WIDTH, start.width);
  const minHeight = start.height * (minWidth / start.width);

  const right = corner === 'top-right' || corner === 'bottom-right';
  const bottom = corner === 'bottom-left' || corner === 'bottom-right';
  const anchorX = right ? start.x : start.x + start.width;
  const anchorY = bottom ? start.y : start.y + start.height;
  // How far the box may grow before it reaches the page edge on that side.
  const maxWidth = right ? 1 - anchorX : anchorX;
  const maxHeight = bottom ? 1 - anchorY : anchorY;

  let width = start.width + (right ? dx : -dx);
  let height = start.height + (bottom ? dy : -dy);

  if (lockAspect) {
    const largest = Math.min(maxWidth / start.width, maxHeight / start.height);
    const smallest = Math.min(minWidth / start.width, largest);
    const scale = clamp(Math.max(width / start.width, height / start.height), smallest, largest);
    width = start.width * scale;
    height = start.height * scale;
  } else {
    width = clamp(width, Math.min(minWidth, maxWidth), maxWidth);
    height = clamp(height, Math.min(minHeight, maxHeight), maxHeight);
  }

  return {
    x: right ? anchorX : anchorX - width,
    y: bottom ? anchorY : anchorY - height,
    width,
    height,
  };
}

/**
 * Grow or shrink a box about its centre by a factor (1.05 = 5% larger), keeping
 * its shape. Used by the `+` / `-` keys and the "Smaller" / "Larger" buttons.
 * The box is kept on the page: near an edge it grows away from the edge.
 */
export function scaleRect(rect: RectNorm, factor: number, options: ResizeOptions = {}): RectNorm {
  const minWidth = Math.min(options.minWidth ?? MIN_BOX_WIDTH, rect.width);
  const largest = Math.min(1 / rect.width, 1 / rect.height);
  const scale = clamp(factor, minWidth / rect.width, largest);
  const width = rect.width * scale;
  const height = rect.height * scale;
  return clampRect({
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  });
}

/** True when two rectangles differ by less than a thousandth of a page. */
export function sameRect(a: RectNorm, b: RectNorm, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon
  );
}
