/**
 * Page number layout: which number a page gets and exactly where it goes.
 *
 * One function, used by both sides: the preview draws this text in this box
 * over the page image, and the worker writes this text in this box into the
 * file through `page-geometry.ts`. So the number on screen is the number in the
 * file, on a `/Rotate`d scan and on a page whose crop box does not start at
 * 0,0 as on a plain page.
 *
 * Everything is measured on the DISPLAYED page (after `/Rotate`, times
 * UserUnit), so "bottom centre" is the bottom of the page as the visitor sees
 * it and the number reads upright there. The box is the line of text as the
 * standard font sets it: as wide as the font's advance widths add up to, from
 * its descender to its ascender. It comes back as a `RectNorm` (fractions of
 * the displayed page, top-left origin, y down) — the input `viewRectToPdfDraw`
 * takes.
 *
 * Placement (unchanged from the tool's first version, for an upright page that
 * starts at 0,0):
 *   left / right   the text starts `marginX` from the left edge, or ends
 *                  `marginX` from the right edge; centre ignores `marginX`.
 *   bottom         the baseline is `marginY` above the bottom edge.
 *   top            the baseline is `marginY` + the font size below the top edge.
 *
 * Numbering (also unchanged): the first `skipFirstN` pages get no number; the
 * next page gets `startNumber` and each page after it one more. "of N" counts
 * the pages that carry a number (all pages minus the skipped ones).
 *
 * Pure: no DOM, no pdf-lib.
 */
import type { RectNorm } from './pdf/page-geometry';
import { fontExtentEm, textWidthEm, STANDARD_FONT_CSS } from './standard-fonts';

export type PageNumberPosition = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right';
export type PageNumberFormat = 'n' | 'page-n' | 'page-n-of-total' | 'n-of-total' | 'roman' | 'alpha';
export type PageNumberFont = 'Helvetica' | 'Times-Roman' | 'Courier';

export interface PageNumberLayoutOptions {
  position: PageNumberPosition;
  format: PageNumberFormat;
  /** The number the first numbered page gets (at least 1). */
  startNumber: number;
  /** How many pages at the start get no number. */
  skipFirstN: number;
  font: PageNumberFont;
  /** Points. */
  fontSize: number;
  /** Distance from the left or right edge, in millimetres. */
  marginX: number;
  /** Distance from the top or bottom edge, in millimetres. */
  marginY: number;
}

export interface PageNumberPlacement {
  /** What is written on the page. */
  text: string;
  /** The line of text's box on the displayed page. */
  rect: RectNorm;
  /** The box's size in displayed points. */
  boxWidthPt: number;
  boxHeightPt: number;
  /** How far the baseline sits above the bottom of the box, in points. */
  baselinePt: number;
}

export const PAGE_NUMBER_POSITIONS: readonly PageNumberPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export const PAGE_NUMBER_FONTS: readonly { value: PageNumberFont; label: string; css: string }[] = [
  { value: 'Helvetica', label: 'Helvetica (sans-serif)', css: STANDARD_FONT_CSS.helvetica },
  { value: 'Times-Roman', label: 'Times (serif)', css: STANDARD_FONT_CSS.times },
  { value: 'Courier', label: 'Courier (monospace)', css: STANDARD_FONT_CSS.courier },
];

export const DEFAULT_PAGE_NUMBER_OPTIONS: PageNumberLayoutOptions = {
  position: 'bottom-center',
  format: 'page-n-of-total',
  startNumber: 1,
  skipFirstN: 0,
  font: 'Helvetica',
  fontSize: 10,
  marginX: 20,
  marginY: 15,
};

export const MM_TO_PT = 72 / 25.4;

function roman(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['m', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i'];
  let out = '';
  let v = num;
  for (let i = 0; i < vals.length; i++) {
    while (v >= vals[i]) {
      out += syms[i];
      v -= vals[i];
    }
  }
  return out;
}

function alpha(num: number): string {
  let out = '';
  let v = num;
  while (v > 0) {
    v--;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

const whole = (v: number, min: number) => (Number.isFinite(v) ? Math.max(min, Math.floor(v)) : min);

/** How many pages carry a number. */
export function numberedPageCount(pageCount: number, options: Pick<PageNumberLayoutOptions, 'skipFirstN'>): number {
  return Math.max(0, pageCount - whole(options.skipFirstN, 0));
}

/** The text page `pageIndex` (zero-based) of `pageCount` carries, or null when it carries none. */
export function pageNumberText(
  pageIndex: number,
  pageCount: number,
  options: Pick<PageNumberLayoutOptions, 'format' | 'startNumber' | 'skipFirstN'>,
): string | null {
  const skip = whole(options.skipFirstN, 0);
  if (pageIndex < skip || pageIndex >= pageCount) return null;
  const num = pageIndex - skip + whole(options.startNumber, 1);
  const total = pageCount - skip;
  switch (options.format) {
    case 'page-n':
      return `Page ${num}`;
    case 'page-n-of-total':
      return `Page ${num} of ${total}`;
    case 'n-of-total':
      return `${num}/${total}`;
    case 'roman':
      return roman(num);
    case 'alpha':
      return alpha(num);
    default:
      return String(num);
  }
}

/**
 * The number on page `pageIndex` of `pageCount`, on a page displayed
 * `widthPt` × `heightPt`: its text and its box. Null when the page carries no
 * number.
 */
export function layoutPageNumber(
  page: { widthPt: number; heightPt: number },
  pageIndex: number,
  pageCount: number,
  options: PageNumberLayoutOptions,
): PageNumberPlacement | null {
  const W = page.widthPt;
  const H = page.heightPt;
  if (!(W > 0) || !(H > 0)) return null;
  const text = pageNumberText(pageIndex, pageCount, options);
  if (!text) return null;
  const size = options.fontSize;
  if (!(size > 0)) return null;
  const width = textWidthEm(options.font, text) * size;
  const { ascent, descent } = fontExtentEm(options.font);
  const height = (ascent - descent) * size;
  const mx = Math.max(0, options.marginX) * MM_TO_PT;
  const my = Math.max(0, options.marginY) * MM_TO_PT;

  const [row, col] = options.position.split('-');
  const left = col === 'left' ? mx : col === 'right' ? W - mx - width : W / 2 - width / 2;
  // Baseline, measured down from the top of the displayed page.
  const baseline = row === 'top' ? my + size : H - my;
  const top = baseline - ascent * size;
  return {
    text,
    rect: { x: left / W, y: top / H, width: width / W, height: height / H },
    boxWidthPt: width,
    boxHeightPt: height,
    baselinePt: -descent * size,
  };
}
