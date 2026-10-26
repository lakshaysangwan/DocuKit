import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DEFAULT_SPACING,
  MAX_TILES,
  WATERMARK_POSITIONS,
  clampCentre,
  layoutWatermark,
  turnedExtent,
  watermarkBox,
  watermarkedPages,
  type WatermarkLayoutOptions,
} from './watermark-layout';
import { fontExtentEm, textWidthEm, unsupportedChars, type WatermarkFont } from './watermark-fonts';

const LETTER = { widthPt: 612, heightPt: 792 };
const A4 = { widthPt: 595.28, heightPt: 841.89 };

const text = (o: Partial<WatermarkLayoutOptions> = {}): WatermarkLayoutOptions => ({
  type: 'text',
  text: 'CONFIDENTIAL',
  font: 'Helvetica-Bold',
  fontSize: 60,
  rotation: 0,
  placement: 'single',
  position: 'center',
  ...o,
});

const image = (o: Partial<WatermarkLayoutOptions> = {}): WatermarkLayoutOptions => ({
  type: 'image',
  imageWidthPx: 240,
  imageHeightPx: 80,
  imageScale: 0.5,
  rotation: 0,
  placement: 'single',
  position: 'center',
  ...o,
});

/** Centre of a placement in displayed points. */
const centre = (p: { rect: { x: number; y: number; width: number; height: number } }, page = LETTER) => [
  (p.rect.x + p.rect.width / 2) * page.widthPt,
  (p.rect.y + p.rect.height / 2) * page.heightPt,
];

describe('watermark fonts', () => {
  it('every width matches pdf-lib for the three bold standard fonts', async () => {
    const doc = await PDFDocument.create();
    const fonts: [WatermarkFont, StandardFonts][] = [
      ['Helvetica-Bold', StandardFonts.HelveticaBold],
      ['Times-Bold', StandardFonts.TimesRomanBold],
      ['Courier-Bold', StandardFonts.CourierBold],
    ];
    const sample = 'CONFIDENTIAL Draft — “Copy” 1234 €5 Ünïcødé ßœ';
    for (const [name, std] of fonts) {
      const font = await doc.embedFont(std);
      for (const ch of sample) {
        expect(textWidthEm(name, ch) * 1000, `${name} ${ch}`).toBeCloseTo(font.widthOfTextAtSize(ch, 1000), 6);
      }
      // A line is the sum of its advances: `Tj` does not kern (pdf-lib's own
      // widthOfTextAtSize adds kerning pairs, which no viewer applies).
      const sum = [...sample].reduce((s, ch) => s + font.widthOfTextAtSize(ch, 60), 0);
      expect(textWidthEm(name, sample) * 60).toBeCloseTo(sum, 6);
      const { ascent, descent } = fontExtentEm(name);
      expect((ascent - descent) * 60).toBeCloseTo(font.heightAtSize(60), 6);
    }
  });

  it('lists what the standard fonts cannot draw', () => {
    expect(unsupportedChars('Café “draft” – €')).toEqual([]);
    expect(unsupportedChars('机密 ok 机')).toEqual(['机', '密']);
  });
});

