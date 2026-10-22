/**
 * The visible box of a digital signature: what it says, where it goes, and how
 * its text is laid out — shared by the on-screen preview and the file writer,
 * so the box the visitor places is the box the file gets.
 *
 * Pure: no pdf-lib, no DOM. Text widths are measured by the caller (pdf-lib's
 * Helvetica-Bold metrics when writing; the browser's Helvetica/Arial, which has
 * the same metrics, for the preview) and passed in at font size 1.
 */
import { viewRectToPdfRect, type PageGeometry, type PdfRect, type RectNorm } from './page-geometry';
import { clampRect } from '../workspace/overlay-math';

/** The displayed size of a page in points; `PageGeometry` satisfies it. */
export interface PageSize {
  widthPt: number;
  heightPt: number;
}

export const MM_PER_PT = 25.4 / 72;

/**
 * Where the box went before it could be placed: 250 × 60 pt, 20 pt in from the
 * bottom-right corner of page 1. It is still where a new box starts.
 */
export const DEFAULT_BOX = { widthPt: 250, heightPt: 60, marginPt: 20 } as const;

/** The smallest box, as a fraction of the page width / height. */
export const MIN_BOX_WIDTH = 0.08;

/** Colours of the box, as PDF rgb triples (0–1). */
export const BOX_FILL = [0.95, 0.97, 1] as const;
export const BOX_BORDER = [0.2, 0.4, 0.8] as const;
export const BOX_TEXT = [0.1, 0.2, 0.5] as const;
export const BOX_OPACITY = 0.9;

/** The design the text is scaled from: 7 pt type, 16 pt line pitch, 6 pt side padding in a 60 pt box. */
const BASE_HEIGHT = 60;
const BASE_FONT = 7;
const LINE_PITCH_EM = 16 / 7;
const PAD_X = 6;
/** Helvetica's cap height, in em: the top of the first line of text. */
const CAP_HEIGHT_EM = 0.718;

/** The date as the box prints it: the UTC calendar date, YYYY-MM-DD. */
export function boxDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The three lines the box shows. */
export function signatureBoxLines(signerName: string, date: Date): string[] {
  return [
    `Digitally signed by: ${toWinAnsi(signerName)}`,
    `Date: ${boxDate(date)}`,
    'Algorithm: RSA-SHA256 (PKCS#7)',
  ];
}

/** Characters WinAnsiEncoding has beyond Latin-1 (0x80–0x9F). */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/**
 * The box is drawn with the PDF standard font Helvetica, which can only show
 * WinAnsi characters. Anything else is replaced with "?" — in the preview too,
 * so what is shown is what is written.
 */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const ok = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch);
    out += ok ? ch : '?';
  }
  return out;
}

/** Where a new box goes on a page: the old fixed spot, kept on the page. */
export function defaultSignatureRect(page: PageSize): RectNorm {
  const { widthPt, heightPt, marginPt } = DEFAULT_BOX;
  const width = widthPt / page.widthPt;
  const height = heightPt / page.heightPt;
  return clampRect({
    x: 1 - width - marginPt / page.widthPt,
    y: 1 - height - marginPt / page.heightPt,
    width,
    height,
  });
}

/** The same physical box on another page: same size, same distance from the right and bottom edges. */
export function moveBoxToPage(rect: RectNorm, from: PageSize, to: PageSize): RectNorm {
  const width = (rect.width * from.widthPt) / to.widthPt;
  const height = (rect.height * from.heightPt) / to.heightPt;
  const rightPt = (1 - rect.x - rect.width) * from.widthPt;
  const bottomPt = (1 - rect.y - rect.height) * from.heightPt;
  return clampRect({
    x: 1 - width - rightPt / to.widthPt,
    y: 1 - height - bottomPt / to.heightPt,
    width,
    height,
  });
}

