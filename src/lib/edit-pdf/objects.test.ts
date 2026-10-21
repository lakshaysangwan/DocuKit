import { describe, it, expect } from 'vitest';
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  MM_PER_PT,
  applyBoxMm,
  clampFontSize,
  defaultFontSize,
  dragCorner,
  fitText,
  lineEndsPt,
  newDrawing,
  newImage,
  newObject,
  rectToBoxMm,
  scaleObject,
  stampAspect,
  textSizePt,
  withFontSize,
  withRect,
  type EditObject,
  type TextObject,
} from './objects';
import { helveticaWidthEm } from '../sign/date-text';

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const LANDSCAPE = { widthPt: 841.89, heightPt: 595.28 };
const POSTER = { widthPt: 1684, heightPt: 2384 };
const opts = (page = A4) => ({ id: 'a', pageIndex: 0, page });

/** Width ÷ height of a box on screen, in points. */
const shape = (o: EditObject, page = A4) => (o.rect.width * page.widthPt) / (o.rect.height * page.heightPt);

describe('font size', () => {
  it('is clamped to 6–144 pt', () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(500)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(Number.NaN)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(18)).toBe(18);
  });

  it('defaults to body text for the page: 16 pt on A4, larger on a poster, never below the minimum', () => {
    expect(defaultFontSize(A4)).toBe(16);
    expect(defaultFontSize(POSTER)).toBeGreaterThan(40);
    expect(defaultFontSize({ widthPt: 100, heightPt: 100 })).toBe(MIN_FONT_SIZE);
  });
});

describe('new objects are sized for the page, centred and in view', () => {
  it('text hugs its words at the default font size', () => {
    const t = newObject('text', opts()) as TextObject;
    expect(t.fontSize).toBe(16);
    expect(t.rect.width * A4.widthPt).toBeCloseTo(helveticaWidthEm('Text') * 16, 6);
    expect(t.rect.height * A4.heightPt).toBeCloseTo(1.2 * 16, 6);
    expect(t.rect.x + t.rect.width / 2).toBeCloseTo(0.5, 6);
  });

  it('shapes are a fraction of the page wide, whatever its size', () => {
    for (const page of [A4, LANDSCAPE, POSTER]) {
      const r = newObject('rect', opts(page));
      expect(r.rect.width).toBeCloseTo(0.3, 6);
      expect(shape(r, page)).toBeCloseTo(1.5, 6);
      expect(r.lockAspect).toBe(false);
    }
  });

  it('a picture keeps its proportions and is never more than 40% of the page either way', () => {
    const wide = newImage({ ...opts(), src: 'data:', mime: 'image/png', pixelWidth: 1200, pixelHeight: 600 });
    expect(wide.rect.width).toBeCloseTo(0.4, 6);
    expect(shape(wide)).toBeCloseTo(2, 6);
    expect(wide.lockAspect).toBe(true);
    const tall = newImage({ ...opts(), src: 'data:', mime: 'image/png', pixelWidth: 300, pixelHeight: 3000 });
    expect(tall.rect.height).toBeCloseTo(0.4, 6);
    expect(shape(tall)).toBeCloseTo(0.1, 6);
  });

  it('a stamp is as wide as its word needs', () => {
    const s = newObject('stamp', { ...opts(), stampLabel: 'CONFIDENTIAL' });
    expect(shape(s)).toBeCloseTo(stampAspect('CONFIDENTIAL'), 6);
  });

  it('each further object of a kind is offset so it does not hide the last', () => {
    const first = newObject('rect', opts());
    const second = newObject('rect', { ...opts(), alreadyThere: 1 });
    expect(second.rect.x).toBeGreaterThan(first.rect.x);
    expect(second.rect.y).toBeGreaterThan(first.rect.y);
  });
});

