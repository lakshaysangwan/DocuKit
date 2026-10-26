/**
 * Watermark layout: where every copy of a watermark goes on a page.
 *
 * One function, used by both sides: the preview draws exactly these boxes over
 * the page image, and the worker writes exactly these boxes into the file
 * through `page-geometry.ts`. So what is on screen and what is in the file
 * cannot drift apart again (they used to: a 3×4 preview grid against 200 pt
 * output spacing, two different image sizes, two different rotation pivots).
 *
 * Every placement is a box on the DISPLAYED page — fractions of it, top-left
 * origin, y down: a `RectNorm` — plus a clockwise turn about the box's centre,
 * the way CSS `transform: rotate()` turns an element. That is exactly the input
 * `viewRectToPdfDraw` takes, so `/Rotate`, a crop box that does not start at
 * 0,0 and UserUnit are handled in one place for every tool.
 *
 * The box of a text watermark is the line of text as the standard font sets
 * it: as wide as the font's advance widths add up to, from the font's
 * descender to its ascender. Its centre — the visual centre of the words — is
 * the pivot of the rotation, on screen and in the file.
 *
 * Pure: no DOM, no pdf-lib. Sizes are in DISPLAYED points (after `/Rotate`,
 * times UserUnit), the units `PageGeometry.widthPt` is in.
 */
import type { RectNorm } from './pdf/page-geometry';
import { fontExtentEm, textWidthEm, type WatermarkFont } from './watermark-fonts';

export type WatermarkPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const WATERMARK_POSITIONS: readonly WatermarkPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/** One of the nine presets, or `custom`: wherever the visitor dragged it, given by `centre`. */
export type WatermarkPositionChoice = WatermarkPosition | 'custom';

/** A point of the displayed page as fractions of it, top-left origin, y down. */
export interface WatermarkCentre {
  x: number;
  y: number;
}

export type WatermarkApplyTo = 'all' | 'odd' | 'even' | 'range';

/** What decides where the watermark goes and how big it is. */
export interface WatermarkLayoutOptions {
  type: 'text' | 'image';
  /** Text watermark: the words, the font and its size in points. */
  text?: string;
  font?: WatermarkFont;
  fontSize?: number;
  /** Image watermark: its pixel size (for the shape) and its width as a fraction of the page width. */
  imageWidthPx?: number;
  imageHeightPx?: number;
  imageScale?: number;
  /** Degrees, clockwise on screen, about the watermark's centre. Negative turns it anticlockwise. */
  rotation: number;
  /** One watermark at `position`, or copies repeated over the whole page. */
  placement: 'single' | 'tiled';
  position?: WatermarkPositionChoice;
  /**
   * Single, `custom` position: the watermark's centre as fractions of the
   * displayed page, so every watermarked page gets it at the same relative
   * spot. Kept on the page (0–1); the watermark itself may hang over the edge.
   */
  centre?: WatermarkCentre;
  /** Single, away from the centre: the gap between the (turned) watermark and the page edges, in points. */
  margin?: number;
  /** Tiled: the gap between neighbouring copies, in points. */
  spacing?: number;
}

export interface WatermarkPlacement {
  /** The watermark's box before it is turned, as fractions of the displayed page. */
  rect: RectNorm;
  /** Clockwise degrees about the centre of `rect`. */
  rotation: number;
}

export interface WatermarkLayout {
  placements: WatermarkPlacement[];
  /** Size of one watermark's box (before turning), in displayed points. */
  boxWidthPt: number;
  boxHeightPt: number;
  /** Text: how far the baseline sits above the bottom of the box, in points. 0 for an image. */
  baselinePt: number;
}

export const DEFAULT_FONT_SIZE = 60;
export const DEFAULT_IMAGE_SCALE = 0.5;
export const DEFAULT_MARGIN = 36;
export const DEFAULT_SPACING = 60;
/**
 * The most copies a tiled page gets. Tiny text with no gap could ask for
 * thousands on a large page; past this the spacing is widened just enough.
 */
export const MAX_TILES = 1500;

const EMPTY: WatermarkLayout = { placements: [], boxWidthPt: 0, boxHeightPt: 0, baselinePt: 0 };

