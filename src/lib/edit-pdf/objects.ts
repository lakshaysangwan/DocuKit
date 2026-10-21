/**
 * Edit PDF: what a visitor can add to a page, and the arithmetic of its size.
 *
 * Every object has a box — a `RectNorm`, fractions of the DISPLAYED page with
 * the origin at the top-left — exactly what `OverlayBox` moves and resizes and
 * what `page-geometry.ts` maps into the PDF. What is inside the box is
 * described in the box's own frame: a line runs between two of its edges, a
 * freehand stroke's points are fractions of it, text hugs it. So the box on
 * screen and the box in the file are one rectangle, and resizing an object is
 * only ever a change of that rectangle (plus, for text, its font size).
 *
 * Pure: no DOM, no pdf-lib. Sizes in points are DISPLAYED points (after
 * `/Rotate`, times UserUnit), the units `PageGeometry.widthPt` is in.
 */
import type { RectNorm } from '../pdf/page-geometry';
import { clampRect, resizeFromCorner, scaleRect, type Corner } from '../workspace/overlay-math';
import { HELVETICA_ASCENT, HELVETICA_DESCENT, helveticaWidthEm, isPlainAscii } from '../sign/date-text';
import { MM_PER_PT, type PageSize } from '../sign/placement';

export { MM_PER_PT, type PageSize };

export type EditKind =
  | 'text'
  | 'image'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'highlight'
  | 'whiteout'
  | 'stamp';

export type StampLabel = 'APPROVED' | 'DRAFT' | 'CONFIDENTIAL' | 'COPY' | 'VOID';
export const STAMP_LABELS: readonly StampLabel[] = ['APPROVED', 'DRAFT', 'CONFIDENTIAL', 'COPY', 'VOID'];
export const STAMP_COLOURS: Record<StampLabel, string> = {
  APPROVED: '#16A34A',
  DRAFT: '#CA8A04',
  CONFIDENTIAL: '#DC2626',
  COPY: '#64748B',
  VOID: '#DC2626',
};

/** Which way a line or arrow runs across its box. */
export type Direction = 'right' | 'left' | 'down' | 'up' | 'down-right' | 'up-right' | 'down-left' | 'up-left';

/** Start and end of a line as fractions of its box (x right, y down). */
export const DIRECTION_ENDS: Record<Direction, readonly [number, number, number, number]> = {
  right: [0, 0.5, 1, 0.5],
  left: [1, 0.5, 0, 0.5],
  down: [0.5, 0, 0.5, 1],
  up: [0.5, 1, 0.5, 0],
  'down-right': [0, 0, 1, 1],
  'up-right': [0, 1, 1, 0],
  'down-left': [1, 0, 0, 1],
  'up-left': [1, 1, 0, 0],
};

interface Base {
  id: string;
  pageIndex: number;
  /** The box, as fractions of the displayed page. */
  rect: RectNorm;
  /** 0.1–1. */
  opacity: number;
  /** Resizing keeps the shape. Always true for text. */
  lockAspect: boolean;
}

export interface TextObject extends Base {
  kind: 'text';
  text: string;
  /** In displayed points. The box is worked out from it, never the other way round. */
  fontSize: number;
  color: string;
}
export interface ImageObject extends Base {
  kind: 'image';
  /** A data: URL of a JPEG or PNG, upright — embedded as it is. */
  src: string;
  mime: 'image/jpeg' | 'image/png';
}
export interface ShapeObject extends Base {
  kind: 'rect' | 'ellipse';
  color: string;
  strokeWidth: number;
}
export interface LineObject extends Base {
  kind: 'line' | 'arrow';
  color: string;
  strokeWidth: number;
  direction: Direction;
}
export interface DrawObject extends Base {
  kind: 'draw';
  color: string;
  strokeWidth: number;
  /** The stroke, as fractions of the box. */
  points: [number, number][];
}
export interface HighlightObject extends Base {
  kind: 'highlight';
  color: string;
}
export interface WhiteoutObject extends Base {
  kind: 'whiteout';
}
export interface StampObject extends Base {
  kind: 'stamp';
  label: StampLabel;
  color: string;
}

