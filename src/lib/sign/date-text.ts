/**
 * The date stamp: what it says, how big its box is, and where pdf-lib has to
 * start drawing so the text lands inside that box.
 *
 * The date is drawn with the standard Helvetica font, which can only encode
 * WinAnsi (Latin) characters and whose glyph widths are fixed by the font's
 * metrics. So:
 *
 *   • the text is the visitor's own locale format when that is plain Latin, and
 *     ISO `YYYY-MM-DD` otherwise (Arabic, Persian, Thai… digits would make
 *     pdf-lib throw "WinAnsi cannot encode");
 *   • the preview box is sized from the same Helvetica widths pdf-lib uses,
 *     rather than from whatever font the browser substitutes, so the box on
 *     screen is the box in the file.
 *
 * Pure: no DOM, no pdf-lib. A unit test checks the width table against pdf-lib.
 */
import type { PdfDrawParams } from '../pdf/page-geometry';

/** Helvetica metrics, in thousandths of the font size. */
export const HELVETICA_ASCENT = 718;
export const HELVETICA_DESCENT = 207;
/** Height of the date box as a multiple of the font size (ascender to descender). */
export const DATE_BOX_HEIGHT_EM = (HELVETICA_ASCENT + HELVETICA_DESCENT) / 1000;

/**
 * Advance widths of Helvetica for the printable ASCII characters 32–126, in
 * thousandths of the font size (Adobe's AFM for the standard 14 fonts).
 */
// prettier-ignore
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //  !"#$%&'()*+,-./
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9:;<=>?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z[\]^_
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // `a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z{|}~
];

const FIRST_CHAR = 32;
const LAST_CHAR = 126;

/** True when every character is printable ASCII, which Helvetica can always draw. */
export function isPlainAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < FIRST_CHAR || code > LAST_CHAR) return false;
  }
  return true;
}

/** Width of `text` in Helvetica, as a multiple of the font size. ASCII only. */
export function helveticaWidthEm(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    total += code >= FIRST_CHAR && code <= LAST_CHAR ? HELVETICA_WIDTHS[code - FIRST_CHAR] : 556;
  }
  return total / 1000;
}

const pad = (n: number, length = 2) => String(n).padStart(length, '0');

/** `2026-03-09`: unambiguous everywhere and always drawable. */
export function isoDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The text of a date stamp: the date as the visitor's locale writes it when
 * that is plain ASCII, otherwise ISO. Never throws and never returns something
 * Helvetica cannot draw.
 */
export function dateStampText(date: Date = new Date(), locale?: string | string[]): string {
  let text = '';
  try {
    // Some locales pad with invisible direction marks or use a narrow no-break
    // space; neither is ASCII, so strip the marks and normalise the spaces.
    text = date
      .toLocaleDateString(locale)
      .replace(/[\u200e\u200f\u061c]/g, '')
      .replace(/[\u00a0\u202f\u2009]/g, ' ')
      .trim();
  } catch {
    // An unknown locale tag: fall through to ISO.
  }
  return text && isPlainAscii(text) ? text : isoDate(date);
}

/** Width ÷ height of the box that hugs `text` in Helvetica. */
export function dateBoxAspect(text: string): number {
  return helveticaWidthEm(text) / DATE_BOX_HEIGHT_EM;
}

/**
 * pdf-lib `drawText` parameters for a date box.
 *
 * `draw` is what `viewRectToPdfDraw` returned for the box: its lower-left
 * corner, its size and the counter-clockwise angle that keeps it upright on a
 * rotated page. Text is anchored on its baseline, which sits a descender's
 * depth above the bottom of the box — "above" in the box's own turned frame.
 */
export function dateTextDraw(draw: PdfDrawParams): { x: number; y: number; size: number; rotateDeg: number } {
  const size = draw.height / DATE_BOX_HEIGHT_EM;
  const lift = (HELVETICA_DESCENT / 1000) * size;
  const angle = (draw.rotateDeg * Math.PI) / 180;
  return {
    x: draw.x - Math.sin(angle) * lift,
    y: draw.y + Math.cos(angle) * lift,
    size,
    rotateDeg: draw.rotateDeg,
  };
}
