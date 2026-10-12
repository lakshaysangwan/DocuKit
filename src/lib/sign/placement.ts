/**
 * Where a new stamp goes, how it is copied to other pages, and how its box is
 * read out in millimetres. Pure: only the page's displayed size is needed.
 *
 * A stamp's box is a `RectNorm` — fractions of the displayed page, top-left
 * origin — so "35% of the page width" means the same on A4 and on a poster.
 */
import type { RectNorm } from '../pdf/page-geometry';
import { clampRect } from '../workspace/overlay-math';

export type StampKind = 'signature' | 'initials' | 'date';

/** The displayed size of a page in points; `PageGeometry` satisfies it. */
export interface PageSize {
  widthPt: number;
  heightPt: number;
}

export const MM_PER_PT = 25.4 / 72;

interface Default {
  /** Width as a fraction of the page width. */
  width: number;
  /** The box is scaled down if it would be taller than this fraction of the page height. */
  maxHeight: number;
  /** Where the centre of the box goes. */
  centreX: number;
  centreY: number;
}

/**
 * A signature starts in the lower middle of the page, where signature lines
 * usually are; the date just under it; initials in the bottom-right corner.
 */
const DEFAULTS: Record<StampKind, Default> = {
  signature: { width: 0.35, maxHeight: 0.2, centreX: 0.5, centreY: 0.7 },
  date: { width: 0.16, maxHeight: 0.05, centreX: 0.5, centreY: 0.86 },
  initials: { width: 0.12, maxHeight: 0.08, centreX: 0.84, centreY: 0.92 },
};

/** Each further stamp of the same kind on a page is offset by this much, so they do not hide each other. */
const STAGGER = 0.03;
/** After this many the offsets start again. */
const STAGGER_CYCLE = 5;

/**
 * The box for a new stamp.
 *
 * `aspect` is the stamp's own width ÷ height (of the trimmed image, or of the
 * date text). The box always has exactly that shape on screen — a signature is
 * never stretched into a fixed slot. `alreadyThere` is how many stamps of this
 * kind the page already has.
 */
export function defaultStampRect(
  kind: StampKind,
  aspect: number,
  page: PageSize,
  alreadyThere = 0,
): RectNorm {
  const d = DEFAULTS[kind];
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // Width and height are fractions of different lengths unless the page is
  // square, so the shape has to be worked out in points.
  let width = d.width;
  let height = (width * page.widthPt) / safeAspect / page.heightPt;
  if (height > d.maxHeight) {
    width *= d.maxHeight / height;
    height = d.maxHeight;
  }
  const shift = (alreadyThere % STAGGER_CYCLE) * STAGGER;
  return clampRect({
    x: d.centreX - width / 2 + shift,
    y: d.centreY - height / 2 + shift,
    width,
    height,
  });
}

/**
 * Give a box a new shape (width ÷ height on screen) without moving its centre
 * or changing its width — used when the signature is redrawn and every stamp
 * that shows it has to take the new image's proportions.
 */
export function reshapeRect(rect: RectNorm, aspect: number, page: PageSize): RectNorm {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const height = (rect.width * page.widthPt) / safeAspect / page.heightPt;
  return clampRect({
    x: rect.x,
    y: rect.y + (rect.height - height) / 2,
    width: rect.width,
    height,
  });
}

/**
 * The same stamp on another page: the same physical size and the same distance
 * from the left and bottom edges, as "sign here" lines sit at the foot of every
 * page whatever its height. Scaled down and moved inside if the other page is
 * too small for it. On a page of the same size the box is simply the same.
 */
export function copyRectToPage(rect: RectNorm, from: PageSize, to: PageSize): RectNorm {
  const widthPt = rect.width * from.widthPt;
  const heightPt = rect.height * from.heightPt;
  const leftPt = rect.x * from.widthPt;
  const bottomPt = (1 - rect.y - rect.height) * from.heightPt;
  const width = widthPt / to.widthPt;
  const height = heightPt / to.heightPt;
  return clampRect({
    x: leftPt / to.widthPt,
    y: 1 - bottomPt / to.heightPt - height,
    width,
    height,
  });
}

/** A box as the number fields show it: millimetres from the left and top edges. */
export interface RectMm {
  x: number;
  y: number;
  width: number;
}

export function rectToMm(rect: RectNorm, page: PageSize): RectMm {
  return {
    x: rect.x * page.widthPt * MM_PER_PT,
    y: rect.y * page.heightPt * MM_PER_PT,
    width: rect.width * page.widthPt * MM_PER_PT,
  };
}

/**
 * Apply an edit from the number fields. Changing the width keeps the top-left
 * corner and the shape; everything is kept on the page.
 */
export function applyMm(
  rect: RectNorm,
  page: PageSize,
  edit: Partial<RectMm>,
  minWidth = 0.03,
): RectNorm {
  let next = { ...rect };
  if (edit.width !== undefined && Number.isFinite(edit.width)) {
    const width = Math.max(minWidth, Math.min(1, edit.width / MM_PER_PT / page.widthPt));
    const scale = Math.min(width / rect.width, 1 / rect.height);
    next = { ...next, width: rect.width * scale, height: rect.height * scale };
  }
  if (edit.x !== undefined && Number.isFinite(edit.x)) next.x = edit.x / MM_PER_PT / page.widthPt;
  if (edit.y !== undefined && Number.isFinite(edit.y)) next.y = edit.y / MM_PER_PT / page.heightPt;
  return clampRect(next);
}