describe('layoutWatermark — single', () => {
  // Pinned from the output before the shared layout: a centred, unturned text
  // watermark started at x = (width − text width) / 2 at the chosen size, and
  // an unturned image was centred on the page at min(50% of width, 300pt) —
  // which is 50% of an A4 page. These were already right and stay so.
  it('centres unturned text horizontally where the old output did', () => {
    const { placements, boxWidthPt } = layoutWatermark(LETTER, text());
    const width = textWidthEm('Helvetica-Bold', 'CONFIDENTIAL') * 60;
    expect(boxWidthPt).toBeCloseTo(width, 9);
    expect(placements).toHaveLength(1);
    expect(placements[0].rect.x * 612).toBeCloseTo(612 / 2 - width / 2, 9);
  });

  it('centres an unturned image at half the width of an A4 page, as before', () => {
    const { placements, boxWidthPt, boxHeightPt } = layoutWatermark(A4, image());
    expect(boxWidthPt).toBeCloseTo(Math.min(A4.widthPt * 0.5, 300), 9);
    expect(boxHeightPt).toBeCloseTo(boxWidthPt / 3, 9);
    const [cx, cy] = centre(placements[0], A4);
    expect(cx).toBeCloseTo(A4.widthPt / 2, 9);
    expect(cy).toBeCloseTo(A4.heightPt / 2, 9);
  });

  // Changed: the old output put the text's baseline half a line below the
  // centre, so the words sat ~0.2 × size low and a turn pivoted on the start
  // of the baseline. The box is now centred, and turns about its own centre.
  it('puts the centre of the text box — descender to ascender — at the page centre', () => {
    const layout = layoutWatermark(LETTER, text());
    const [cx, cy] = centre(layout.placements[0]);
    expect(cx).toBeCloseTo(306, 9);
    expect(cy).toBeCloseTo(396, 9);
    const { ascent, descent } = fontExtentEm('Helvetica-Bold');
    expect(layout.boxHeightPt).toBeCloseTo((ascent - descent) * 60, 9);
    expect(layout.baselinePt).toBeCloseTo(-descent * 60, 9);
  });

  it('turns about the centre: the centre does not move with the rotation', () => {
    for (const rotation of [-90, -45, -10, 0, 30, 90]) {
      const p = layoutWatermark(LETTER, text({ rotation })).placements[0];
      expect(p.rotation).toBe(rotation);
      const [cx, cy] = centre(p);
      expect(cx).toBeCloseTo(306, 9);
      expect(cy).toBeCloseTo(396, 9);
    }
  });

  it('keeps the turned box `margin` points from the edges at the sides and corners', () => {
    const margin = 36;
    for (const rotation of [0, -45, 20]) {
      for (const position of WATERMARK_POSITIONS) {
        const layout = layoutWatermark(LETTER, text({ position, rotation, margin, fontSize: 30 }));
        const [cx, cy] = centre(layout.placements[0]);
        const t = turnedExtent(layout.boxWidthPt, layout.boxHeightPt, rotation);
        const left = cx - t.width / 2;
        const right = 612 - (cx + t.width / 2);
        const top = cy - t.height / 2;
        const bottom = 792 - (cy + t.height / 2);
        if (position.endsWith('left')) expect(left).toBeCloseTo(margin, 9);
        if (position.endsWith('right')) expect(right).toBeCloseTo(margin, 9);
        if (position.startsWith('top')) expect(top).toBeCloseTo(margin, 9);
        if (position.startsWith('bottom')) expect(bottom).toBeCloseTo(margin, 9);
        if (position.endsWith('center') || position === 'center') expect(cx).toBeCloseTo(306, 9);
        if (position.startsWith('middle') || position === 'center') expect(cy).toBeCloseTo(396, 9);
      }
    }
  });

  it('sizes an image as a fraction of the page width, keeping its shape', () => {
    const layout = layoutWatermark(LETTER, image({ imageScale: 0.25, imageWidthPx: 100, imageHeightPx: 50 }));
    expect(layout.boxWidthPt).toBeCloseTo(153, 9);
    expect(layout.boxHeightPt).toBeCloseTo(76.5, 9);
    expect(layout.baselinePt).toBe(0);
  });

  it('puts a custom position’s centre at the same fraction of every page, turned about it', () => {
    for (const page of [LETTER, A4, { widthPt: 792, heightPt: 612 }]) {
      for (const rotation of [0, -45, 30]) {
        const p = layoutWatermark(page, text({ position: 'custom', centre: { x: 0.2, y: 0.75 }, rotation })).placements[0];
        expect(p.rotation).toBe(rotation);
        const [cx, cy] = centre(p, page);
        expect(cx).toBeCloseTo(0.2 * page.widthPt, 9);
        expect(cy).toBeCloseTo(0.75 * page.heightPt, 9);
      }
    }
  });

  it('keeps a custom centre on the page, letting the watermark hang over the edge', () => {
    const p = layoutWatermark(LETTER, text({ position: 'custom', centre: { x: -0.3, y: 1.4 } })).placements[0];
    const [cx, cy] = centre(p);
    expect(cx).toBeCloseTo(0, 9);
    expect(cy).toBeCloseTo(792, 9);
    expect(p.rect.x).toBeLessThan(0);
    expect(clampCentre({ x: Number.NaN, y: 0.4 })).toEqual({ x: 0.5, y: 0.4 });
  });

  it('ignores the margin and the custom centre where they do not apply', () => {
    const custom = layoutWatermark(LETTER, text({ position: 'custom', centre: { x: 0.3, y: 0.3 }, margin: 100 }));
    expect(centre(custom.placements[0])).toEqual([0.3 * 612, 0.3 * 792].map((v) => expect.closeTo(v, 9)));
    // A preset after a custom drag snaps back, whatever centre is still stored.
    const preset = layoutWatermark(LETTER, text({ position: 'center', centre: { x: 0.3, y: 0.3 } }));
    expect(centre(preset.placements[0])).toEqual([expect.closeTo(306, 9), expect.closeTo(396, 9)]);
    // Without a centre, custom is the middle of the page.
    expect(centre(layoutWatermark(LETTER, text({ position: 'custom' })).placements[0])).toEqual([
      expect.closeTo(306, 9),
      expect.closeTo(396, 9),
    ]);
  });

  it('places nothing without text or an image', () => {
    expect(layoutWatermark(LETTER, text({ text: '' })).placements).toEqual([]);
    expect(layoutWatermark(LETTER, image({ imageWidthPx: 0 })).placements).toEqual([]);
  });
});

