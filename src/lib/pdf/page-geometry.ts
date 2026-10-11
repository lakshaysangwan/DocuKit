/**
 * Page geometry: the one place that maps "where it is on the page you see" to
 * "where it is in the PDF file", and back.
 *
 * Two coordinate systems:
 *
 *   • VIEW — the page as displayed, after `/Rotate` has been applied. Normalised
 *     to 0–1 on both axes with the origin at the TOP-LEFT and y running down,
 *     exactly like a CSS box positioned with percentages over the page image.
 *
 *   • PDF  — default user space of the page: the units pdf-lib draws in, origin
 *     wherever the file put it, y running UP.
 *
 * Everything a place-on-page tool needs comes from three numbers pdf.js reports
 * per page — the visible box, the rotation and the UserUnit — so the tools must
 * not read `page.getSize()` and assume a 0,0 origin and no rotation. That
 * assumption is wrong for scans (usually `/Rotate 90`), for pages cropped by
 * another tool (non-zero CropBox origin) and for large-format drawings
 * (UserUnit > 1).
 *
 * This module is pure: no pdf.js, no DOM. `PdfDocHandle.geometry(i)` builds a
 * `PageGeometry` from a pdf.js page; tests build one from plain numbers. The
 * mapping is the exact inverse of the pdf.js `PageViewport` transform, which is
 * asserted against the real pdf.js viewport in the integration test.
 */

/** `/Rotate` normalised to one of the four values a PDF page can have. */
export type PageRotation = 0 | 90 | 180 | 270;

