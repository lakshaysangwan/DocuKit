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

/** An image as the layout needs it: its pixel size, upright, and the density its file states. */
export interface LayoutImage {
  width: number;
  height: number;
  /** Dots per inch stated by the file's metadata, if any. Only "Fit Image" uses it. */
  dpi?: number;
}

/**
 * "Fit Image" density when the file states none, or one that does not describe
 * a real size. 150 DPI is the usual floor for a print that does not look
 * pixelated, so a page made at it prints sharply at its own size; at 96 or 72
 * (screen pixels) every page would be half as large again or twice as large.
 */
export const FIT_DEFAULT_DPI = 150;

/**
 * Stated densities outside this range are ignored. Below 100 are the 72 and 96
 * that cameras, phones and screenshot tools write when they know nothing of a
 * physical size; above 1200 are film-scanner densities, where the true size
 * (a 36 mm slide) is too small to be a useful page.
 */
export const FIT_DPI_RANGE = [100, 1200] as const;

/**
 * The longest a "Fit Image" page's long edge may be: A3's 420 mm, the largest
 * sheet an office printer takes. A 12-megapixel photo at 150 DPI would be
 * 677 × 508 mm; capped it is 420 × 315 mm and still holds every pixel (about
 * 240 to the inch). PDF itself allows up to 200 inches.
 */
export const FIT_MAX_LONG_EDGE = 1190.55;

/** The density a "Fit Image" page is made at: the stated one when plausible, otherwise the default. */
export function fitDpi(img: LayoutImage): number {
  const stated = img.dpi;
  return stated !== undefined && stated >= FIT_DPI_RANGE[0] && stated <= FIT_DPI_RANGE[1] ? stated : FIT_DEFAULT_DPI;
}

/**
 * A "Fit Image" page: the image's own shape, its pixels at `fitDpi`, scaled
 * down as a whole when the long edge would pass `FIT_MAX_LONG_EDGE`. Only the
 * page's size in points is decided here: the image is embedded at full
 * resolution whatever size its page is.
 */
export function fitPageSize(img: LayoutImage): [number, number] {
  const dpi = fitDpi(img);
  const w = (img.width * 72) / dpi;
  const h = (img.height * 72) / dpi;
  if (Math.max(w, h) <= FIT_MAX_LONG_EDGE) return [w, h];
  return img.width >= img.height
    ? [FIT_MAX_LONG_EDGE, (FIT_MAX_LONG_EDGE * img.height) / img.width]
    : [(FIT_MAX_LONG_EDGE * img.width) / img.height, FIT_MAX_LONG_EDGE];
}

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
 * The page an image gets: its own shape for "fit" (see `fitPageSize`), otherwise the chosen sheet,
 * turned as `options.orientation` says. That defaults to `auto`: a landscape
 * image gets a landscape sheet, a portrait or square one a portrait sheet.
 */
export function pageSizeFor(img: LayoutImage, options: ImagesToPdfOptions): [number, number] {
  if (options.pageSize === 'fit') return fitPageSize(img);
  if (options.pageSize === 'custom' && options.customWidth && options.customHeight) {
    return [options.customWidth, options.customHeight];
  }
  const [width, height] = PAGE_SIZES[options.pageSize as StandardPageSize] ?? PAGE_SIZES.a4;
  return orientPage(width, height, img, options.orientation ?? 'auto');
}

const NO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The margins that are applied. A "Fit Image" page is exactly its image, so it
 * has none, whatever the (hidden) margin fields hold.
 */
export function marginsFor(options: ImagesToPdfOptions): Margins {
  return options.pageSize === 'fit' ? NO_MARGINS : options.margins;
}

/**
 * The page size and the rectangle the image is drawn into.
 *
 *   fit           the largest size that fits inside the margins, centred
 *                 ("center" is an older name for the same thing; the tool no
 *                 longer offers it separately)
 *   cover         the smallest size that covers the area inside the margins,
 *                 centred; it runs over the margins and is cut at the page edge
 *   stretch       exactly the area inside the margins, proportions not kept
 */
export function layoutImagePage(
  img: LayoutImage,
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
