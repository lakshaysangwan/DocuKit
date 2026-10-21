import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZES,
  formatPageMm,
  hasRoomForImage,
  layoutImagePage,
  orientPage,
  pageSizeFor,
  standardPageMm,
} from './images-to-pdf-layout';
import { PINNED_LAYOUTS } from './images-to-pdf-layout.pinned';
import type { ImagesToPdfOptions } from '../types/worker-messages';

const MM10 = 28.35;
const options = (over: Partial<ImagesToPdfOptions> = {}): ImagesToPdfOptions => ({
  pageSize: 'a4',
  placement: 'fit',
  margins: { top: MM10, right: MM10, bottom: MM10, left: MM10 },
  backgroundColor: '#FFFFFF',
  ...over,
});

/** "a4/fit/1200x800/28.35": page size / placement / image / left margin. */
const keyOf = (row: (typeof PINNED_LAYOUTS)[number]) =>
  `${row.options.pageSize}/${row.options.placement}/${row.img.width}x${row.img.height}/${row.options.margins.left}`;

/**
 * The rows of the pinned table whose output the owner's decisions changed
 * (October 2026), with their new numbers. Everything not listed here must
 * still produce exactly what it produced before the preview existed.
 *
 *   • "Fit Image" pages have no margin: the page is the image, edge to edge,
 *     whatever the placement (16 rows).
 *   • Orientation defaults to Auto: on A4, Letter and Legal a landscape image
 *     gets a landscape page (24 rows). Portrait images keep a portrait page.
 *
 * Checked by hand for a4/fit/1200x800/28.35: A4 turned is 841.89 × 595.28;
 * inside 10 mm margins that leaves 785.19 × 538.58; a 3:2 image fills the
 * width, 785.19 × 523.46, centred 35.91 pt up from the bottom.
 */