export type EditObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | LineObject
  | DrawObject
  | HighlightObject
  | WhiteoutObject
  | StampObject;

export const KIND_LABEL: Record<EditKind, string> = {
  text: 'Text',
  image: 'Image',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  draw: 'Drawing',
  highlight: 'Highlight',
  whiteout: 'Whiteout',
  stamp: 'Stamp',
};

/** Shapes resize freely; pictures, stamps and text keep their proportions. */
export const LOCKED_BY_DEFAULT: Record<EditKind, boolean> = {
  text: true,
  image: true,
  stamp: true,
  rect: false,
  ellipse: false,
  line: false,
  arrow: false,
  draw: false,
  highlight: false,
  whiteout: false,
};

export const DEFAULT_COLOUR = '#1E293B';
export const HIGHLIGHT_COLOUR = '#FACC15';
/** A highlight is always see-through, so the text under it stays readable. */
export const HIGHLIGHT_ALPHA = 0.3;

/* ── Text ──────────────────────────────────────────────────────────────── */

export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 144;
/** Line height as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return MIN_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/** Measures a line of text in ems. The default knows Helvetica's widths, which is what the file uses. */
export type MeasureEm = (line: string) => number;

export const measureHelvetica: MeasureEm = (line) => helveticaWidthEm(line);

/** True when the text can be written as real Helvetica text; otherwise it is drawn as a picture. */
export function isVectorText(text: string): boolean {
  return text.split('\n').every(isPlainAscii);
}

/** Distance from the top of the box to the baseline of line `i`, as a multiple of the font size. */
export function baselineEm(i: number): number {
  // Each line is centred in its LINE_HEIGHT slot, ascender to descender.
  return (i + 0.5) * LINE_HEIGHT + (HELVETICA_ASCENT - HELVETICA_DESCENT) / 2000;
}

/** Size of the box that hugs some text, in points. An empty line still takes its height. */
export function textSizePt(text: string, fontSize: number, measure: MeasureEm = measureHelvetica): { width: number; height: number } {
  const lines = text.split('\n');
  const widest = Math.max(...lines.map((l) => measure(l)));
  return {
    // Never zero wide, so an empty text box can still be found and picked up.
    width: Math.max(widest, 0.5) * fontSize,
    height: lines.length * LINE_HEIGHT * fontSize,
  };
}

/**
 * The text box with its size worked out from the text and font size, its
 * top-left corner where it was. If it would not fit on the page the font is made
 * smaller until it does; then it is moved onto the page.
 */
export function fitText(obj: TextObject, page: PageSize, measure: MeasureEm = measureHelvetica): TextObject {
  let fontSize = clampFontSize(obj.fontSize);
  let size = textSizePt(obj.text, fontSize, measure);
  const tooBig = Math.max(size.width / page.widthPt, size.height / page.heightPt);
  if (tooBig > 1) {
    fontSize = fontSize / tooBig;
    size = textSizePt(obj.text, fontSize, measure);
  }
  const rect = clampRect({
    x: obj.rect.x,
    y: obj.rect.y,
    width: size.width / page.widthPt,
    height: size.height / page.heightPt,
  });
  return { ...obj, fontSize, rect };
}

/* ── Changing an object's box ──────────────────────────────────────────── */

/**
 * Give an object a new box. Text takes it as a new font size (the box is
 * worked out again from the text, so it always hugs it); everything else just
 * takes the box. `base` is the object as it was before the change began — for
 * a drag, the object when the drag started.
 */
export function withRect(
  base: EditObject,
  rect: RectNorm,
  page: PageSize,
  measure: MeasureEm = measureHelvetica,
): EditObject {
  if (base.kind !== 'text') return { ...base, rect };
  const scale = base.rect.width > 0 ? rect.width / base.rect.width : 1;
  if (Math.abs(scale - 1) < 1e-9) return { ...base, rect: { ...base.rect, x: rect.x, y: rect.y } };
  return fitText({ ...base, fontSize: base.fontSize * scale, rect }, page, measure);
}

