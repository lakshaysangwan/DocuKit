import { describe, it, expect } from 'vitest';
import {
  makePageGeometry,
  normaliseRotation,
  pdfPointToView,
  pdfRectToView,
  viewMarginsToCropBox,
  viewPointToPdf,
  viewRectToPdfDraw,
  viewRectToPdfRect,
  MIN_CROP_SIZE,
  type PageGeometry,
  type PageRotation,
} from './page-geometry';

/**
 * The matrix: every rotation × a box at the origin and one that is not × a
 * UserUnit of 1 and one that is not. Expectations are written out per rotation
 * from the definition of /Rotate ("turn the page clockwise by this much to
 * display it"), not computed with the formulas under test.
 */
const ROTATIONS: PageRotation[] = [0, 90, 180, 270];
const BOXES: Record<string, [number, number, number, number]> = {
  'origin 0,0': [0, 0, 612, 792],
  'offset origin': [50, 80, 450, 700],
  'negative origin': [-30, -20, 370, 580],
};
const USER_UNITS = [1, 2.5];

interface Case { name: string; rotate: PageRotation; box: [number, number, number, number]; userUnit: number; geom: PageGeometry }

const CASES: Case[] = ROTATIONS.flatMap((rotate) =>
  Object.entries(BOXES).flatMap(([boxName, box]) =>
    USER_UNITS.map((userUnit) => ({
      name: `/Rotate ${rotate}, ${boxName}, UserUnit ${userUnit}`,
      rotate,
      box,
      userUnit,
      geom: makePageGeometry({ view: box, rotate, userUnit }),
    })),
  ),
);

/** Which corner of the user-space box each displayed corner shows, per rotation. */
function expectedCorners(rotate: PageRotation, [x1, y1, x2, y2]: number[]) {
  const lowerLeft = [x1, y1], lowerRight = [x2, y1], upperLeft = [x1, y2], upperRight = [x2, y2];
  switch (rotate) {
    case 0: return { topLeft: upperLeft, topRight: upperRight, bottomLeft: lowerLeft, bottomRight: lowerRight };
    // Turned a quarter clockwise: what was the lower-left is now at the top-left.
    case 90: return { topLeft: lowerLeft, topRight: upperLeft, bottomLeft: lowerRight, bottomRight: upperRight };
    case 180: return { topLeft: lowerRight, topRight: lowerLeft, bottomLeft: upperRight, bottomRight: upperLeft };
    case 270: return { topLeft: upperRight, topRight: lowerRight, bottomLeft: upperLeft, bottomRight: lowerLeft };
  }
}

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
};

describe('makePageGeometry', () => {
  it.each(CASES)('$name: displayed size is the box, turned, times UserUnit', ({ rotate, box, userUnit, geom }) => {
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const sideways = rotate === 90 || rotate === 270;
    expect(geom.widthPt).toBeCloseTo((sideways ? h : w) * userUnit, 6);
    expect(geom.heightPt).toBeCloseTo((sideways ? w : h) * userUnit, 6);
    expect(geom.rotate).toBe(rotate);
    expect(geom.userUnit).toBe(userUnit);
    expect([...geom.viewBox]).toEqual(box);
  });

  it('normalises rotation and repairs a reversed box and a bad UserUnit', () => {
    expect(normaliseRotation(-90)).toBe(270);
    expect(normaliseRotation(450)).toBe(90);
    expect(normaliseRotation(360)).toBe(0);
    const geom = makePageGeometry({ view: [450, 700, 50, 80], rotate: -270, userUnit: 0 });
    expect([...geom.viewBox]).toEqual([50, 80, 450, 700]);
    expect(geom.rotate).toBe(90);
    expect(geom.userUnit).toBe(1);
  });
});

