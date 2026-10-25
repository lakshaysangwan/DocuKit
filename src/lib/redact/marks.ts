/**
 * Redaction marks: the arithmetic between what the visitor draws on the page
 * and the rectangles the redaction engine removes.
 *
 * A mark is stored the way it is shown — a `RectNorm`, fractions of the
 * DISPLAYED page with a top-left origin — and turned into a PDF user-space
 * rectangle by `page-geometry.ts` only when the file is written, so a mark on a
 * `/Rotate 90` scan, a page with an offset CropBox or a UserUnit page removes
 * exactly the area it covered on screen.
 *
 * Pure: no DOM, no pdf.js, no React.
 */
import {
  pdfPointToView,
  viewRectToPdfRect,
  type PageGeometry,
  type PdfRect,
  type RectNorm,
} from '../pdf/page-geometry';
import { clampRect } from '../workspace/overlay-math';

export { MIN_DRAWN_SIZE, rectFromPoints } from '../workspace/overlay-math';

export interface RedactMark {
  id: string;
  pageIndex: number;
  /** Where it is, as fractions of the displayed page. */
  rect: RectNorm;
}

/** What the redaction engine is given for one mark. */
export interface RedactJobMark {
  pageIndex: number;
  /** The area in PDF user space (lower-left origin, y up): what MuPDF removes. */
  pdf: PdfRect;
  /** The same area on the displayed page: used only by the raster fallback. */
  view: RectNorm;
}

/** "Add mark" drops a box this size (fractions of the page), centred. */
export const DEFAULT_MARK = { width: 0.4, height: 0.05 } as const;

/** Each further "Add mark" on the same page lands this much lower, so marks do not hide each other. */
export const DEFAULT_MARK_STEP = 0.07;

export const MM_PER_PT = 25.4 / 72;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The default box "Add mark" places: centred, the n-th one on a page a step lower. */
export function defaultMarkRect(existingOnPage: number): RectNorm {
  const y = 0.5 - DEFAULT_MARK.height / 2 + (existingOnPage % 6) * DEFAULT_MARK_STEP - 0.15;
  return clampRect({ x: 0.5 - DEFAULT_MARK.width / 2, y, width: DEFAULT_MARK.width, height: DEFAULT_MARK.height });
}

/** The parts of a pdf.js `TextItem` this module reads (to check the redacted file). */
export interface TextRun {
  str: string;
  /** Text-space → user-space matrix `[a, b, c, d, e, f]`; (e, f) is the baseline start. */
  transform: ArrayLike<number>;
  /** Advance along the baseline, in user-space units. */
  width: number;
  /** Font height in user-space units (0 when pdf.js could not tell). */
  height: number;
}

/** The centre of a text run on the displayed page (its box without padding). */
export function textRunViewCentre(geom: PageGeometry, run: TextRun): { x: number; y: number } {
  const [a, b, c, d, e, f] = Array.from(run.transform);
  const alongLen = Math.hypot(a, b) || 1;
  const upLen = Math.hypot(c, d) || 1;
  const height = run.height > 0 ? run.height : upLen;
  const s = run.width / 2;
  const t = height / 2;
  const [x, y] = pdfPointToView(geom, e + (s * a) / alongLen + (t * c) / upLen, f + (s * b) / alongLen + (t * d) / upLen);
  return { x, y };
}

/** True when the point lies inside the rectangle (edges included). */
export function rectContains(rect: RectNorm, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Case-insensitive "does this run contain the phrase". An empty phrase matches nothing. */
export function runMatches(str: string, phrase: string): boolean {
  const q = phrase.trim().toLowerCase();
  return q.length > 0 && str.toLowerCase().includes(q);
}

/** A user-space rectangle → the box it is on the displayed page (kept on the page). */
export function pdfRectToViewRect(geom: PageGeometry, rect: PdfRect): RectNorm {
  const [ax, ay] = pdfPointToView(geom, rect.x, rect.y);
  const [bx, by] = pdfPointToView(geom, rect.x + rect.width, rect.y + rect.height);
  const x1 = clamp01(Math.min(ax, bx));
  const y1 = clamp01(Math.min(ay, by));
  return { x: x1, y: y1, width: clamp01(Math.max(ax, bx)) - x1, height: clamp01(Math.max(ay, by)) - y1 };
}

/** A mark → what the engine removes, through the page's own geometry. */
export function markToJob(mark: RedactMark, geom: PageGeometry): RedactJobMark {
  return { pageIndex: mark.pageIndex, pdf: viewRectToPdfRect(geom, mark.rect), view: mark.rect };
}

/** A mark as the number fields show it: millimetres from the left and top edges of the displayed page. */
export interface MarkMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function markRectToMm(rect: RectNorm, page: { widthPt: number; heightPt: number }): MarkMm {
  return {
    x: rect.x * page.widthPt * MM_PER_PT,
    y: rect.y * page.heightPt * MM_PER_PT,
    width: rect.width * page.widthPt * MM_PER_PT,
    height: rect.height * page.heightPt * MM_PER_PT,
  };
}

/** Smallest side a typed size can make, in millimetres. */
export const MIN_MARK_MM = 1;

/**
 * Apply an edit from the number fields. Width and height are independent (a
 * mark has no shape of its own to keep); the mark stays on the page.
 */
export function applyMarkMm(
  rect: RectNorm,
  page: { widthPt: number; heightPt: number },
  edit: Partial<MarkMm>,
): RectNorm {
  const next = { ...rect };
  const toX = (mm: number) => mm / MM_PER_PT / page.widthPt;
  const toY = (mm: number) => mm / MM_PER_PT / page.heightPt;
  if (edit.width !== undefined && Number.isFinite(edit.width)) next.width = Math.min(1, toX(Math.max(MIN_MARK_MM, edit.width)));
  if (edit.height !== undefined && Number.isFinite(edit.height)) next.height = Math.min(1, toY(Math.max(MIN_MARK_MM, edit.height)));
  if (edit.x !== undefined && Number.isFinite(edit.x)) next.x = toX(edit.x);
  if (edit.y !== undefined && Number.isFinite(edit.y)) next.y = toY(edit.y);
  return clampRect(next);
}

/** How many marks each page has. */
export function marksPerPage(marks: readonly RedactMark[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const m of marks) counts.set(m.pageIndex, (counts.get(m.pageIndex) ?? 0) + 1);
  return counts;
}
