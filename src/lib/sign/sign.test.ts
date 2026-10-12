import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { makePageGeometry, viewRectToPdfDraw, pdfPointToView, type RectNorm } from '../pdf/page-geometry';
import {
  MM_PER_PT,
  applyMm,
  copyRectToPage,
  defaultStampRect,
  rectToMm,
  reshapeRect,
  type PageSize,
} from './placement';
import {
  DATE_BOX_HEIGHT_EM,
  HELVETICA_ASCENT,
  HELVETICA_DESCENT,
  dateBoxAspect,
  dateStampText,
  dateTextDraw,
  helveticaWidthEm,
  isPlainAscii,
  isoDate,
} from './date-text';
import { findInkBounds, hasTransparency, padBounds } from './ink-bounds';

const LETTER: PageSize = { widthPt: 612, heightPt: 792 };
const LANDSCAPE: PageSize = { widthPt: 792, heightPt: 612 };
const A5: PageSize = { widthPt: 420, heightPt: 595 };

const onPage = (r: RectNorm) =>
  r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9;

/** Width ÷ height of the box as it appears on screen. */
const shape = (r: RectNorm, page: PageSize) => (r.width * page.widthPt) / (r.height * page.heightPt);

describe('defaultStampRect', () => {
  it('makes a signature 35% of the page wide, in the lower middle, with its own shape', () => {
    const r = defaultStampRect('signature', 4, LETTER);
    expect(r.width).toBeCloseTo(0.35, 9);
    expect(shape(r, LETTER)).toBeCloseTo(4, 9);
    expect(r.x + r.width / 2).toBeCloseTo(0.5, 9);
    expect(r.y + r.height / 2).toBeCloseTo(0.7, 9);
    expect(onPage(r)).toBe(true);
  });

  it('never distorts: the box has the image shape on any page and for any image', () => {
    for (const page of [LETTER, LANDSCAPE, A5]) {
      for (const aspect of [0.4, 1, 2.5, 7, 20]) {
        for (const kind of ['signature', 'initials', 'date'] as const) {
          const r = defaultStampRect(kind, aspect, page);
          expect(shape(r, page)).toBeCloseTo(aspect, 6);
          expect(onPage(r)).toBe(true);
        }
      }
    }
  });

  it('shrinks a tall image instead of letting it cover the page', () => {
    const r = defaultStampRect('signature', 0.5, LETTER);
    expect(r.height).toBeCloseTo(0.2, 9);
    expect(r.width).toBeLessThan(0.35);
    expect(shape(r, LETTER)).toBeCloseTo(0.5, 9);
  });

  it('offsets each further stamp of a kind so none hides another', () => {
    const first = defaultStampRect('signature', 4, LETTER, 0);
    const second = defaultStampRect('signature', 4, LETTER, 1);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
    expect(second.width).toBeCloseTo(first.width, 9);
    // The offsets wrap rather than walking off the page.
    expect(defaultStampRect('signature', 4, LETTER, 5)).toEqual(first);
  });

  it('puts the three kinds in different places', () => {
    const sig = defaultStampRect('signature', 4, LETTER);
    const date = defaultStampRect('date', 5, LETTER);
    const initials = defaultStampRect('initials', 1.5, LETTER);
    expect(date.y).toBeGreaterThan(sig.y + sig.height);
    expect(initials.x).toBeGreaterThan(sig.x + sig.width);
  });

  it('falls back to a square for a nonsense aspect', () => {
    expect(shape(defaultStampRect('signature', 0, LETTER), LETTER)).toBeCloseTo(1, 9);
    expect(shape(defaultStampRect('signature', Number.NaN, LETTER), LETTER)).toBeCloseTo(1, 9);
  });
});

describe('reshapeRect', () => {
  it('takes the new shape, keeping the width and the centre', () => {
    const before = defaultStampRect('signature', 4, LETTER);
    const after = reshapeRect(before, 2, LETTER);
    expect(after.width).toBeCloseTo(before.width, 9);
    expect(shape(after, LETTER)).toBeCloseTo(2, 9);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 9);
  });
});

