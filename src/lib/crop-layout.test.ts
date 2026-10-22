import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { makePageGeometry, pdfPointToView } from './pdf/page-geometry';
import {
  contentBounds,
  cropBoxFor,
  cropTargets,
  formatLength,
  fromUnit,
  moveMargins,
  resizeMargins,
  snapToUnit,
  toUnit,
  type CropMargins,
} from './crop-layout';
import { writeCropBoxes } from './crop-write';

describe('units', () => {
  it('inches, millimetres and points round-trip exactly through the field', () => {
    for (const v of [0, 0.25, 0.5, 1, 1.37, 2.5, 11]) expect(toUnit(fromUnit(v, 'in'), 'in')).toBe(v);
    for (const v of [0, 1, 10, 12.7, 25.4, 40, 99.99]) expect(toUnit(fromUnit(v, 'mm'), 'mm')).toBe(v);
    for (const v of [0, 1, 36, 72.5, 300]) expect(toUnit(fromUnit(v, 'pt'), 'pt')).toBe(v);
    expect(fromUnit(1, 'in')).toBe(72);
    expect(fromUnit(25.4, 'mm')).toBeCloseTo(72, 10);
  });

  it('switching units never changes the held value; snapping is idempotent', () => {
    const held = fromUnit(10, 'mm');
    expect(toUnit(held, 'in')).toBe(0.39);
    expect(toUnit(held, 'pt')).toBe(28.35);
    expect(toUnit(held, 'mm')).toBe(10);
    for (const unit of ['mm', 'in', 'pt'] as const) {
      const s = snapToUnit(123.456789, unit);
      expect(snapToUnit(s, unit)).toBe(s);
      expect(fromUnit(toUnit(s, unit), unit)).toBe(s);
    }
  });

  it('formats the size readout per unit', () => {
    expect(formatLength(612, 'pt')).toBe('612');
    expect(formatLength(595.28, 'mm')).toBe('210');
    expect(formatLength(612, 'in')).toBe('8.5');
    expect(formatLength(-3, 'pt')).toBe('0');
  });
});

describe('dragging', () => {
  const page = { width: 600, height: 800 };
  const zero: CropMargins = { top: 0, right: 0, bottom: 0, left: 0 };

  it('moves only the named sides and keeps a minimum box', () => {
    expect(resizeMargins(zero, ['top'], 50, 40, page)).toEqual({ top: 40, right: 0, bottom: 0, left: 0 });
    expect(resizeMargins(zero, ['bottom', 'right'], -30, -20, page)).toEqual({ top: 0, right: 30, bottom: 20, left: 0 });
    expect(resizeMargins(zero, ['left'], 5000, 0, page).left).toBe(590);
    expect(resizeMargins(zero, ['top'], 0, -50, page).top).toBe(0);
  });

  it('slides the box without resizing and stops at the page edge', () => {
    const m = { top: 80, right: 80, bottom: 80, left: 80 };
    expect(moveMargins(m, 20, 30)).toEqual({ top: 110, right: 60, bottom: 50, left: 100 });
    expect(moveMargins(m, -2000, -2000)).toEqual({ top: 0, right: 160, bottom: 160, left: 0 });
  });
});

describe('which pages', () => {
  it('current is the page shown; range uses the shared parser', () => {
    expect(cropTargets('current', 2, '', 5)).toEqual([2]);
    expect(cropTargets('all', 0, '', 3)).toEqual([0, 1, 2]);
    expect(cropTargets('range', 0, '1-2, 5', 5)).toEqual([0, 1, 4]);
    expect(cropTargets('range', 0, 'odd', 5)).toEqual([0, 2, 4]);
    expect(cropTargets('range', 0, 'zz', 5)).toEqual([]);
    expect(cropTargets('current', 9, '', 3)).toEqual([2]);
  });
});