/** The box as the millimetre fields show it. */
export interface BoxMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxToMm(rect: RectNorm, page: PageSize): BoxMm {
  return {
    x: rect.x * page.widthPt * MM_PER_PT,
    y: rect.y * page.heightPt * MM_PER_PT,
    width: rect.width * page.widthPt * MM_PER_PT,
    height: rect.height * page.heightPt * MM_PER_PT,
  };
}

/**
 * Apply an edit from the millimetre fields. Width and height keep the top-left
 * corner; the box never gets smaller than the minimum or leaves the page.
 */
export function applyBoxMm(rect: RectNorm, page: PageSize, edit: Partial<BoxMm>): RectNorm {
  const next = { ...rect };
  const toX = (mm: number) => mm / MM_PER_PT / page.widthPt;
  const toY = (mm: number) => mm / MM_PER_PT / page.heightPt;
  const minHeight = (MIN_BOX_WIDTH * page.widthPt) / page.heightPt / 4;
  if (edit.width !== undefined && Number.isFinite(edit.width)) next.width = Math.min(1, Math.max(MIN_BOX_WIDTH, toX(edit.width)));
  if (edit.height !== undefined && Number.isFinite(edit.height)) next.height = Math.min(1, Math.max(minHeight, toY(edit.height)));
  if (edit.x !== undefined && Number.isFinite(edit.x)) next.x = toX(edit.x);
  if (edit.y !== undefined && Number.isFinite(edit.y)) next.y = toY(edit.y);
  return clampRect(next);
}

/** How the text sits in a box `width` × `height` (box units, y DOWN from the top). */
export interface BoxTextLayout {
  fontSize: number;
  x: number;
  /** Baseline of each line, measured down from the top of the box. */
  baselines: number[];
}

/**
 * Lay out `lineCount` lines in the box: the original design scaled with the
 * box's height, shrunk further if the longest line would not fit its width,
 * and centred vertically. `longestAt1` is the widest line's width at size 1.
 */
export function signatureTextLayout(width: number, height: number, longestAt1: number, lineCount = 3): BoxTextLayout {
  const scale = height / BASE_HEIGHT;
  const padX = Math.min(PAD_X * scale, width * 0.05);
  const byHeight = BASE_FONT * scale;
  const byWidth = longestAt1 > 0 ? (width - 2 * padX) / longestAt1 : byHeight;
  const fontSize = Math.max(0, Math.min(byHeight, byWidth));
  const pitch = fontSize * LINE_PITCH_EM;
  const block = pitch * (lineCount - 1) + fontSize * CAP_HEIGHT_EM;
  const top = (height - block) / 2;
  const baselines = Array.from({ length: lineCount }, (_, i) => top + fontSize * CAP_HEIGHT_EM + i * pitch);
  return { fontSize, x: padX, baselines };
}

/** Where the signature widget goes in the file, and how its appearance is turned to read upright. */
export interface WidgetPlacement {
  /** The widget's `/Rect`, in user space. */
  rect: PdfRect;
  /** The appearance's `/BBox` size: the box as the reader sees it, in user-space units. */
  width: number;
  height: number;
  /**
   * The appearance's `/Matrix`: turns the upright drawing by the page's
   * `/Rotate` (counter-clockwise in user space), so that once the viewer turns
   * the page clockwise for display the text reads upright.
   */
  matrix: [number, number, number, number, number, number];
}

export function signatureWidgetPlacement(geom: PageGeometry, rectNorm: RectNorm): WidgetPlacement {
  const rect = viewRectToPdfRect(geom, rectNorm);
  const width = (rectNorm.width * geom.widthPt) / geom.userUnit;
  const height = (rectNorm.height * geom.heightPt) / geom.userUnit;
  const COS = { 0: 1, 90: 0, 180: -1, 270: 0 } as const;
  const SIN = { 0: 0, 90: 1, 180: 0, 270: -1 } as const;
  const c = COS[geom.rotate];
  const s = SIN[geom.rotate];
  return { rect, width, height, matrix: [c, s, -s + 0, c, 0, 0] };
}