/** "Smaller" and "Larger": about the centre, keeping the shape. */
export function scaleObject(obj: EditObject, factor: number, page: PageSize, measure: MeasureEm = measureHelvetica): EditObject {
  if (obj.kind === 'text') {
    const resized = fitText({ ...obj, fontSize: clampFontSize(obj.fontSize * factor) }, page, measure);
    // Keep the centre where it was.
    const cx = obj.rect.x + obj.rect.width / 2;
    const cy = obj.rect.y + obj.rect.height / 2;
    return {
      ...resized,
      rect: clampRect({ ...resized.rect, x: cx - resized.rect.width / 2, y: cy - resized.rect.height / 2 }),
    };
  }
  return { ...obj, rect: scaleRect(obj.rect, factor, { minWidth: MIN_OBJECT_WIDTH }) };
}

/** A new font size for a text box, keeping its top-left corner. */
export function withFontSize(obj: TextObject, fontSize: number, page: PageSize, measure: MeasureEm = measureHelvetica): TextObject {
  return fitText({ ...obj, fontSize: clampFontSize(fontSize) }, page, measure);
}

/** Lines and strokes can be thin; nothing is narrower than this fraction of the page. */
export const MIN_OBJECT_WIDTH = 0.01;

/** Drag a corner (used by tests and by the keyboard; `OverlayBox` does the same itself). */
export function dragCorner(obj: EditObject, corner: Corner, dx: number, dy: number, page: PageSize): EditObject {
  const rect = resizeFromCorner(obj.rect, corner, dx, dy, { lockAspect: obj.lockAspect || obj.kind === 'text', minWidth: MIN_OBJECT_WIDTH });
  return withRect(obj, rect, page);
}

/* ── Millimetre fields ─────────────────────────────────────────────────── */

export interface BoxMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectToBoxMm(rect: RectNorm, page: PageSize): BoxMm {
  return {
    x: rect.x * page.widthPt * MM_PER_PT,
    y: rect.y * page.heightPt * MM_PER_PT,
    width: rect.width * page.widthPt * MM_PER_PT,
    height: rect.height * page.heightPt * MM_PER_PT,
  };
}

/** Smallest width or height a field accepts, in millimetres. */
export const MIN_SIZE_MM = 1;

/**
 * Apply a typed value. A new width or height keeps the top-left corner; with
 * the shape locked the other side follows. X and Y move the top-left corner.
 * Everything stays on the page.
 */
export function applyBoxMm(obj: EditObject, edit: Partial<BoxMm>, page: PageSize, measure: MeasureEm = measureHelvetica): EditObject {
  const toW = (mm: number) => Math.max(MIN_SIZE_MM, mm) / MM_PER_PT / page.widthPt;
  const toH = (mm: number) => Math.max(MIN_SIZE_MM, mm) / MM_PER_PT / page.heightPt;
  const lock = obj.lockAspect || obj.kind === 'text';
  let rect = { ...obj.rect };

  if (edit.width !== undefined && Number.isFinite(edit.width)) {
    const width = Math.min(1, toW(edit.width));
    const height = lock ? obj.rect.height * (width / obj.rect.width) : obj.rect.height;
    rect = { ...rect, width, height };
  }
  if (edit.height !== undefined && Number.isFinite(edit.height)) {
    const height = Math.min(1, toH(edit.height));
    const width = lock ? rect.width * (height / rect.height) : rect.width;
    rect = { ...rect, width, height };
  }
  // A locked shape that no longer fits is scaled down as a whole.
  if (rect.width > 1 || rect.height > 1) {
    const fit = Math.min(1 / rect.width, 1 / rect.height);
    rect = { ...rect, width: rect.width * fit, height: rect.height * fit };
  }
  if (edit.x !== undefined && Number.isFinite(edit.x)) rect.x = edit.x / MM_PER_PT / page.widthPt;
  if (edit.y !== undefined && Number.isFinite(edit.y)) rect.y = edit.y / MM_PER_PT / page.heightPt;

  const next = withRect(obj, rect, page, measure);
  return { ...next, rect: clampRect(next.rect) };
}

