/**
 * Crop PDF's arithmetic, shared by the on-screen crop box and the writers.
 *
 * The visitor sets four margins in PDF points, measured inward from the
 * VISUAL top, right, bottom and left of the page as it is shown — after
 * `/Rotate`, inside whatever crop box the file already has. Everything here
 * works in those displayed points; `cropBoxFor` hands them to
 * `viewMarginsToCropBox`, the one place that maps the page you see to the
 * file, so a rotated scan or a page with an offset crop box is cut at the
 * edges the visitor dragged, not at the stored page's edges.
 *
 * Pure: no pdf.js, pdf-lib or DOM.
 */
import { parsePageRange } from './pdf-page-range';
import { viewMarginsToCropBox, type MarginsNorm, type PageGeometry } from './pdf/page-geometry';

export type CropSide = 'top' | 'right' | 'bottom' | 'left';

/** Margins in displayed points, measured inward from each visual edge. */
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_MARGINS: CropMargins = { top: 0, right: 0, bottom: 0, left: 0 };
export const CROP_SIDES: CropSide[] = ['top', 'right', 'bottom', 'left'];

export type CropUnit = 'mm' | 'in' | 'pt';
export const CROP_UNITS: CropUnit[] = ['mm', 'in', 'pt'];

/** PDF points are 1/72 inch; everything else derives from that. */
export const POINTS_PER: Record<CropUnit, number> = { pt: 1, in: 72, mm: 72 / 25.4 };
export const UNIT_NAME: Record<CropUnit, string> = { mm: 'millimetres', in: 'inches', pt: 'points' };

/** The crop box never gets smaller than this on screen, in points. */
export const MIN_BOX_PT = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A margin as the field shows it: in `unit`, to two decimals. */
export function toUnit(points: number, unit: CropUnit): number {
  return round2(points / POINTS_PER[unit]);
}

/** A value typed in `unit` → points, exactly (no rounding). */
export function fromUnit(value: number, unit: CropUnit): number {
  return (Number.isFinite(value) ? Math.max(0, value) : 0) * POINTS_PER[unit];
}

/**
 * Snap points to what the field in `unit` can show, so that what is dragged is
 * exactly what is typed back and what the file gets: the field reads
 * `toUnit(p)`, and `fromUnit(toUnit(p))` is `p` again.
 */
export function snapToUnit(points: number, unit: CropUnit): number {
  return fromUnit(toUnit(points, unit), unit);
}

export function snapMargins(m: CropMargins, unit: CropUnit): CropMargins {
  return {
    top: snapToUnit(m.top, unit),
    right: snapToUnit(m.right, unit),
    bottom: snapToUnit(m.bottom, unit),
    left: snapToUnit(m.left, unit),
  };
}

/** The size readout: whole points, 0.1 mm or 0.01 inch. */
export function formatLength(points: number, unit: CropUnit): string {
  const v = Math.max(0, points) / POINTS_PER[unit];
  if (unit === 'pt') return String(Math.round(v));
  if (unit === 'mm') return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 100) / 100);
}

export const hasCrop = (m: CropMargins) => m.top > 0 || m.right > 0 || m.bottom > 0 || m.left > 0;

/** Displayed page size, in points. */
export interface PageSizePt {
  width: number;
  height: number;
}

/** Move the given sides by a delta in points, keeping the box on the page and at least `MIN_BOX_PT`. */
export function resizeMargins(start: CropMargins, sides: CropSide[], dx: number, dy: number, page: PageSizePt): CropMargins {
  const m = { ...start };
  if (sides.includes('top')) m.top = clamp(start.top + dy, 0, Math.max(0, page.height - m.bottom - MIN_BOX_PT));
  if (sides.includes('bottom')) m.bottom = clamp(start.bottom - dy, 0, Math.max(0, page.height - m.top - MIN_BOX_PT));
  if (sides.includes('left')) m.left = clamp(start.left + dx, 0, Math.max(0, page.width - m.right - MIN_BOX_PT));
  if (sides.includes('right')) m.right = clamp(start.right - dx, 0, Math.max(0, page.width - m.left - MIN_BOX_PT));
  return m;
}

/** Slide the whole box by a delta in points without changing its size or leaving the page. */
export function moveMargins(start: CropMargins, dx: number, dy: number): CropMargins {
  const mx = clamp(dx, -start.left, start.right);
  const my = clamp(dy, -start.top, start.bottom);
  return { top: start.top + my, bottom: start.bottom - my, left: start.left + mx, right: start.right - mx };
}

/** The margins as fractions of the displayed page, as `viewMarginsToCropBox` takes them. */
export function marginsToNorm(geom: Pick<PageGeometry, 'widthPt' | 'heightPt'>, m: CropMargins): MarginsNorm {
  return {
    top: m.top / geom.heightPt,
    right: m.right / geom.widthPt,
    bottom: m.bottom / geom.heightPt,
    left: m.left / geom.widthPt,
  };
}

/** `[x, y, width, height]` for pdf-lib `setCropBox`: the visual area the margins leave. */
export function cropBoxFor(geom: PageGeometry, m: CropMargins): [number, number, number, number] {
  return viewMarginsToCropBox(geom, marginsToNorm(geom, m));
}

/** Size of the page after the crop, in displayed points (clamped like the crop box). */
export function croppedSize(page: PageSizePt, m: CropMargins): PageSizePt {
  return {
    width: Math.max(0, page.width - m.left - m.right),
    height: Math.max(0, page.height - m.top - m.bottom),
  };
}

export type ApplyTo = 'current' | 'all' | 'range';

/** Zero-based indexes of the pages a run crops. "Current" is the page on screen. */
export function cropTargets(applyTo: ApplyTo, currentIndex: number, range: string, pageCount: number): number[] {
  if (pageCount <= 0) return [];
  if (applyTo === 'all') return Array.from({ length: pageCount }, (_, i) => i);
  if (applyTo === 'current') return [clamp(currentIndex, 0, pageCount - 1)];
  return parsePageRange(range, pageCount);
}

/**
 * The content of a page image: the box (fractions of the image) around every
 * pixel darker than `threshold` on any channel, widened by `padPx`, or null on a
 * blank page. Used by Auto-crop whitespace.
 */
export function contentBounds(
  data: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 245,
  padPx = 4,
): { left: number; top: number; right: number; bottom: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Transparent pixels are paper too.
      if (data[i + 3] === 0) continue;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const x0 = Math.max(0, minX - padPx);
  const y0 = Math.max(0, minY - padPx);
  const x1 = Math.min(width, maxX + 1 + padPx);
  const y1 = Math.min(height, maxY + 1 + padPx);
  return { left: x0 / width, top: y0 / height, right: (width - x1) / width, bottom: (height - y1) / height };
}