describe('layoutWatermark — tiled', () => {
  it('repeats along the reading direction at width + spacing, rows height + spacing apart, one copy at the centre', () => {
    const layout = layoutWatermark(LETTER, text({ placement: 'tiled', fontSize: 24, spacing: 40 }));
    const w = layout.boxWidthPt;
    const h = layout.boxHeightPt;
    const centres = layout.placements.map((p) => centre(p));
    expect(centres.some(([x, y]) => Math.abs(x - 306) < 1e-9 && Math.abs(y - 396) < 1e-9)).toBe(true);
    // The row through the centre: neighbours w + spacing apart.
    const row = centres.filter(([, y]) => Math.abs(y - 396) < 1e-6).map(([x]) => x).sort((a, b) => a - b);
    for (let i = 1; i < row.length; i++) expect(row[i] - row[i - 1]).toBeCloseTo(w + 40, 9);
    // Next row down: h + spacing below, shifted half a step.
    const below = centres.filter(([, y]) => Math.abs(y - (396 + h + 40)) < 1e-6).map(([x]) => x);
    expect(below.length).toBeGreaterThan(0);
    expect(below.some((x) => Math.abs(x - (306 + (w + 40) / 2)) < 1e-6)).toBe(true);
  });

  it('turns the lattice with the watermark', () => {
    const rotation = -45;
    const layout = layoutWatermark(LETTER, text({ placement: 'tiled', rotation, fontSize: 30, spacing: 20 }));
    const step = layout.boxWidthPt + 20;
    const centres = layout.placements.map((p) => centre(p));
    const t = (rotation * Math.PI) / 180;
    // The copy one step along the reading direction from the centre.
    const next = [306 + step * Math.cos(t), 396 + step * Math.sin(t)];
    expect(centres.some(([x, y]) => Math.abs(x - next[0]) < 1e-6 && Math.abs(y - next[1]) < 1e-6)).toBe(true);
    for (const p of layout.placements) expect(p.rotation).toBe(rotation);
  });

  it('keeps every copy that reaches into the page, and none that does not', () => {
    for (const rotation of [0, -45, 60]) {
      const layout = layoutWatermark(LETTER, text({ placement: 'tiled', rotation }));
      const t = turnedExtent(layout.boxWidthPt, layout.boxHeightPt, rotation);
      for (const p of layout.placements) {
        const [cx, cy] = centre(p);
        expect(cx + t.width / 2).toBeGreaterThan(0);
        expect(cx - t.width / 2).toBeLessThan(612);
        expect(cy + t.height / 2).toBeGreaterThan(0);
        expect(cy - t.height / 2).toBeLessThan(792);
      }
    }
  });

  it('gives the default CONFIDENTIAL a handful of rows on a Letter page', () => {
    const counts = [0, -45].map((rotation) => layoutWatermark(LETTER, text({ placement: 'tiled', rotation, spacing: DEFAULT_SPACING })).placements.length);
    expect(counts[0]).toBeGreaterThanOrEqual(10);
    expect(counts[0]).toBeLessThanOrEqual(30);
    expect(counts[1]).toBeGreaterThanOrEqual(8);
    expect(counts[1]).toBeLessThanOrEqual(30);
  });

  it('tiles images at the same size as a single one', () => {
    const single = layoutWatermark(LETTER, image({ imageScale: 0.2 }));
    const tiled = layoutWatermark(LETTER, image({ imageScale: 0.2, placement: 'tiled', rotation: 30 }));
    expect(tiled.boxWidthPt).toBe(single.boxWidthPt);
    expect(tiled.placements.length).toBeGreaterThan(4);
    for (const p of tiled.placements) expect(p.rotation).toBe(30);
  });

  it('never returns more than MAX_TILES copies', () => {
    const layout = layoutWatermark({ widthPt: 2400, heightPt: 3400 }, text({ text: '.', fontSize: 12, placement: 'tiled', spacing: 0 }));
    expect(layout.placements.length).toBeLessThanOrEqual(MAX_TILES);
    expect(layout.placements.length).toBeGreaterThan(MAX_TILES / 3);
  });
});

describe('watermarkBox', () => {
  it('is null for a page or image with no size', () => {
    expect(watermarkBox(0, image({ imageScale: 0 }))).toBeNull();
    expect(watermarkBox(612, text({ fontSize: 0 }))).toBeNull();
  });
});

describe('watermarkedPages', () => {
  it('selects all, odd, even or the given pages', () => {
    expect(watermarkedPages('all', 4)).toEqual([0, 1, 2, 3]);
    expect(watermarkedPages('odd', 5)).toEqual([0, 2, 4]);
    expect(watermarkedPages('even', 5)).toEqual([1, 3]);
    expect(watermarkedPages('range', 5, [1, 3, 9])).toEqual([1, 3]);
    expect(watermarkedPages('range', 5, [])).toEqual([]);
  });
});