describe('auto-crop bounds', () => {
  it('finds the dark box with padding, ignores paper and transparency', () => {
    const w = 100;
    const h = 50;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 10; y < 20; y++) for (let x = 30; x < 60; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
    expect(contentBounds(data, w, h, 245, 0)).toEqual({ left: 0.3, top: 0.2, right: 0.4, bottom: 0.6 });
    expect(contentBounds(new Uint8ClampedArray(w * h * 4).fill(255), w, h)).toBeNull();
    expect(contentBounds(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
  });
});

/**
 * The crop box written into the file shows exactly the visual area the margins
 * leave: its corners, mapped back to the displayed page by the inverse geometry,
 * are the margins as fractions of the page — on every rotation, an offset crop
 * box and UserUnit.
 */
describe('crop box in the file', () => {
  const CASES = [
    { name: 'plain Letter', media: [0, 0, 612, 792], rotate: 0 },
    { name: '/Rotate 90', media: [0, 0, 612, 792], rotate: 90 },
    { name: '/Rotate 180', media: [0, 0, 612, 792], rotate: 180 },
    { name: '/Rotate 270', media: [0, 0, 612, 792], rotate: 270 },
    { name: 'offset crop box', media: [0, 0, 612, 792], crop: [50, 100, 562, 742], rotate: 0 },
    { name: 'offset crop box, /Rotate 90', media: [0, 0, 600, 800], crop: [50, 60, 550, 760], rotate: 90 },
    { name: 'UserUnit 2', media: [0, 0, 300, 400], rotate: 0, userUnit: 2 },
  ] as const;
  const margins: CropMargins = { top: 40, right: 25, bottom: 60, left: 10 };

  for (const c of CASES) {
    it(c.name, async () => {
      const doc = await PDFDocument.create();
      for (let i = 0; i < 2; i++) {
        const page = doc.addPage([c.media[2] - c.media[0], c.media[3] - c.media[1]]);
        if ('crop' in c) page.setCropBox(c.crop[0], c.crop[1], c.crop[2] - c.crop[0], c.crop[3] - c.crop[1]);
        page.setRotation(degrees(c.rotate));
        if ('userUnit' in c) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(c.userUnit));
      }
      const geom = makePageGeometry({ view: 'crop' in c ? c.crop : c.media, rotate: c.rotate, userUnit: 'userUnit' in c ? c.userUnit : 1 });
      writeCropBoxes(doc, [{ pageIndex: 1, geometry: geom }], margins);
      const reread = await PDFDocument.load(await doc.save());

      // Page 1 is not a target and keeps its box.
      const untouched = reread.getPage(0).getCropBox();
      const before = 'crop' in c ? c.crop : c.media;
      expect([untouched.x, untouched.y, untouched.x + untouched.width, untouched.y + untouched.height]).toEqual([...before]);

      const box = reread.getPage(1).getCropBox();
      const [ax, ay] = pdfPointToView(geom, box.x, box.y);
      const [bx, by] = pdfPointToView(geom, box.x + box.width, box.y + box.height);
      const view = { left: Math.min(ax, bx), right: Math.max(ax, bx), top: Math.min(ay, by), bottom: Math.max(ay, by) };
      expect(view.left).toBeCloseTo(margins.left / geom.widthPt, 9);
      expect(view.top).toBeCloseTo(margins.top / geom.heightPt, 9);
      expect(1 - view.right).toBeCloseTo(margins.right / geom.widthPt, 9);
      expect(1 - view.bottom).toBeCloseTo(margins.bottom / geom.heightPt, 9);
      expect(cropBoxFor(geom, margins)).toEqual([box.x, box.y, box.width, box.height]);
    });
  }

  it('/Rotate 90: the visual top comes off the stored left edge', () => {
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 90 });
    const [x, y, w, h] = cropBoxFor(geom, { top: 100, right: 0, bottom: 0, left: 0 });
    expect([x, y, w, h]).toEqual([100, 0, 512, 792]);
  });
});