describe('copyRectToPage', () => {
  const rect: RectNorm = { x: 0.2, y: 0.7, width: 0.35, height: 0.07 };

  it('is the identical box on a page of the same size', () => {
    const copy = copyRectToPage(rect, LETTER, LETTER);
    expect(copy.x).toBeCloseTo(rect.x, 9);
    expect(copy.y).toBeCloseTo(rect.y, 9);
    expect(copy.width).toBeCloseTo(rect.width, 9);
    expect(copy.height).toBeCloseTo(rect.height, 9);
  });

  it('keeps the size and the distance from the left and bottom edges on a different page', () => {
    const copy = copyRectToPage(rect, LETTER, LANDSCAPE);
    expect(copy.width * LANDSCAPE.widthPt).toBeCloseTo(rect.width * LETTER.widthPt, 6);
    expect(copy.height * LANDSCAPE.heightPt).toBeCloseTo(rect.height * LETTER.heightPt, 6);
    expect(copy.x * LANDSCAPE.widthPt).toBeCloseTo(rect.x * LETTER.widthPt, 6);
    expect((1 - copy.y - copy.height) * LANDSCAPE.heightPt).toBeCloseTo((1 - rect.y - rect.height) * LETTER.heightPt, 6);
  });

  it('shrinks and moves the stamp onto a page that is too small for it', () => {
    const wide: RectNorm = { x: 0.5, y: 0.05, width: 0.5, height: 0.1 };
    const copy = copyRectToPage(wide, LANDSCAPE, { widthPt: 200, heightPt: 300 });
    expect(onPage(copy)).toBe(true);
    expect(shape(copy, { widthPt: 200, heightPt: 300 })).toBeCloseTo(shape(wide, LANDSCAPE), 6);
  });
});

describe('rectToMm / applyMm', () => {
  const rect: RectNorm = { x: 0.25, y: 0.5, width: 0.5, height: 0.1 };

  it('reads the box in millimetres from the left and top edges', () => {
    const mm = rectToMm(rect, LETTER);
    expect(mm.x).toBeCloseTo(153 * MM_PER_PT, 9); // 53.98 mm
    expect(mm.y).toBeCloseTo(396 * MM_PER_PT, 9);
    expect(mm.width).toBeCloseTo(306 * MM_PER_PT, 9);
  });

  it('round-trips an unchanged value', () => {
    const mm = rectToMm(rect, LETTER);
    const back = applyMm(rect, LETTER, mm);
    expect(back.x).toBeCloseTo(rect.x, 9);
    expect(back.y).toBeCloseTo(rect.y, 9);
    expect(back.width).toBeCloseTo(rect.width, 9);
    expect(back.height).toBeCloseTo(rect.height, 9);
  });

  it('moves by X and Y and keeps the box on the page', () => {
    expect(applyMm(rect, LETTER, { x: 10 }).x).toBeCloseTo(10 / MM_PER_PT / 612, 9);
    expect(applyMm(rect, LETTER, { y: 20 }).y).toBeCloseTo(20 / MM_PER_PT / 792, 9);
    expect(onPage(applyMm(rect, LETTER, { x: 9999, y: 9999 }))).toBe(true);
    expect(applyMm(rect, LETTER, { x: -5 }).x).toBe(0);
  });

  it('a new width keeps the top-left corner and the shape', () => {
    const next = applyMm(rect, LETTER, { width: 50 });
    expect(next.x).toBeCloseTo(rect.x, 9);
    expect(next.y).toBeCloseTo(rect.y, 9);
    expect(next.width * 612 * MM_PER_PT).toBeCloseTo(50, 6);
    expect(shape(next, LETTER)).toBeCloseTo(shape(rect, LETTER), 9);
  });

  it('clamps the width to the page and to the minimum, and ignores nonsense', () => {
    expect(applyMm(rect, LETTER, { width: 99999 }).width).toBeCloseTo(1, 9);
    expect(applyMm(rect, LETTER, { width: 0 }).width).toBeCloseTo(0.03, 9);
    expect(applyMm(rect, LETTER, { width: Number.NaN, x: Number.NaN })).toEqual(rect);
  });
});

