import { describe, it, expect } from 'vitest';
import { makePageGeometry, viewRectToPdfRect } from './page-geometry';
import {
  DEFAULT_BOX,
  MIN_BOX_WIDTH,
  applyBoxMm,
  boxDate,
  boxToMm,
  defaultSignatureRect,
  moveBoxToPage,
  signatureBoxLines,
  signatureTextLayout,
  signatureWidgetPlacement,
  toWinAnsi,
} from './signature-box';

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const LETTER_LANDSCAPE = { widthPt: 792, heightPt: 612 };

describe('defaultSignatureRect', () => {
  it('is the old fixed spot: 250 × 60 pt, 20 pt in from the bottom-right corner', () => {
    const r = defaultSignatureRect(A4);
    expect(r.width * A4.widthPt).toBeCloseTo(DEFAULT_BOX.widthPt, 6);
    expect(r.height * A4.heightPt).toBeCloseTo(DEFAULT_BOX.heightPt, 6);
    expect((1 - r.x - r.width) * A4.widthPt).toBeCloseTo(20, 6);
    expect((1 - r.y - r.height) * A4.heightPt).toBeCloseTo(20, 6);
  });

  it('on a plain page it lands exactly where the fixed box used to be drawn', () => {
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 0 });
    const pdf = viewRectToPdfRect(geom, defaultSignatureRect(geom));
    expect(pdf.x).toBeCloseTo(612 - 250 - 20, 6);
    expect(pdf.y).toBeCloseTo(20, 6);
    expect(pdf.width).toBeCloseTo(250, 6);
    expect(pdf.height).toBeCloseTo(60, 6);
  });

  it('stays on a page smaller than the box', () => {
    const r = defaultSignatureRect({ widthPt: 200, heightPt: 100 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('moveBoxToPage', () => {
  it('keeps the physical size and the distance from the right and bottom edges', () => {
    const from = defaultSignatureRect(A4);
    const to = moveBoxToPage(from, A4, LETTER_LANDSCAPE);
    expect(to.width * LETTER_LANDSCAPE.widthPt).toBeCloseTo(250, 6);
    expect(to.height * LETTER_LANDSCAPE.heightPt).toBeCloseTo(60, 6);
    expect((1 - to.x - to.width) * LETTER_LANDSCAPE.widthPt).toBeCloseTo(20, 6);
    expect((1 - to.y - to.height) * LETTER_LANDSCAPE.heightPt).toBeCloseTo(20, 6);
  });

  it('is the identity between pages of the same size', () => {
    const r = { x: 0.2, y: 0.3, width: 0.4, height: 0.1 };
    const to = moveBoxToPage(r, A4, A4);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(to[k]).toBeCloseTo(r[k], 9);
  });
});

describe('millimetre fields', () => {
  it('round-trips', () => {
    const r = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
    const mm = boxToMm(r, A4);
    const back = applyBoxMm({ x: 0, y: 0, width: 0.5, height: 0.5 }, A4, mm);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(back[k]).toBeCloseTo(r[k], 9);
  });

  it('A4 is 210 × 297 mm', () => {
    const mm = boxToMm({ x: 0, y: 0, width: 1, height: 1 }, A4);
    expect(mm.width).toBeCloseTo(210, 0);
    expect(mm.height).toBeCloseTo(297, 0);
  });

  it('keeps the box on the page and above the minimum size', () => {
    const r = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };
    const far = applyBoxMm(r, A4, { x: 500, y: 900 });
    expect(far.x + far.width).toBeCloseTo(1, 9);
    expect(far.y + far.height).toBeCloseTo(1, 9);
    const tiny = applyBoxMm(r, A4, { width: 0 });
    expect(tiny.width).toBe(MIN_BOX_WIDTH);
    const nan = applyBoxMm(r, A4, { x: Number.NaN });
    expect(nan.x).toBe(r.x);
  });
});

describe('box text', () => {
  it('says who signed, the UTC date and the algorithm', () => {
    const lines = signatureBoxLines('Ada Lovelace', new Date('2026-10-23T23:30:00Z'));
    expect(lines).toEqual([
      'Digitally signed by: Ada Lovelace',
      'Date: 2026-10-23',
      'Algorithm: RSA-SHA256 (PKCS#7)',
    ]);
    expect(boxDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
  });

  it('replaces what Helvetica cannot show, and keeps Latin-1 and WinAnsi extras', () => {
    expect(toWinAnsi('José Müller – €5')).toBe('José Müller – €5');
    expect(toWinAnsi('山田 Taro')).toBe('?? Taro');
    expect(toWinAnsi('a\u0001b')).toBe('a?b');
  });

  it('lays out the original design in the original box', () => {
    // 250 × 60 with a longest line of about 120 pt at 7 pt: height-limited, 7 pt.
    const layout = signatureTextLayout(250, 60, 120 / 7);
    expect(layout.fontSize).toBeCloseTo(7, 6);
    expect(layout.x).toBeCloseTo(6, 6);
    expect(layout.baselines[1] - layout.baselines[0]).toBeCloseTo(16, 6);
    // Centred: as much room above the cap height of line 1 as below the last baseline.
    const top = layout.baselines[0] - 0.718 * 7;
    expect(60 - layout.baselines[2]).toBeCloseTo(top, 6);
  });

  it('scales with the box, and shrinks to fit a narrow box', () => {
    expect(signatureTextLayout(500, 120, 120 / 7).fontSize).toBeCloseTo(14, 6);
    const narrow = signatureTextLayout(60, 60, 120 / 7);
    expect(narrow.fontSize).toBeLessThan(7);
    expect(narrow.x * 2 + narrow.fontSize * (120 / 7)).toBeCloseTo(60, 6);
  });
});

describe('signatureWidgetPlacement', () => {
  const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.1 };

  it.each([0, 90, 180, 270] as const)('/Rotate %i: the Rect is the view box and the matrix turns the drawing upright', (rotate) => {
    const geom = makePageGeometry({ view: [30, 40, 430, 640], rotate });
    const p = signatureWidgetPlacement(geom, rect);
    expect(p.rect).toEqual(viewRectToPdfRect(geom, rect));
    // The appearance is the size of the box as seen.
    expect(p.width).toBeCloseTo(rect.width * geom.widthPt, 9);
    expect(p.height).toBeCloseTo(rect.height * geom.heightPt, 9);
    // The drawing's x axis (along the text) must point to the right of the
    // DISPLAYED page, and its y axis (up the letters) up the displayed page.
    const [a, b, c, d] = p.matrix;
    const origin = geom.inverseMatrix;
    const toView = (x: number, y: number) => [origin[0] * x + origin[2] * y, origin[1] * x + origin[3] * y];
    const along = toView(a, b);
    const up = toView(c, d);
    expect(Math.sign(Math.round(along[0] * 1e6))).toBe(1);
    expect(Math.abs(along[1])).toBeLessThan(1e-9);
    expect(Math.abs(up[0])).toBeLessThan(1e-9);
    expect(Math.sign(Math.round(up[1] * 1e6))).toBe(-1);
  });

  it('divides by UserUnit', () => {
    const geom = makePageGeometry({ view: [0, 0, 400, 600], rotate: 0, userUnit: 2 });
    const p = signatureWidgetPlacement(geom, rect);
    expect(p.width).toBeCloseTo(0.4 * 400, 9);
    expect(p.rect.width).toBeCloseTo(0.4 * 400, 9);
  });
});