const DECIDED = new Map<string, { pageW: number; pageH: number; draw: { x: number; y: number; w: number; h: number } }>([
  ['fit/center/900x1200/28.35', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/center/900x1200/108', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/center/1200x800/28.35', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/center/1200x800/108', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/fit/900x1200/28.35', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/fit/900x1200/108', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/fit/1200x800/28.35', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/fit/1200x800/108', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/stretch/900x1200/28.35', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/stretch/900x1200/108', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/stretch/1200x800/28.35', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/stretch/1200x800/108', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/cover/900x1200/28.35', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/cover/900x1200/108', {"pageW":900,"pageH":1200,"draw":{"x":0,"y":0,"w":900,"h":1200}}],
  ['fit/cover/1200x800/28.35', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['fit/cover/1200x800/108', {"pageW":1200,"pageH":800,"draw":{"x":0,"y":0,"w":1200,"h":800}}],
  ['a4/center/1200x800/28.35', {"pageW":841.89,"pageH":595.28,"draw":{"x":28.35,"y":35.910000000000004,"w":785.1899999999999,"h":523.4599999999999}}],
  ['a4/center/1200x800/108', {"pageW":841.89,"pageH":595.28,"draw":{"x":108,"y":38.00999999999999,"w":697.89,"h":465.26}}],
  ['a4/fit/1200x800/28.35', {"pageW":841.89,"pageH":595.28,"draw":{"x":28.35,"y":35.910000000000004,"w":785.1899999999999,"h":523.4599999999999}}],
  ['a4/fit/1200x800/108', {"pageW":841.89,"pageH":595.28,"draw":{"x":108,"y":38.00999999999999,"w":697.89,"h":465.26}}],
  ['a4/stretch/1200x800/28.35', {"pageW":841.89,"pageH":595.28,"draw":{"x":28.35,"y":28.35,"w":785.1899999999999,"h":538.5799999999999}}],
  ['a4/stretch/1200x800/108', {"pageW":841.89,"pageH":595.28,"draw":{"x":108,"y":18,"w":697.89,"h":505.28}}],
  ['a4/cover/1200x800/28.35', {"pageW":841.89,"pageH":595.28,"draw":{"x":17.00999999999997,"y":28.35,"w":807.87,"h":538.5799999999999}}],
  ['a4/cover/1200x800/108', {"pageW":841.89,"pageH":595.28,"draw":{"x":77.98500000000001,"y":18,"w":757.92,"h":505.28}}],
  ['letter/center/1200x800/28.35', {"pageW":792,"pageH":612,"draw":{"x":28.349999999999945,"y":60.899999999999984,"w":735.3000000000001,"h":490.2}}],
  ['letter/center/1200x800/108', {"pageW":792,"pageH":612,"draw":{"x":108,"y":63,"w":648,"h":432}}],
  ['letter/fit/1200x800/28.35', {"pageW":792,"pageH":612,"draw":{"x":28.349999999999945,"y":60.899999999999984,"w":735.3000000000001,"h":490.2}}],
  ['letter/fit/1200x800/108', {"pageW":792,"pageH":612,"draw":{"x":108,"y":63,"w":648,"h":432}}],
  ['letter/stretch/1200x800/28.35', {"pageW":792,"pageH":612,"draw":{"x":28.35,"y":28.35,"w":735.3,"h":555.3}}],
  ['letter/stretch/1200x800/108', {"pageW":792,"pageH":612,"draw":{"x":108,"y":18,"w":648,"h":522}}],
  ['letter/cover/1200x800/28.35', {"pageW":792,"pageH":612,"draw":{"x":-20.475000000000044,"y":28.35,"w":832.95,"h":555.3}}],
  ['letter/cover/1200x800/108', {"pageW":792,"pageH":612,"draw":{"x":40.5,"y":18,"w":783,"h":522}}],
  ['legal/center/1200x800/28.35', {"pageW":1008,"pageH":612,"draw":{"x":87.52499999999995,"y":28.35,"w":832.95,"h":555.3}}],
  ['legal/center/1200x800/108', {"pageW":1008,"pageH":612,"draw":{"x":148.5,"y":18,"w":783,"h":522}}],
  ['legal/fit/1200x800/28.35', {"pageW":1008,"pageH":612,"draw":{"x":87.52499999999995,"y":28.35,"w":832.95,"h":555.3}}],
  ['legal/fit/1200x800/108', {"pageW":1008,"pageH":612,"draw":{"x":148.5,"y":18,"w":783,"h":522}}],
  ['legal/stretch/1200x800/28.35', {"pageW":1008,"pageH":612,"draw":{"x":28.35,"y":28.35,"w":951.3,"h":555.3}}],
  ['legal/stretch/1200x800/108', {"pageW":1008,"pageH":612,"draw":{"x":108,"y":18,"w":864,"h":522}}],
  ['legal/cover/1200x800/28.35', {"pageW":1008,"pageH":612,"draw":{"x":28.35,"y":-11.099999999999987,"w":951.3,"h":634.1999999999999}}],
  ['legal/cover/1200x800/108', {"pageW":1008,"pageH":612,"draw":{"x":108,"y":-9,"w":864,"h":576}}],
]);

describe('layoutImagePage — the pinned table', () => {
  // Every page size × placement × a portrait and a landscape image × two sets
  // of margins, held to the numbers the inline code produced before the
  // extraction (see the header of images-to-pdf-layout.pinned.ts), except the
  // rows in DECIDED. Exact equality, not "close to".
  it('covers the whole table, and the decided rows are exactly the ones expected', () => {
    expect(PINNED_LAYOUTS).toHaveLength(5 * 4 * 2 * 2);
    const changed = PINNED_LAYOUTS.filter((row) => DECIDED.has(keyOf(row)));
    expect(changed).toHaveLength(40);
    for (const row of changed) {
      const fixedLandscape = row.options.pageSize !== 'fit' && row.options.pageSize !== 'custom' && row.img.width > row.img.height;
      expect(row.options.pageSize === 'fit' || fixedLandscape, keyOf(row)).toBe(true);
    }
  });

  it.each(PINNED_LAYOUTS.map((row) => [keyOf(row), row] as const))('%s', (key, row) => {
    const { pageW, pageH, draw } = layoutImagePage(row.img, row.options);
    expect({ pageW, pageH, draw }).toStrictEqual(DECIDED.get(key) ?? row.expected);
  });

  it.each(PINNED_LAYOUTS.filter((row) => row.options.pageSize !== 'fit').map((row) => [keyOf(row), row] as const))(
    '%s, Portrait: exactly as before',
    (_key, row) => {
      const { pageW, pageH, draw } = layoutImagePage(row.img, { ...row.options, orientation: 'portrait' });
      expect({ pageW, pageH, draw }).toStrictEqual(row.expected);
    },
  );
});

describe('layoutImagePage — what each option means', () => {
  const landscape = { width: 1200, height: 800 };
  const portrait = { width: 900, height: 1200 };
  const square = { width: 800, height: 800 };

  it('Auto turns each fixed-size page to match its image', () => {
    expect(pageSizeFor(landscape, options({ pageSize: 'a4' }))).toEqual([841.89, 595.28]);
    expect(pageSizeFor(portrait, options({ pageSize: 'a4' }))).toEqual([595.28, 841.89]);
    expect(pageSizeFor(square, options({ pageSize: 'a4' }))).toEqual([595.28, 841.89]);
    expect(pageSizeFor(landscape, options({ pageSize: 'letter', orientation: 'auto' }))).toEqual([792, 612]);
    expect(pageSizeFor(landscape, options({ pageSize: 'legal' }))).toEqual([1008, 612]);
  });

  it('Portrait and Landscape turn every page the same way', () => {
    for (const img of [landscape, portrait, square]) {
      expect(pageSizeFor(img, options({ orientation: 'portrait' }))).toEqual([595.28, 841.89]);
      expect(pageSizeFor(img, options({ orientation: 'landscape' }))).toEqual([841.89, 595.28]);
    }
  });

  it('"Fit Image" makes the page exactly the image, with no margin, whatever is set', () => {
    for (const placement of ['fit', 'center', 'stretch', 'cover'] as const) {
      const layout = layoutImagePage(landscape, options({ pageSize: 'fit', placement, orientation: 'portrait' }));
      expect([layout.pageW, layout.pageH]).toEqual([1200, 800]);
      expect(layout.draw).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    }
  });

  it('fit places the whole image, as large as the margins allow, in the middle ("center" is the same)', () => {
    const fit = layoutImagePage(landscape, options({ placement: 'fit' }));
    expect(layoutImagePage(landscape, options({ placement: 'center' }))).toStrictEqual(fit);
    const { draw, box } = fit;
    expect(draw.x).toBeGreaterThanOrEqual(box.x);
    expect(draw.y).toBeGreaterThanOrEqual(box.y);
    expect(draw.x + draw.w).toBeLessThanOrEqual(box.x + box.w + 1e-9);
    expect(draw.y + draw.h).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    expect(draw.w / draw.h).toBeCloseTo(1200 / 800, 10);
  });

  it('cover fills the area inside the margins and runs past it on the other axis', () => {
    // A portrait sheet, so the landscape image overflows it sideways.
    const { draw, box, pageW } = layoutImagePage(landscape, options({ placement: 'cover', orientation: 'portrait' }));
    expect(draw.h).toBeCloseTo(box.h, 10);
    expect(draw.w).toBeGreaterThan(pageW); // wider than the page itself: the page edge cuts it
    expect(draw.x).toBeLessThan(0);
    expect(draw.w / draw.h).toBeCloseTo(1200 / 800, 10);
  });

  it('stretch is exactly the area inside the margins', () => {
    const { draw, box } = layoutImagePage(portrait, options({ placement: 'stretch' }));
    expect(draw).toEqual(box);
  });

  it('reports margins that leave no room', () => {
    const none = options({ margins: { top: 0, right: 300, bottom: 0, left: 300 } });
    expect(hasRoomForImage(layoutImagePage(portrait, none))).toBe(false);
    expect(hasRoomForImage(layoutImagePage(portrait, options()))).toBe(true);
  });
});

describe('page helpers', () => {
  it('orientPage turns the sheet for landscape and for a wide image on auto', () => {
    const [w, h] = PAGE_SIZES.a4;
    expect(orientPage(w, h, { width: 3, height: 2 }, 'portrait')).toEqual([w, h]);
    expect(orientPage(w, h, { width: 2, height: 3 }, 'landscape')).toEqual([h, w]);
    expect(orientPage(w, h, { width: 3, height: 2 }, 'auto')).toEqual([h, w]);
    expect(orientPage(w, h, { width: 2, height: 3 }, 'auto')).toEqual([w, h]);
  });

  it('formats the physical size in millimetres', () => {
    expect(standardPageMm('a4')).toBe('210 × 297 mm');
    expect(standardPageMm('letter')).toBe('216 × 279 mm');
    expect(standardPageMm('legal')).toBe('216 × 356 mm');
    // "Fit Image": pixels become points, so a 1200 × 800 photo is a very large sheet.
    expect(formatPageMm(1200, 800)).toBe('423 × 282 mm');
  });
});