describe('date text', () => {
  it('writes ISO dates with zero padding', () => {
    expect(isoDate(new Date(2026, 2, 9))).toBe('2026-03-09');
    expect(isoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('uses the locale format when it is plain ASCII', () => {
    const d = new Date(2026, 2, 9);
    expect(dateStampText(d, 'en-US')).toBe('3/9/2026');
    expect(dateStampText(d, 'en-GB')).toBe('09/03/2026');
    expect(dateStampText(d, 'de-DE')).toBe('9.3.2026');
  });

  it('falls back to ISO for locales Helvetica cannot draw', () => {
    const d = new Date(2026, 2, 9);
    for (const locale of ['ar-EG', 'fa-IR', 'th-TH-u-nu-thai', 'bn-BD', 'mr-IN-u-nu-deva', 'ja-JP-u-ca-japanese']) {
      const text = dateStampText(d, locale);
      expect(isPlainAscii(text), `${locale} → ${text}`).toBe(true);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(dateStampText(d, 'ar-EG')).toBe('2026-03-09');
  });

  it('does not throw on an unknown locale tag', () => {
    expect(dateStampText(new Date(2026, 2, 9), 'not a locale')).toBe('2026-03-09');
  });

  it('always returns something pdf-lib can draw in Helvetica', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const d = new Date(2026, 2, 9);
    for (const locale of ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ar-EG', 'fa-IR', 'hi-IN', 'zh-CN', 'ko-KR', 'ru-RU']) {
      expect(() => font.widthOfTextAtSize(dateStampText(d, locale), 12)).not.toThrow();
    }
  });

  it('measures exactly what pdf-lib measures, for every printable ASCII character', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let code = 32; code <= 126; code++) {
      const ch = String.fromCharCode(code);
      expect(helveticaWidthEm(ch) * 1000, `width of ${JSON.stringify(ch)}`).toBeCloseTo(
        font.widthOfTextAtSize(ch, 1000),
        6,
      );
    }
    for (const text of ['09/03/2026', '2026-03-09', '9.3.2026', 'Mar 9, 2026']) {
      expect(helveticaWidthEm(text) * 12).toBeCloseTo(font.widthOfTextAtSize(text, 12), 6);
    }
  });

  it('the box is as tall as the font from ascender to descender', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(DATE_BOX_HEIGHT_EM).toBeCloseTo((HELVETICA_ASCENT + HELVETICA_DESCENT) / 1000, 9);
    // pdf-lib's own line height for the font (with descender) is the same box.
    expect(font.heightAtSize(1000, { descender: true })).toBeCloseTo(DATE_BOX_HEIGHT_EM * 1000, 0);
    expect(dateBoxAspect('2026-03-09')).toBeCloseTo(helveticaWidthEm('2026-03-09') / DATE_BOX_HEIGHT_EM, 9);
  });
});