/* ── New objects ───────────────────────────────────────────────────────── */

/** A font size that reads as body text on this page: 16 pt on A4, more on a poster. */
export function defaultFontSize(page: PageSize): number {
  return Math.round(clampFontSize(Math.min(page.widthPt, page.heightPt) / 37));
}

/** Each further object of a kind on a page is offset by this much, so they do not hide each other. */
const STAGGER = 0.03;
const STAGGER_CYCLE = 5;

/** A box `widthPt` × `heightPt` centred near the middle of the page. */
function centred(page: PageSize, widthPt: number, heightPt: number, alreadyThere: number): RectNorm {
  let width = widthPt / page.widthPt;
  let height = heightPt / page.heightPt;
  const fit = Math.min(1, 0.9 / width, 0.9 / height);
  width *= fit;
  height *= fit;
  const shift = (alreadyThere % STAGGER_CYCLE) * STAGGER;
  return clampRect({ x: 0.5 - width / 2 + shift, y: 0.42 - height / 2 + shift, width, height });
}

/** Width ÷ height of a stamp's box: room for the word and a margin either side. */
export function stampAspect(label: string): number {
  return (label.length * 0.72 + 1) / 1.8;
}

export interface NewObjectOptions {
  id: string;
  pageIndex: number;
  page: PageSize;
  /** How many objects of this kind the page has already. */
  alreadyThere?: number;
  color?: string;
  strokeWidth?: number;
  opacity?: number;
}

/**
 * A new object of a kind that needs nothing from the visitor, sized for the
 * page it goes on — a fraction of it, not a fixed number of pixels — and placed
 * near the middle, where it is in view.
 */
export function newObject(
  kind: Exclude<EditKind, 'image' | 'draw'>,
  options: NewObjectOptions & { stampLabel?: StampLabel; text?: string },
): EditObject {
  const { id, pageIndex, page, alreadyThere = 0 } = options;
  const color = options.color ?? DEFAULT_COLOUR;
  const strokeWidth = options.strokeWidth ?? 2;
  const opacity = options.opacity ?? 1;
  const base = { id, pageIndex, opacity, lockAspect: LOCKED_BY_DEFAULT[kind] };
  const body = defaultFontSize(page);

  switch (kind) {
    case 'text': {
      const text = options.text ?? 'Text';
      const size = textSizePt(text, body);
      const obj: TextObject = { ...base, kind, text, fontSize: body, color, rect: centred(page, size.width, size.height, alreadyThere) };
      return fitText(obj, page);
    }
    case 'rect':
    case 'ellipse': {
      const w = page.widthPt * 0.3;
      return { ...base, kind, color, strokeWidth, rect: centred(page, w, w * (2 / 3), alreadyThere) };
    }
    case 'line':
    case 'arrow': {
      const w = page.widthPt * 0.3;
      return {
        ...base,
        kind,
        color,
        strokeWidth,
        direction: 'right',
        rect: centred(page, w, Math.max(body, strokeWidth * 4), alreadyThere),
      };
    }
    case 'highlight':
      return {
        ...base,
        kind,
        opacity: 1,
        color: options.color ?? HIGHLIGHT_COLOUR,
        rect: centred(page, page.widthPt * 0.4, body * 1.4, alreadyThere),
      };
    case 'whiteout':
      return { ...base, kind, opacity: 1, rect: centred(page, page.widthPt * 0.3, body * 2, alreadyThere) };
    case 'stamp': {
      const label = options.stampLabel ?? 'APPROVED';
      const h = page.widthPt * 0.06;
      return {
        ...base,
        kind,
        label,
        color: STAMP_COLOURS[label],
        rect: centred(page, h * stampAspect(label), h, alreadyThere),
      };
    }
  }
}

