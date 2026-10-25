import { describe, expect, it } from 'vitest';
import { makePageGeometry, viewRectToPdfRect } from '../pdf/page-geometry';
import {
  applyMarkMm,
  defaultMarkRect,
  markRectToMm,
  markToJob,
  marksPerPage,
  rectContains,
  rectFromPoints,
  runMatches,
  pdfRectToViewRect,
  textRunViewCentre,
  MM_PER_PT,
} from './marks';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('rectFromPoints', () => {
  it('orders the corners whichever way the drag went', () => {
    const r = rectFromPoints({ x: 0.6, y: 0.4 }, { x: 0.2, y: 0.1 })!;
    close(r.x, 0.2);
    close(r.y, 0.1);
    close(r.width, 0.4);
    close(r.height, 0.3);
  });

  it('cuts the rectangle to the page', () => {
    const r = rectFromPoints({ x: -0.2, y: 0.5 }, { x: 0.3, y: 1.4 })!;
    expect(r.x).toBe(0);
    close(r.width, 0.3);
    close(r.y + r.height, 1);
  });

  it('ignores a click or a sliver', () => {
    expect(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.6 })).toBeNull();
    expect(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.501 })).toBeNull();
  });
});

describe('defaultMarkRect', () => {
  it('stays on the page and steps down for each mark already there', () => {
    const first = defaultMarkRect(0);
    const second = defaultMarkRect(1);
    expect(second.y).toBeGreaterThan(first.y);
    for (const r of [first, second, defaultMarkRect(5)]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y + r.height).toBeLessThanOrEqual(1);
    }
  });
});

describe('pdfRectToViewRect', () => {
  it('is the box a user-space rectangle is on a plain page', () => {
    const geom = makePageGeometry({ view: [0, 0, 600, 800], rotate: 0 });
    const r = pdfRectToViewRect(geom, { x: 100, y: 697, width: 60, height: 18 });
    close(r.x, 100 / 600);
    close(r.width, 60 / 600);
    close(r.y, (800 - 715) / 800);
    close(r.height, 18 / 800);
  });

  it('turns with a /Rotate 90 page', () => {
    // Displayed 792 wide × 612 tall: user-space x runs down the displayed page, y runs right.
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 90 });
    const r = pdfRectToViewRect(geom, { x: 30, y: 54, width: 36, height: 212 });
    close(r.x, 54 / 792);
    close(r.width, 212 / 792);
    close(r.y, 30 / 612);
    close(r.height, 36 / 612);
  });

  it('maps through the crop box origin on an offset page', () => {
    const geom = makePageGeometry({ view: [50, 100, 562, 742], rotate: 0 });
    const r = pdfRectToViewRect(geom, { x: 84, y: 674, width: 162, height: 36 });
    close(r.x, (84 - 50) / 512);
    close(r.y, (742 - 710) / 642);
  });

  it('round-trips with viewRectToPdfRect on every page kind', () => {
    const rect = { x: 300, y: 400, width: 40, height: 10 };
    for (const geom of [
      makePageGeometry({ view: [0, 0, 612, 792], rotate: 270, userUnit: 2 }),
      makePageGeometry({ view: [0, 0, 612, 792], rotate: 180 }),
      makePageGeometry({ view: [50, 100, 562, 742], rotate: 90 }),
    ]) {
      const back = viewRectToPdfRect(geom, pdfRectToViewRect(geom, rect));
      for (const k of ['x', 'y', 'width', 'height'] as const) close(back[k], rect[k], 1e-6);
    }
  });

  it('keeps the box on the page', () => {
    const geom = makePageGeometry({ view: [0, 0, 600, 800], rotate: 0 });
    const r = pdfRectToViewRect(geom, { x: -10, y: 790, width: 50, height: 30 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('textRunViewCentre and rectContains', () => {
  it('finds a run inside the mark that covers it and outside one beside it', () => {
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 90 });
    const run = { str: 'Sign here:', transform: [0, 14, -14, 0, 500, 300], width: 70, height: 14 };
    // The run's own box in user space: it reads along y from (500, 300), its height to the left.
    const box = pdfRectToViewRect(geom, { x: 486, y: 300, width: 14, height: 70 });
    const centre = textRunViewCentre(geom, run);
    expect(rectContains(box, centre)).toBe(true);
    expect(rectContains({ ...box, x: box.x + box.width + 0.01 }, centre)).toBe(false);
  });
});

describe('runMatches', () => {
  it('matches case-insensitively and never on an empty phrase', () => {
    expect(runMatches('Test Document — Page 1', 'test document')).toBe(true);
    expect(runMatches('Test Document', '  ')).toBe(false);
    expect(runMatches('abc', 'abd')).toBe(false);
  });
});

describe('markToJob', () => {
  it('hands the engine the user-space rectangle of the area shown, on every page kind', () => {
    const cases = [
      makePageGeometry({ view: [0, 0, 612, 792], rotate: 0 }),
      makePageGeometry({ view: [0, 0, 612, 792], rotate: 90 }),
      makePageGeometry({ view: [50, 100, 562, 742], rotate: 0 }),
      makePageGeometry({ view: [0, 0, 300, 400], rotate: 180, userUnit: 3 }),
    ];
    const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
    for (const geom of cases) {
      const job = markToJob({ id: 'a', pageIndex: 2, rect }, geom);
      expect(job.pageIndex).toBe(2);
      expect(job.view).toEqual(rect);
      expect(job.pdf).toEqual(viewRectToPdfRect(geom, rect));
    }
    // On the rotated page the displayed width runs along user-space y.
    const rotated = markToJob({ id: 'a', pageIndex: 0, rect }, cases[1]).pdf;
    close(rotated.height, 0.3 * 792);
    close(rotated.width, 0.05 * 612);
    // The offset page keeps the crop box origin.
    const offset = markToJob({ id: 'a', pageIndex: 0, rect }, cases[2]).pdf;
    close(offset.x, 50 + 0.1 * 512);
  });
});

describe('millimetre fields', () => {
  const page = { widthPt: 612, heightPt: 792 };

  it('reads a mark in millimetres of the displayed page', () => {
    const mm = markRectToMm({ x: 0.5, y: 0.25, width: 0.1, height: 0.02 }, page);
    close(mm.x, 306 * MM_PER_PT);
    close(mm.y, 198 * MM_PER_PT);
    close(mm.height, 0.02 * 792 * MM_PER_PT);
  });

  it('sets width and height independently and keeps the mark on the page', () => {
    const start = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
    const wider = applyMarkMm(start, page, { width: 100 });
    close(wider.width, 100 / MM_PER_PT / 612);
    expect(wider.height).toBe(start.height);
    const taller = applyMarkMm(start, page, { height: 30 });
    close(taller.height, 30 / MM_PER_PT / 792);
    expect(taller.width).toBe(start.width);
    const offPage = applyMarkMm(start, page, { x: 1000 });
    close(offPage.x + offPage.width, 1);
    const tiny = applyMarkMm(start, page, { width: 0 });
    close(tiny.width, 1 / MM_PER_PT / 612);
  });
});

describe('marksPerPage', () => {
  it('counts marks per page', () => {
    const r = { x: 0, y: 0, width: 0.1, height: 0.1 };
    const counts = marksPerPage([
      { id: 'a', pageIndex: 0, rect: r },
      { id: 'b', pageIndex: 2, rect: r },
      { id: 'c', pageIndex: 2, rect: r },
    ]);
    expect([...counts]).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });
});