describe('dateTextDraw: the drawn text fills the box shown on screen', () => {
  const text = '09/03/2026';

  /**
   * For a date box on a page, work out where pdf-lib will draw the text and map
   * the text's own corners (baseline start, baseline end, ascender, descender)
   * back to the view. They must coincide with the box that was on screen.
   */
  function check(source: { view: number[]; rotate: number; userUnit?: number }) {
    const geom = makePageGeometry(source);
    const rect = defaultStampRect('date', dateBoxAspect(text), geom);
    const draw = viewRectToPdfDraw(geom, rect, 0);
    const t = dateTextDraw(draw);

    // The text's frame in user space: `along` is the writing direction, `up` is
    // towards the ascenders; pdf-lib turns both counter-clockwise by rotateDeg.
    const a = (t.rotateDeg * Math.PI) / 180;
    const along: [number, number] = [Math.cos(a), Math.sin(a)];
    const up: [number, number] = [-Math.sin(a), Math.cos(a)];
    const at = (dAlong: number, dUp: number): [number, number] =>
      pdfPointToView(geom, t.x + along[0] * dAlong + up[0] * dUp, t.y + along[1] * dAlong + up[1] * dUp);

    const width = helveticaWidthEm(text) * t.size;
    const ascent = (HELVETICA_ASCENT / 1000) * t.size;
    const descent = (HELVETICA_DESCENT / 1000) * t.size;

    const [left, bottom] = at(0, -descent);
    const [right, top] = at(width, ascent);
    expect(left).toBeCloseTo(rect.x, 6);
    expect(right).toBeCloseTo(rect.x + rect.width, 6);
    expect(top).toBeCloseTo(rect.y, 6);
    expect(bottom).toBeCloseTo(rect.y + rect.height, 6);
  }

  it('on an upright page', () => check({ view: [0, 0, 612, 792], rotate: 0 }));
  it('on /Rotate 90, 180 and 270 pages', () => {
    check({ view: [0, 0, 612, 792], rotate: 90 });
    check({ view: [0, 0, 612, 792], rotate: 180 });
    check({ view: [0, 0, 612, 792], rotate: 270 });
  });
  it('on a page whose visible box does not start at the origin', () => {
    check({ view: [50, 100, 562, 692], rotate: 0 });
    check({ view: [-20, 30, 400, 630], rotate: 90 });
  });
  it('on a page with a UserUnit', () => check({ view: [0, 0, 612, 792], rotate: 0, userUnit: 2 }));
});

/** RGBA pixels for a `width` × `height` image filled with one colour. */
function pixels(width: number, height: number, fill: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return data;
}

function paint(data: Uint8ClampedArray, width: number, x0: number, y0: number, w: number, h: number, fill: number[]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) data.set(fill, (y * width + x) * 4);
  }
}

describe('ink bounds', () => {
  it('finds the strokes on a transparent pad', () => {
    const data = pixels(40, 20, [0, 0, 0, 0]);
    paint(data, 40, 7, 4, 12, 9, [0, 0, 0, 255]);
    expect(hasTransparency(data)).toBe(true);
    expect(findInkBounds(data, 40, 20)).toEqual({ x: 7, y: 4, width: 12, height: 9 });
  });

  it('ignores almost-transparent smudges', () => {
    const data = pixels(20, 20, [0, 0, 0, 0]);
    paint(data, 20, 0, 0, 20, 1, [0, 0, 0, 5]);
    paint(data, 20, 10, 10, 2, 2, [20, 20, 120, 200]);
    expect(findInkBounds(data, 20, 20)).toEqual({ x: 10, y: 10, width: 2, height: 2 });
  });

  it('returns null for a blank pad', () => {
    expect(findInkBounds(pixels(10, 10, [0, 0, 0, 0]), 10, 10)).toBeNull();
  });

  it('treats white as background on an image with no transparency', () => {
    const data = pixels(30, 30, [255, 255, 255, 255]);
    paint(data, 30, 5, 6, 10, 3, [10, 10, 80, 255]);
    paint(data, 30, 20, 20, 4, 4, [246, 250, 252, 255]); // paper noise, still background
    expect(hasTransparency(data)).toBe(false);
    expect(findInkBounds(data, 30, 30)).toEqual({ x: 5, y: 6, width: 10, height: 3 });
  });

  it('keeps white ink when the image is transparent', () => {
    const data = pixels(10, 10, [0, 0, 0, 0]);
    paint(data, 10, 2, 2, 3, 3, [255, 255, 255, 255]);
    expect(findInkBounds(data, 10, 10)).toEqual({ x: 2, y: 2, width: 3, height: 3 });
  });

  it('returns null for a plain white image', () => {
    expect(findInkBounds(pixels(8, 8, [255, 255, 255, 255]), 8, 8)).toBeNull();
  });

  it('pads the bounds without leaving the image', () => {
    expect(padBounds({ x: 7, y: 4, width: 12, height: 9 }, 2, 40, 20)).toEqual({ x: 5, y: 2, width: 16, height: 13 });
    expect(padBounds({ x: 1, y: 0, width: 38, height: 20 }, 4, 40, 20)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });
});