describe('viewPointToPdf / pdfPointToView', () => {
  it.each(CASES)('$name: the four displayed corners land on the right box corners', ({ rotate, box, geom }) => {
    const want = expectedCorners(rotate, box);
    close(viewPointToPdf(geom, 0, 0), want.topLeft);
    close(viewPointToPdf(geom, 1, 0), want.topRight);
    close(viewPointToPdf(geom, 0, 1), want.bottomLeft);
    close(viewPointToPdf(geom, 1, 1), want.bottomRight);
  });

  it.each(CASES)('$name: an interior point is interpolated between the corners', ({ rotate, box, geom }) => {
    const c = expectedCorners(rotate, box);
    const u = 0.3, v = 0.8;
    const want = [0, 1].map((k) =>
      c.topLeft[k] + u * (c.topRight[k] - c.topLeft[k]) + v * (c.bottomLeft[k] - c.topLeft[k]),
    );
    close(viewPointToPdf(geom, u, v), want);
  });

  it.each(CASES)('$name: view → PDF → view is the identity', ({ geom }) => {
    for (const [u, v] of [[0, 0], [1, 1], [0.25, 0.6], [0.9, 0.05]]) {
      const [x, y] = viewPointToPdf(geom, u, v);
      close(pdfPointToView(geom, x, y), [u, v]);
    }
  });
});

/**
 * What pdf-lib does with drawImage({ x, y, width, height, rotate }): the image's
 * own point (s, t) — s across, t UP, both 0–1 — is placed at
 * (x, y) + R(rotate)·(s·width, t·height), R being counter-clockwise.
 */
function pdfLibImagePoint(d: { x: number; y: number; width: number; height: number; rotateDeg: number }, s: number, t: number) {
  const a = (d.rotateDeg * Math.PI) / 180;
  const px = s * d.width, py = t * d.height;
  return [d.x + px * Math.cos(a) - py * Math.sin(a), d.y + px * Math.sin(a) + py * Math.cos(a)] as const;
}

/**
 * Where CSS puts the same point of an <img> positioned at `rect` (fractions of
 * the page) and turned clockwise by θ about its centre. Returned as fractions.
 */
function cssImagePoint(geom: PageGeometry, rect: { x: number; y: number; width: number; height: number }, thetaCw: number, s: number, t: number) {
  const w = rect.width * geom.widthPt, h = rect.height * geom.heightPt;
  const cx = (rect.x + rect.width / 2) * geom.widthPt, cy = (rect.y + rect.height / 2) * geom.heightPt;
  // Offset from the centre in screen pixels (y down): image-up is screen-up.
  const dx = (s - 0.5) * w, dy = (0.5 - t) * h;
  const a = (thetaCw * Math.PI) / 180;
  return [
    (cx + dx * Math.cos(a) - dy * Math.sin(a)) / geom.widthPt,
    (cy + dx * Math.sin(a) + dy * Math.cos(a)) / geom.heightPt,
  ];
}

describe('viewRectToPdfDraw', () => {
  const rect = { x: 0.15, y: 0.1, width: 0.3, height: 0.12 };
  const ANGLES = [0, 30, 90, -45, 200];

  it.each(CASES)('$name: every corner of the drawn image is where CSS shows it', ({ geom }) => {
    for (const theta of ANGLES) {
      const draw = viewRectToPdfDraw(geom, rect, theta);
      for (const [s, t] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
        const [x, y] = pdfLibImagePoint(draw, s, t);
        close(pdfPointToView(geom, x, y), cssImagePoint(geom, rect, theta, s, t));
      }
    }
  });

  it.each(CASES)('$name: size is in user-space units and the angle is /Rotate − θ', ({ rotate, userUnit, geom }) => {
    const draw = viewRectToPdfDraw(geom, rect, 30);
    expect(draw.width).toBeCloseTo((rect.width * geom.widthPt) / userUnit, 6);
    expect(draw.height).toBeCloseTo((rect.height * geom.heightPt) / userUnit, 6);
    expect(draw.rotateDeg).toBeCloseTo((rotate - 30 + 360) % 360, 6);
    expect(draw.rotateDeg).toBeGreaterThanOrEqual(0);
    expect(draw.rotateDeg).toBeLessThan(360);
  });

  it('on an upright page at the origin it is the familiar flip of y', () => {
    const geom = makePageGeometry({ view: [0, 0, 600, 800], rotate: 0 });
    const draw = viewRectToPdfDraw(geom, { x: 0.1, y: 0.25, width: 0.5, height: 0.125 });
    close([draw.x, draw.y, draw.width, draw.height, draw.rotateDeg], [60, 800 - 200 - 100, 300, 100, 0]);
  });
});

