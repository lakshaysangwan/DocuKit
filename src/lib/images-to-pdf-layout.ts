/**
 * Where an image goes on its PDF page — the one piece of geometry Image to PDF
 * has. The worker that writes the file and the preview that shows it both call
 * `layoutImagePage`, so what is on screen is what is written: there is no
 * second copy of this arithmetic to drift.
 *
 * Everything is in PDF points (72 to the inch) with the origin at the page's
 * bottom-left corner, as pdf-lib draws.
 *
 * The numbers this produces are pinned to the pre-extraction behaviour by
 * images-to-pdf-layout.test.ts.
 */
import type { ImagesToPdfOptions } from '../types/worker-messages';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ImagePageLayout {
  pageW: number;
  pageH: number;
  /** Where the image is drawn. It may extend past the page; the page clips it. */
  draw: Rect;
  /** The area inside the margins that the image was fitted to. */
  box: Rect;
}

/** The fixed page sizes, portrait, as [width, height] in points. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
} as const satisfies Record<string, readonly [number, number]>;

export type StandardPageSize = keyof typeof PAGE_SIZES;

export const PAGE_SIZE_LABEL: Record<StandardPageSize, string> = {
  a4: 'A4',
  letter: 'Letter',
  legal: 'Legal',
};

export type PageOrientation = 'portrait' | 'landscape' | 'auto';

/**
 * Turn a portrait page for the given orientation. `auto` follows the image:
 * landscape for an image wider than it is tall.
 */
export function orientPage(
  width: number,
  height: number,
  img: { width: number; height: number },
  orientation: PageOrientation,
): [number, number] {
  const landscape = orientation === 'landscape' || (orientation === 'auto' && img.width > img.height);
  return landscape ? [height, width] : [width, height];
}

/**
 * OPEN DECISION (owner's): there is no Orientation option yet, so every
 * fixed-size page is portrait whatever the image's shape. To add the option,
 * replace this constant with the chosen value in `pageSizeFor` — nothing else
 * in the layout needs to change.
 */
const ORIENTATION: PageOrientation = 'portrait';

/** The page an image gets: its own size for "fit", otherwise the chosen sheet. */
export function pageSizeFor(img: { width: number; height: number }, options: ImagesToPdfOptions): [number, number] {
  if (options.pageSize === 'fit') return [img.width, img.height];
  if (options.pageSize === 'custom' && options.customWidth && options.customHeight) {
    return [options.customWidth, options.customHeight];
  }
  const [width, height] = PAGE_SIZES[options.pageSize as StandardPageSize] ?? PAGE_SIZES.a4;
  return orientPage(width, height, img, ORIENTATION);
}

/**
 * The margins that are applied.
 *
 * OPEN DECISION (owner's): "Fit Image" pages keep the margins too, although the
 * tool hides the margin fields for that page size. To make "Fit Image" pages
 * edge to edge, return zero margins here when `options.pageSize === 'fit'`.
 */
export function marginsFor(options: ImagesToPdfOptions): Margins {
  return options.margins;
}

/**
 * The page size and the rectangle the image is drawn into.
 *
 *   center, fit   the largest size that fits inside the margins, centred
 *                 (the two are the same today — an open decision)
 *   cover         the smallest size that covers the area inside the margins,
 *                 centred; it runs over the margins and is cut at the page edge
 *   stretch       exactly the area inside the margins, proportions not kept
 */
export function layoutImagePage(
  img: { width: number; height: number },
  options: ImagesToPdfOptions,
): ImagePageLayout {
  const imgW = img.width;
  const imgH = img.height;
  const [pageW, pageH] = pageSizeFor(img, options);

  const { top, right, bottom, left } = marginsFor(options);
  const availW = pageW - left - right;
  const availH = pageH - top - bottom;
  const box: Rect = { x: left, y: bottom, w: availW, h: availH };

  if (options.placement === 'stretch') {
    return { pageW, pageH, draw: { ...box }, box };
  }

  const scale =
    options.placement === 'cover'
      ? Math.max(availW / imgW, availH / imgH)
      : Math.min(availW / imgW, availH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return {
    pageW,
    pageH,
    draw: { x: left + (availW - w) / 2, y: bottom + (availH - h) / 2, w, h },
    box,
  };
}

/** Whether the margins leave any room at all for an image on this page. */
export function hasRoomForImage(layout: ImagePageLayout): boolean {
  return layout.box.w > 0 && layout.box.h > 0;
}

const MM_PER_POINT = 25.4 / 72;

/** A length in points as whole millimetres. */
export function pointsToMm(points: number): number {
  return Math.round(points * MM_PER_POINT);
}

/** "210 × 297 mm" for a page given in points. */
export function formatPageMm(pageW: number, pageH: number): string {
  return `${pointsToMm(pageW)} × ${pointsToMm(pageH)} mm`;
}

/** "210 × 297 mm" for one of the fixed page sizes. */
export function standardPageMm(size: StandardPageSize): string {
  const [width, height] = PAGE_SIZES[size];
  return formatPageMm(width, height);
}