/** `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

/** A rectangle in the view: fractions of the displayed page, top-left origin. */
export interface RectNorm {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in PDF user space: `x`,`y` is the lower-left corner, y up. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Margins measured inward from each edge of the displayed page, as fractions of it. */
export interface MarginsNorm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** pdf-lib `drawImage` / `drawRectangle` parameters (`rotate: degrees(rotateDeg)`). */
export interface PdfDrawParams {
  /** Where pdf-lib anchors the image: its own lower-left corner, in user space. */
  x: number;
  y: number;
  /** Size in user-space units (already divided by UserUnit). */
  width: number;
  height: number;
  /** Counter-clockwise rotation about (`x`,`y`) in degrees, in [0, 360). */
  rotateDeg: number;
}

export interface PageGeometry {
  /** Displayed width in points (1/72 in): after `/Rotate`, multiplied by UserUnit. */
  widthPt: number;
  /** Displayed height in points (1/72 in): after `/Rotate`, multiplied by UserUnit. */
  heightPt: number;
  /** `/Rotate`, clockwise, normalised to 0 | 90 | 180 | 270. */
  rotate: PageRotation;
  /**
   * The visible box in user space as `[x1, y1, x2, y2]` with x1 < x2, y1 < y2:
   * CropBox ∩ MediaBox, which is what pdf.js draws. Its origin is often not 0,0.
   */
  viewBox: readonly [number, number, number, number];
  /** `/UserUnit`: the size of one user-space unit in points. 1 for almost every file. */
  userUnit: number;
  /** Normalised view → PDF user space. */
  matrix: Matrix;
  /** PDF user space → normalised view (the inverse of `matrix`). */
  inverseMatrix: Matrix;
}

/** The three facts about a page everything else is derived from. */
export interface PageGeometrySource {
  /** `[x1, y1, x2, y2]` of the visible box in user space (pdf.js `page.view`). */
  view: ArrayLike<number>;
  /** `/Rotate` in degrees; any multiple of 90, negative allowed. */
  rotate: number;
  /** `/UserUnit`; missing or non-positive is treated as 1. */
  userUnit?: number;
}

/** Smallest crop box side `viewMarginsToCropBox` will return, in user-space units. */
export const MIN_CROP_SIZE = 1;

export function normaliseRotation(degrees: number): PageRotation {
  const r = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return r as PageRotation;
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/**
 * Build a `PageGeometry` from the visible box, rotation and UserUnit.
 *
 * With the box `[x1, y1, x2, y2]`, W = x2 − x1, H = y2 − y1 and a view point
 * (u, v), the view → PDF mapping per rotation is:
 *
 *     0:  x = x1 + u·W    y = y2 − v·H
 *    90:  x = x1 + v·W    y = y1 + u·H
 *   180:  x = x2 − u·W    y = y1 + v·H
 *   270:  x = x2 − v·W    y = y2 − u·H
 *
 * UserUnit scales how large the page is displayed, not where a fraction of it
 * lands, so it appears in `widthPt`/`heightPt` only.
 */
export function makePageGeometry(source: PageGeometrySource): PageGeometry {
  const x1 = Math.min(source.view[0], source.view[2]);
  const x2 = Math.max(source.view[0], source.view[2]);
  const y1 = Math.min(source.view[1], source.view[3]);
  const y2 = Math.max(source.view[1], source.view[3]);
  const w = x2 - x1;
  const h = y2 - y1;
  const rotate = normaliseRotation(source.rotate);
  const userUnit = source.userUnit && source.userUnit > 0 ? source.userUnit : 1;

  let matrix: Matrix;
  switch (rotate) {
    case 90:
      matrix = [0, h, w, 0, x1, y1];
      break;
    case 180:
      matrix = [-w, 0, 0, h, x2, y1];
      break;
    case 270:
      matrix = [0, -h, -w, 0, x2, y2];
      break;
    default:
      matrix = [w, 0, 0, -h, x1, y2];
  }

  const sideways = rotate === 90 || rotate === 270;
  return {
    widthPt: (sideways ? h : w) * userUnit,
    heightPt: (sideways ? w : h) * userUnit,
    rotate,
    viewBox: [x1, y1, x2, y2],
    userUnit,
    matrix,
    inverseMatrix: invertMatrix(matrix),
  };
}

/** A point of the displayed page (fractions, top-left origin) → PDF user space. */
export function viewPointToPdf(geom: PageGeometry, xNorm: number, yNorm: number): [number, number] {
  return applyMatrix(geom.matrix, xNorm, yNorm);
}

/** A point in PDF user space → fractions of the displayed page (top-left origin). */
export function pdfPointToView(geom: PageGeometry, x: number, y: number): [number, number] {
  return applyMatrix(geom.inverseMatrix, x, y);
}

/**
 * pdf-lib parameters that put an image exactly where the user sees it.
 *
 * `rectNorm` is the image's box on the displayed page BEFORE its own rotation —
 * the box of an absolutely positioned `<img>` — and `rotationCwDeg` turns it
 * clockwise about the centre of that box, as CSS `transform: rotate()` does with
 * the default transform origin. So the preview is `<img style="left/top/width/
 * height in %; transform: rotate(θdeg)">` and the output is
 *
 *     page.drawImage(img, { x, y, width, height, rotate: degrees(rotateDeg) })
 *
 * pdf-lib anchors an image at its lower-left corner and rotates it
 * counter-clockwise about that corner, so the corner is rotated in the view
 * first and then mapped; the angle is `/Rotate − θ` because the page rotation
 * and the image's own rotation add up in opposite directions.
 */
export function viewRectToPdfDraw(
  geom: PageGeometry,
  rectNorm: RectNorm,
  rotationCwDeg = 0,
): PdfDrawParams {
  // Work in displayed points so a rotation is a true rotation (the normalised
  // axes are scaled differently unless the page is square).
  const widthView = rectNorm.width * geom.widthPt;
  const heightView = rectNorm.height * geom.heightPt;
  const centreX = (rectNorm.x + rectNorm.width / 2) * geom.widthPt;
  const centreY = (rectNorm.y + rectNorm.height / 2) * geom.heightPt;

  // The image's lower-left corner relative to its centre (y runs down in the
  // view), turned clockwise by θ.
  const theta = (rotationCwDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const offsetX = -widthView / 2;
  const offsetY = heightView / 2;
  const cornerX = centreX + offsetX * cos - offsetY * sin;
  const cornerY = centreY + offsetX * sin + offsetY * cos;

  const [x, y] = viewPointToPdf(geom, cornerX / geom.widthPt, cornerY / geom.heightPt);
  return {
    x,
    y,
    width: widthView / geom.userUnit,
    height: heightView / geom.userUnit,
    rotateDeg: (((geom.rotate - rotationCwDeg) % 360) + 360) % 360,
  };
}

/**
 * An upright rectangle of the displayed page → the PDF user-space rectangle that
 * covers the same area. For axis-aligned things with no orientation of their own
 * (a redaction box, a crop area); use `viewRectToPdfDraw` for images and text.
 */
export function viewRectToPdfRect(geom: PageGeometry, rectNorm: RectNorm): PdfRect {
  const [ax, ay] = viewPointToPdf(geom, rectNorm.x, rectNorm.y);
  const [bx, by] = viewPointToPdf(geom, rectNorm.x + rectNorm.width, rectNorm.y + rectNorm.height);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/**
 * A PDF user-space rectangle (lower-left `x`,`y`) → the upright box that covers
 * it on the displayed page. Use it to show something that is already in the
 * file — a text match, an existing annotation — over the page image.
 */
export function pdfRectToView(geom: PageGeometry, rect: PdfRect): RectNorm {
  const [ax, ay] = pdfPointToView(geom, rect.x, rect.y);
  const [bx, by] = pdfPointToView(geom, rect.x + rect.width, rect.y + rect.height);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/**
 * Margins drawn on the displayed page → `[x, y, width, height]` for pdf-lib
 * `page.setCropBox(x, y, width, height)`.
 *
 * "Top" is the top of the page as the user sees it, so on a `/Rotate 90` page it
 * trims what is the left edge in user space. Margins are clamped to the page,
 * and to leave at least `MIN_CROP_SIZE` units so the box can never invert.
 */
export function viewMarginsToCropBox(
  geom: PageGeometry,
  marginsNorm: MarginsNorm,
): [number, number, number, number] {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const left = clamp01(marginsNorm.left);
  const top = clamp01(marginsNorm.top);
  const minWidth = (MIN_CROP_SIZE * geom.userUnit) / geom.widthPt;
  const minHeight = (MIN_CROP_SIZE * geom.userUnit) / geom.heightPt;
  const x = Math.min(left, 1 - minWidth);
  const y = Math.min(top, 1 - minHeight);
  const width = Math.max(minWidth, 1 - x - clamp01(marginsNorm.right));
  const height = Math.max(minHeight, 1 - y - clamp01(marginsNorm.bottom));

  const rect = viewRectToPdfRect(geom, { x, y, width, height });
  return [rect.x, rect.y, rect.width, rect.height];
}