/** A new picture: 40% of the page wide (less if that makes it too tall), its own proportions. */
export function newImage(
  options: NewObjectOptions & { src: string; mime: 'image/jpeg' | 'image/png'; pixelWidth: number; pixelHeight: number },
): ImageObject {
  const { id, pageIndex, page, alreadyThere = 0 } = options;
  const aspect = options.pixelWidth > 0 && options.pixelHeight > 0 ? options.pixelWidth / options.pixelHeight : 1;
  let w = page.widthPt * 0.4;
  let h = w / aspect;
  const maxH = page.heightPt * 0.4;
  if (h > maxH) {
    w *= maxH / h;
    h = maxH;
  }
  return {
    id,
    pageIndex,
    kind: 'image',
    opacity: options.opacity ?? 1,
    lockAspect: true,
    src: options.src,
    mime: options.mime,
    rect: centred(page, w, h, alreadyThere),
  };
}

/** A box's shape on screen: the height that gives `aspect` (width ÷ height) at the current width. */
export function reshapeToAspect(rect: RectNorm, aspect: number, page: PageSize): RectNorm {
  const height = (rect.width * page.widthPt) / aspect / page.heightPt;
  return clampRect({ ...rect, y: rect.y + (rect.height - height) / 2, height });
}

/**
 * A freehand stroke, drawn as page fractions, made into an object: its box is
 * the stroke's bounds padded by half the line width (so the line is inside the
 * box), and its points become fractions of that box.
 */
export function newDrawing(
  points: [number, number][],
  options: NewObjectOptions,
): DrawObject | null {
  if (points.length < 2) return null;
  const { id, pageIndex, page } = options;
  const strokeWidth = options.strokeWidth ?? 2;
  const padX = strokeWidth / 2 / page.widthPt;
  const padY = strokeWidth / 2 / page.heightPt;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.min(...xs) - padX);
  const y0 = Math.max(0, Math.min(...ys) - padY);
  const x1 = Math.min(1, Math.max(...xs) + padX);
  const y1 = Math.min(1, Math.max(...ys) + padY);
  const width = Math.max(x1 - x0, 1e-4);
  const height = Math.max(y1 - y0, 1e-4);
  return {
    id,
    pageIndex,
    kind: 'draw',
    opacity: options.opacity ?? 1,
    lockAspect: false,
    color: options.color ?? DEFAULT_COLOUR,
    strokeWidth,
    rect: { x: x0, y: y0, width, height },
    points: points.map(([x, y]) => [(x - x0) / width, (y - y0) / height]),
  };
}

/**
 * The two ends of a line in its box, in points (y down), pulled in by half the
 * line width from the edges they touch so the round caps stay inside the box.
 */
export function lineEndsPt(obj: LineObject, widthPt: number, heightPt: number): [number, number, number, number] {
  const [fx1, fy1, fx2, fy2] = DIRECTION_ENDS[obj.direction];
  const inset = Math.min(obj.strokeWidth / 2, widthPt / 2, heightPt / 2);
  const along = (f: number, size: number) => Math.min(size - inset, Math.max(inset, f * size));
  return [along(fx1, widthPt), along(fy1, heightPt), along(fx2, widthPt), along(fy2, heightPt)];
}

/** The arrowhead's two barbs, from the tip, in the same frame as `lineEndsPt`. */
export function arrowHeadPt(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): [number, number, number, number] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(8, strokeWidth * 4);
  return [
    x2 - head * Math.cos(angle - Math.PI / 6),
    y2 - head * Math.sin(angle - Math.PI / 6),
    x2 - head * Math.cos(angle + Math.PI / 6),
    y2 - head * Math.sin(angle + Math.PI / 6),
  ];
}

/** Stamp layout in its box, in points: the frame line width, font size, padding and the text's baseline from the top. */
export function stampLayout(widthPt: number, heightPt: number) {
  const fontSize = heightPt * 0.5;
  const lineWidth = Math.max(1, heightPt * 0.06);
  const pad = heightPt * 0.25;
  return {
    fontSize,
    lineWidth,
    /** The word is stretched or squeezed to exactly this width. */
    textWidth: Math.max(1, widthPt - 2 * pad),
    textX: pad,
    // Centre the capitals: Helvetica's cap height is 0.718 em.
    baseline: heightPt / 2 + (HELVETICA_ASCENT / 1000) * fontSize * 0.5,
  };
}
