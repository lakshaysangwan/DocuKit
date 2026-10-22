import { describe, expect, it } from 'vitest';
import { estimateBytes, exportPixelSize, previewDpi, PREVIEW_MAX_PIXELS } from './export-render';

const LETTER = { widthPt: 612, heightPt: 792 };
const A4 = { widthPt: 595.28, heightPt: 841.89 };

describe('exportPixelSize', () => {
  it('is the page size in inches times the DPI, rounded down', () => {
    expect(exportPixelSize(LETTER, 72)).toEqual({ width: 612, height: 792 });
    expect(exportPixelSize(LETTER, 150)).toEqual({ width: 1275, height: 1650 });
    expect(exportPixelSize(LETTER, 300)).toEqual({ width: 2550, height: 3300 });
    expect(exportPixelSize(A4, 150)).toEqual({ width: 1240, height: 1753 });
    expect(exportPixelSize(A4, 300)).toEqual({ width: 2480, height: 3507 });
  });

  it('does not lose a pixel to floating point just below a whole number', () => {
    expect(exportPixelSize({ widthPt: (1275 * 72) / 150 - 1e-9, heightPt: 10 }, 150).width).toBe(1275);
  });

  it('is never smaller than one pixel', () => {
    expect(exportPixelSize({ widthPt: 0.1, heightPt: 0.1 }, 72)).toEqual({ width: 1, height: 1 });
  });
});

describe('previewDpi', () => {
  it('is the chosen DPI when the image fits the budget', () => {
    expect(previewDpi(LETTER, 300, PREVIEW_MAX_PIXELS)).toBe(300);
    expect(previewDpi(A4, 300, PREVIEW_MAX_PIXELS)).toBe(300);
  });

  it('drops 600 DPI to the highest whole DPI that fits', () => {
    const d = previewDpi(LETTER, 600, PREVIEW_MAX_PIXELS);
    expect(d).toBeLessThan(600);
    const at = exportPixelSize(LETTER, d);
    const above = exportPixelSize(LETTER, d + 1);
    expect(at.width * at.height).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
    expect(above.width * above.height).toBeGreaterThan(PREVIEW_MAX_PIXELS);
  });
});

describe('estimateBytes', () => {
  it('scales the preview bytes by the pixel count', () => {
    expect(estimateBytes(1000, 100, 400)).toBe(4000);
    expect(estimateBytes(1000, 400, 400)).toBe(1000);
  });
});