describe('viewRectToPdfRect / pdfRectToView', () => {
  const rect = { x: 0.2, y: 0.35, width: 0.4, height: 0.25 };

  it.each(CASES)('$name: the rectangle spans its two mapped corners', ({ geom }) => {
    const out = viewRectToPdfRect(geom, rect);
    const a = viewPointToPdf(geom, rect.x, rect.y);
    const b = viewPointToPdf(geom, rect.x + rect.width, rect.y + rect.height);
    close([out.x, out.y], [Math.min(a[0], b[0]), Math.min(a[1], b[1])]);
    close([out.width, out.height], [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it.each(CASES)('$name: PDF → view undoes view → PDF', ({ geom }) => {
    const back = pdfRectToView(geom, viewRectToPdfRect(geom, rect));
    close([back.x, back.y, back.width, back.height], [rect.x, rect.y, rect.width, rect.height]);
  });

  it('a text run near the bottom of an upright page shows near the bottom of the view', () => {
    const geom = makePageGeometry({ view: [0, 0, 600, 800], rotate: 0 });
    const view = pdfRectToView(geom, { x: 60, y: 80, width: 120, height: 40 });
    close([view.x, view.y, view.width, view.height], [0.1, 0.85, 0.2, 0.05]);
  });
});

describe('viewMarginsToCropBox', () => {
  const margins = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.05 };

  /** Which user-space edge each displayed edge is, per rotation. */
  function expectedCrop(rotate: PageRotation, [x1, y1, x2, y2]: number[]) {
    const w = x2 - x1, h = y2 - y1;
    const { top, right, bottom, left } = margins;
    switch (rotate) {
      case 0: return [x1 + left * w, y1 + bottom * h, w * (1 - left - right), h * (1 - top - bottom)];
      // Displayed top is the user-space left edge, displayed left is the bottom.
      case 90: return [x1 + top * w, y1 + left * h, w * (1 - top - bottom), h * (1 - left - right)];
      case 180: return [x1 + right * w, y1 + top * h, w * (1 - left - right), h * (1 - top - bottom)];
      case 270: return [x1 + bottom * w, y1 + right * h, w * (1 - top - bottom), h * (1 - left - right)];
    }
  }

  it.each(CASES)('$name: each margin trims the edge the user sees it on', ({ rotate, box, geom }) => {
    close(viewMarginsToCropBox(geom, margins), expectedCrop(rotate, box));
  });

  it.each(CASES)('$name: zero margins give back the visible box', ({ box, geom }) => {
    close(viewMarginsToCropBox(geom, { top: 0, right: 0, bottom: 0, left: 0 }), [
      box[0], box[1], box[2] - box[0], box[3] - box[1],
    ]);
  });

  it.each(CASES)('$name: margins that would invert the box leave a minimal one inside the page', ({ box, geom }) => {
    const [x, y, w, h] = viewMarginsToCropBox(geom, { top: 0.9, right: 0.8, bottom: 0.7, left: 0.6 });
    expect(w).toBeGreaterThanOrEqual(MIN_CROP_SIZE - 1e-6);
    expect(h).toBeGreaterThanOrEqual(MIN_CROP_SIZE - 1e-6);
    expect(x).toBeGreaterThanOrEqual(box[0] - 1e-6);
    expect(y).toBeGreaterThanOrEqual(box[1] - 1e-6);
    expect(x + w).toBeLessThanOrEqual(box[2] + 1e-6);
    expect(y + h).toBeLessThanOrEqual(box[3] + 1e-6);
  });

  it('ignores negative, oversized and non-numeric margins', () => {
    const geom = makePageGeometry({ view: [0, 0, 600, 800], rotate: 0 });
    close(viewMarginsToCropBox(geom, { top: -1, right: Number.NaN, bottom: 0, left: 0 }), [0, 0, 600, 800]);
    const [, , w] = viewMarginsToCropBox(geom, { top: 0, right: 0, bottom: 0, left: 5 });
    expect(w).toBeCloseTo(MIN_CROP_SIZE, 6);
  });
});