/** One watermark's box (before turning) in points, and where the text baseline sits in it. */
export function watermarkBox(
  pageWidthPt: number,
  options: WatermarkLayoutOptions,
): { width: number; height: number; baseline: number } | null {
  if (options.type === 'text') {
    const text = options.text ?? '';
    const font = options.font ?? 'Helvetica-Bold';
    const size = options.fontSize ?? DEFAULT_FONT_SIZE;
    const width = textWidthEm(font, text) * size;
    if (!(width > 0) || !(size > 0)) return null;
    const { ascent, descent } = fontExtentEm(font);
    return { width, height: (ascent - descent) * size, baseline: -descent * size };
  }
  const wPx = options.imageWidthPx ?? 0;
  const hPx = options.imageHeightPx ?? 0;
  if (!(wPx > 0) || !(hPx > 0)) return null;
  const width = pageWidthPt * (options.imageScale ?? DEFAULT_IMAGE_SCALE);
  if (!(width > 0)) return null;
  return { width, height: (width * hPx) / wPx, baseline: 0 };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** A custom centre kept on the page: each coordinate within 0–1 (0.5 if it is not a number). */
export function clampCentre(c: WatermarkCentre): WatermarkCentre {
  return { x: clamp01(c.x), y: clamp01(c.y) };
}

/** Width and height of the upright box that contains a w×h box turned by `deg`. */
export function turnedExtent(width: number, height: number, deg: number): { width: number; height: number } {
  const t = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { width: width * c + height * s, height: width * s + height * c };
}

/**
 * Every copy of the watermark on a page `widthPt` × `heightPt` (displayed
 * points), as the visitor sees it.
 *
 *   single  one box. At the centre its centre is the page's; at an edge or
 *           corner the turned box keeps `margin` points from those edges; at
 *           `custom` its centre is `centre` (fractions of the page, clamped
 *           to it) and the box may reach past the edge.
 *   tiled   a lattice turned with the watermark: copies follow each other along
 *           the reading direction `spacing` points apart, rows are `spacing`
 *           apart, every other row is shifted by half a step (a brick pattern),
 *           and one copy sits at the centre of the page. Every copy that
 *           reaches into the page is kept; copies entirely off the page are not.
 */
export function layoutWatermark(
  page: { widthPt: number; heightPt: number },
  options: WatermarkLayoutOptions,
): WatermarkLayout {
  const W = page.widthPt;
  const H = page.heightPt;
  if (!(W > 0) || !(H > 0)) return EMPTY;
  const box = watermarkBox(W, options);
  if (!box) return EMPTY;
  const rotation = Number.isFinite(options.rotation) ? options.rotation : 0;
  const { width: w, height: h } = box;
  const turned = turnedExtent(w, h, rotation);

  const at = (cx: number, cy: number): WatermarkPlacement => ({
    rect: { x: (cx - w / 2) / W, y: (cy - h / 2) / H, width: w / W, height: h / H },
    rotation,
  });

  const placements: WatermarkPlacement[] = [];
  if (options.placement === 'single' && options.position === 'custom') {
    const c = clampCentre(options.centre ?? { x: 0.5, y: 0.5 });
    placements.push(at(c.x * W, c.y * H));
  } else if (options.placement === 'single') {
    const position = options.position ?? 'center';
    const margin = Math.max(0, options.margin ?? DEFAULT_MARGIN);
    const [row, col] = position === 'center' ? ['middle', 'center'] : position.split('-');
    const cx = col === 'left' ? margin + turned.width / 2 : col === 'right' ? W - margin - turned.width / 2 : W / 2;
    const cy = row === 'top' ? margin + turned.height / 2 : row === 'bottom' ? H - margin - turned.height / 2 : H / 2;
    placements.push(at(cx, cy));
  } else {
    const gap = Math.max(0, options.spacing ?? DEFAULT_SPACING);
    let stepAlong = w + gap;
    let stepAcross = h + gap;
    // Keep the number of copies bounded: widen both steps by the same factor.
    const estimate = (W * H) / (stepAlong * stepAcross);
    if (estimate > MAX_TILES * 0.8) {
      const k = Math.sqrt(estimate / (MAX_TILES * 0.8));
      stepAlong *= k;
      stepAcross *= k;
    }
    const t = (rotation * Math.PI) / 180;
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    // Across the rows: the reading direction turned a further 90° clockwise (y runs down).
    const vx = -uy;
    const vy = ux;
    const reach = Math.hypot(W, H) / 2 + Math.hypot(turned.width, turned.height);
    const rows = Math.ceil(reach / stepAcross);
    const cols = Math.ceil(reach / stepAlong) + 1;
    for (let j = -rows; j <= rows; j++) {
      const shift = Math.abs(j) % 2 === 1 ? 0.5 : 0;
      for (let i = -cols; i <= cols; i++) {
        const along = (i + shift) * stepAlong;
        const across = j * stepAcross;
        const cx = W / 2 + along * ux + across * vx;
        const cy = H / 2 + along * uy + across * vy;
        // Keep it if its turned box reaches into the page.
        if (cx + turned.width / 2 <= 0 || cx - turned.width / 2 >= W) continue;
        if (cy + turned.height / 2 <= 0 || cy - turned.height / 2 >= H) continue;
        placements.push(at(cx, cy));
      }
    }
  }
  return { placements, boxWidthPt: w, boxHeightPt: h, baselinePt: box.baseline };
}

/**
 * Which pages get the watermark: zero-based indices, ascending. `range` is the
 * already-parsed list of zero-based pages for "Specific pages".
 */
export function watermarkedPages(applyTo: WatermarkApplyTo, pageCount: number, range: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    if (applyTo === 'all') out.push(i);
    else if (applyTo === 'odd' && i % 2 === 0) out.push(i);
    else if (applyTo === 'even' && i % 2 === 1) out.push(i);
    else if (applyTo === 'range' && range.includes(i)) out.push(i);
  }
  return out;
}
