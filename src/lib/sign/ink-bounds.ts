/**
 * Find the part of a signature image that actually has ink in it, so the box on
 * the page hugs the strokes instead of the whole drawing pad.
 *
 * Pure: works on raw RGBA pixels (`ImageData.data`), so it runs in a unit test.
 */

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkOptions {
  /** A pixel counts as ink only if its alpha is above this (0–255). Default 8. */
  alphaMin?: number;
  /**
   * For an image with no transparency (a photo of a signature on paper): a
   * pixel whose red, green and blue are all at or above this is background.
   * Default 240. Ignored when the image has transparent pixels.
   */
  whiteMin?: number;
}

/** Whether any pixel is see-through. A drawn or typed signature is; a JPEG scan is not. */
export function hasTransparency(data: ArrayLike<number>, alphaMax = 250): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < alphaMax) return true;
  }
  return false;
}

/**
 * The smallest rectangle containing every ink pixel, or null when there is none
 * (a blank pad, or a plain white image).
 */
export function findInkBounds(
  data: ArrayLike<number>,
  width: number,
  height: number,
  options: InkOptions = {},
): PixelBounds | null {
  const alphaMin = options.alphaMin ?? 8;
  const whiteMin = options.whiteMin ?? 240;
  const opaque = !hasTransparency(data);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] <= alphaMin) continue;
      if (opaque && data[i] >= whiteMin && data[i + 1] >= whiteMin && data[i + 2] >= whiteMin) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Grow bounds by `padding` pixels on every side, without leaving the image. */
export function padBounds(bounds: PixelBounds, padding: number, width: number, height: number): PixelBounds {
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  const right = Math.min(width, bounds.x + bounds.width + padding);
  const bottom = Math.min(height, bounds.y + bounds.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}
