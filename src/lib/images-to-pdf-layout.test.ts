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
  placement: 'center',
  margins: { top: MM10, right: MM10, bottom: MM10, left: MM10 },
  backgroundColor: '#FFFFFF',
  ...over,
});

describe('layoutImagePage — unchanged by the extraction from the worker', () => {
  // Every page size × placement × a portrait and a landscape image × two sets
  // of margins, held to the numbers the inline code produced (see the header of
  // images-to-pdf-layout.pinned.ts). Exact equality, not "close to".
  it('covers the whole table', () => {
    expect(PINNED_LAYOUTS).toHaveLength(5 * 4 * 2 * 2);
  });

  it.each(
    PINNED_LAYOUTS.map((row) => [
      `${row.options.pageSize} / ${row.options.placement} / ${row.img.width}×${row.img.height} / left margin ${row.options.margins.left}`,
      row,
    ] as const),
  )('%s', (_name, row) => {
    const { pageW, pageH, draw } = layoutImagePage(row.img, row.options);
    expect({ pageW, pageH, draw }).toStrictEqual(row.expected);
  });
});

describe('layoutImagePage — what each option means', () => {
  const landscape = { width: 1200, height: 800 };
  const portrait = { width: 900, height: 1200 };

  it('a fixed page size is portrait whatever the image', () => {
    for (const img of [landscape, portrait]) {
      const { pageW, pageH } = layoutImagePage(img, options({ pageSize: 'a4' }));
      expect([pageW, pageH]).toEqual([595.28, 841.89]);
    }
    expect(pageSizeFor(landscape, options({ pageSize: 'letter' }))).toEqual([612, 792]);
    expect(pageSizeFor(landscape, options({ pageSize: 'legal' }))).toEqual([612, 1008]);
  });

  it('"fit" makes the page the image\'s pixel size in points, and still applies the margins', () => {
    const layout = layoutImagePage(landscape, options({ pageSize: 'fit' }));
    expect([layout.pageW, layout.pageH]).toEqual([1200, 800]);
    expect(layout.box).toEqual({ x: MM10, y: MM10, w: 1200 - MM10 - MM10, h: 800 - MM10 - MM10 });
    // The image is scaled down to sit inside them.
    expect(layout.draw.w).toBeLessThan(1200);
    expect(layout.draw.h).toBeLessThan(800);
  });

  it('center and fit place the image identically, whole and inside the margins', () => {
    const center = layoutImagePage(landscape, options({ placement: 'center' }));
    const fit = layoutImagePage(landscape, options({ placement: 'fit' }));
    expect(fit).toStrictEqual(center);
    const { draw, box } = center;
    expect(draw.x).toBeGreaterThanOrEqual(box.x);
    expect(draw.y).toBeGreaterThanOrEqual(box.y);
    expect(draw.x + draw.w).toBeLessThanOrEqual(box.x + box.w + 1e-9);
    expect(draw.y + draw.h).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    expect(draw.w / draw.h).toBeCloseTo(1200 / 800, 10);
  });

  it('cover fills the area inside the margins and runs past it on the other axis', () => {
    const { draw, box, pageW } = layoutImagePage(landscape, options({ placement: 'cover' }));
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