describe('resizing', () => {
  it('pulling a text box wider makes the font larger by the same factor', () => {
    const t = newObject('text', opts()) as TextObject;
    const bigger = withRect(t, { ...t.rect, width: t.rect.width * 2, height: t.rect.height * 2 }, A4) as TextObject;
    expect(bigger.fontSize).toBeCloseTo(32, 6);
    expect(bigger.rect.width).toBeCloseTo(t.rect.width * 2, 6);
    expect(bigger.rect.height).toBeCloseTo(t.rect.height * 2, 6);
  });

  it('a corner drag resizes a shape freely and a picture in proportion', () => {
    const r = newObject('rect', opts());
    const dragged = dragCorner(r, 'bottom-right', 0.1, 0.02, A4);
    expect(dragged.rect.width).toBeCloseTo(r.rect.width + 0.1, 6);
    expect(dragged.rect.height).toBeCloseTo(r.rect.height + 0.02, 6);
    const img = newImage({ ...opts(), src: 'data:', mime: 'image/png', pixelWidth: 400, pixelHeight: 200 });
    expect(shape(dragCorner(img, 'bottom-right', 0.1, 0.02, A4))).toBeCloseTo(2, 6);
  });

  it('Smaller and Larger keep the centre; text changes its font size', () => {
    const t = newObject('text', opts()) as TextObject;
    const larger = scaleObject(t, 1.1, A4) as TextObject;
    expect(larger.fontSize).toBeCloseTo(17.6, 6);
    expect(larger.rect.x + larger.rect.width / 2).toBeCloseTo(t.rect.x + t.rect.width / 2, 6);
    const r = newObject('ellipse', opts());
    const smaller = scaleObject(r, 1 / 1.1, A4);
    expect(smaller.rect.width).toBeCloseTo(r.rect.width / 1.1, 6);
  });

  it('a font size is applied within its bounds and the box follows', () => {
    const t = newObject('text', opts()) as TextObject;
    expect(withFontSize(t, 300, A4).fontSize).toBe(MAX_FONT_SIZE);
    const at30 = withFontSize(t, 30, A4);
    expect(at30.rect.width * A4.widthPt).toBeCloseTo(helveticaWidthEm('Text') * 30, 6);
    expect(at30.rect.x).toBeCloseTo(t.rect.x, 6);
  });

  it('text too long for the page gets a smaller font instead of running off it', () => {
    const t = { ...(newObject('text', opts()) as TextObject), text: 'W'.repeat(80), fontSize: 40 };
    const fitted = fitText(t, A4);
    expect(fitted.rect.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(fitted.fontSize).toBeLessThan(40);
    expect(textSizePt(fitted.text, fitted.fontSize).width).toBeCloseTo(fitted.rect.width * A4.widthPt, 6);
  });
});

describe('millimetre fields', () => {
  it('read the box back in millimetres', () => {
    const mm = rectToBoxMm({ x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, A4);
    expect(mm.width).toBeCloseTo(0.5 * A4.widthPt * MM_PER_PT, 6);
    expect(mm.height).toBeCloseTo(0.25 * A4.heightPt * MM_PER_PT, 6);
  });

  it('width alone with proportions free; both sides with them kept', () => {
    const r = newObject('rect', opts());
    const free = applyBoxMm(r, { width: 100 }, A4);
    expect(rectToBoxMm(free.rect, A4).width).toBeCloseTo(100, 6);
    expect(free.rect.height).toBeCloseTo(r.rect.height, 6);
    const locked = applyBoxMm({ ...r, lockAspect: true }, { width: 100 }, A4);
    expect(shape(locked)).toBeCloseTo(shape(r), 6);
    const tall = applyBoxMm(r, { height: 80 }, A4);
    expect(rectToBoxMm(tall.rect, A4).height).toBeCloseTo(80, 6);
    expect(tall.rect.width).toBeCloseTo(r.rect.width, 6);
  });

  it('a text width in mm becomes a font size', () => {
    const t = newObject('text', opts()) as TextObject;
    const widthMm = rectToBoxMm(t.rect, A4).width;
    const doubled = applyBoxMm(t, { width: widthMm * 2 }, A4) as TextObject;
    expect(doubled.fontSize).toBeCloseTo(32, 4);
  });

  it('X and Y place the top-left corner and keep it on the page', () => {
    const r = newObject('rect', opts());
    const moved = applyBoxMm(r, { x: 20, y: 30 }, A4);
    expect(rectToBoxMm(moved.rect, A4).x).toBeCloseTo(20, 6);
    expect(rectToBoxMm(moved.rect, A4).y).toBeCloseTo(30, 6);
    const off = applyBoxMm(r, { x: 5000 }, A4);
    expect(off.rect.x + off.rect.width).toBeCloseTo(1, 6);
  });

  it('never smaller than 1 mm, never larger than the page', () => {
    const r = newObject('rect', opts());
    expect(rectToBoxMm(applyBoxMm(r, { width: 0 }, A4).rect, A4).width).toBeCloseTo(1, 6);
    expect(applyBoxMm(r, { width: 9999 }, A4).rect.width).toBeLessThanOrEqual(1);
  });
});

describe('freehand drawing and lines', () => {
  it('a stroke becomes a box padded by half the line width, its points fractions of that box', () => {
    const d = newDrawing(
      [
        [0.2, 0.3],
        [0.4, 0.35],
        [0.5, 0.5],
      ],
      { ...opts(), strokeWidth: 4 },
    )!;
    expect(d.rect.x).toBeCloseTo(0.2 - 2 / A4.widthPt, 6);
    expect(d.rect.y + d.rect.height).toBeCloseTo(0.5 + 2 / A4.heightPt, 6);
    for (const [x, y] of d.points) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
    }
    expect(newDrawing([[0.1, 0.1]], opts())).toBeNull();
  });

  it('a line ends half its width in from the edges it touches', () => {
    const l = { ...newObject('arrow', opts()), strokeWidth: 4 } as EditObject & { kind: 'arrow' };
    expect(lineEndsPt(l, 100, 20)).toEqual([2, 10, 98, 10]);
    expect(lineEndsPt({ ...l, direction: 'up-left' }, 100, 20)).toEqual([98, 18, 2, 2]);
  });
});
