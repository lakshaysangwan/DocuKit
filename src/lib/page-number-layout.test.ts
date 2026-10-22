import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DEFAULT_PAGE_NUMBER_OPTIONS,
  MM_TO_PT,
  PAGE_NUMBER_POSITIONS,
  layoutPageNumber,
  numberedPageCount,
  pageNumberText,
  type PageNumberFont,
  type PageNumberFormat,
  type PageNumberLayoutOptions,
} from './page-number-layout';
import { fontExtentEm, textWidthEm, unsupportedChars, type StandardFontName } from './standard-fonts';
import { makePageGeometry } from './pdf/page-geometry';

const LETTER = { widthPt: 612, heightPt: 792 };
const opts = (o: Partial<PageNumberLayoutOptions> = {}): PageNumberLayoutOptions => ({ ...DEFAULT_PAGE_NUMBER_OPTIONS, ...o });

const PDFLIB: Record<StandardFontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Times-Roman': StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Courier-Bold': StandardFonts.CourierBold,
};

describe('standard font metrics', () => {
  it('match pdf-lib for every font and every WinAnsi character', async () => {
    const doc = await PDFDocument.create();
    const sample = ' !"#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ÀÉßæ€™…–—';
    for (const name of Object.keys(PDFLIB) as StandardFontName[]) {
      const font = await doc.embedFont(PDFLIB[name]);
      for (const ch of sample) expect(textWidthEm(name, ch) * 1000, `${name} ${ch}`).toBeCloseTo(font.widthOfTextAtSize(ch, 1000), 6);
      const { ascent, descent } = fontExtentEm(name);
      expect((ascent - descent) * 60).toBeCloseTo(font.heightAtSize(60), 6);
    }
    expect(unsupportedChars('Page 12 of 30 xiv')).toEqual([]);
  });
});

describe('pageNumberText — numbering as the tool has always done it', () => {
  const FORMATS: [PageNumberFormat, string[]][] = [
    ['n', ['1', '2', '3', '4', '5']],
    ['page-n', ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']],
    ['page-n-of-total', ['Page 1 of 5', 'Page 2 of 5', 'Page 3 of 5', 'Page 4 of 5', 'Page 5 of 5']],
    ['n-of-total', ['1/5', '2/5', '3/5', '4/5', '5/5']],
    ['roman', ['i', 'ii', 'iii', 'iv', 'v']],
    ['alpha', ['a', 'b', 'c', 'd', 'e']],
  ];
  for (const [format, want] of FORMATS) {
    it(`format ${format}`, () => {
      expect([0, 1, 2, 3, 4].map((i) => pageNumberText(i, 5, opts({ format })))).toEqual(want);
    });
  }

  it('larger numbers', () => {
    expect(pageNumberText(0, 1, opts({ format: 'roman', startNumber: 1994 }))).toBe('mcmxciv');
    expect(pageNumberText(0, 1, opts({ format: 'alpha', startNumber: 27 }))).toBe('aa');
    expect(pageNumberText(0, 1, opts({ format: 'alpha', startNumber: 52 }))).toBe('az');
  });

  it('skip first N: those pages carry nothing, the next gets the start number, "of N" counts the numbered pages', () => {
    const o = opts({ skipFirstN: 2, startNumber: 1 });
    expect([0, 1, 2, 3, 4].map((i) => pageNumberText(i, 5, o))).toEqual([null, null, 'Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
    expect(numberedPageCount(5, o)).toBe(3);
  });

  it('start number shifts every number; "of N" is not shifted (pinned)', () => {
    const o = opts({ startNumber: 3 });
    expect([0, 4].map((i) => pageNumberText(i, 5, o))).toEqual(['Page 3 of 5', 'Page 7 of 5']);
    expect(pageNumberText(2, 5, opts({ startNumber: 10, skipFirstN: 1, format: 'n' }))).toBe('11');
  });

  it('skipping every page leaves no page numbered', () => {
    expect([0, 1, 2].map((i) => pageNumberText(i, 3, opts({ skipFirstN: 3 })))).toEqual([null, null, null]);
    expect(numberedPageCount(3, opts({ skipFirstN: 7 }))).toBe(0);
  });

  it('a start number below 1, or a fractional skip, is read as the tool reads it', () => {
    expect(pageNumberText(0, 2, opts({ startNumber: 0, format: 'n' }))).toBe('1');
    expect(pageNumberText(1, 2, opts({ skipFirstN: 1.5, format: 'n' }))).toBe('1');
  });
});

/**
 * The original worker's placement, for an upright page starting at 0,0:
 * pdf-lib `drawText(label, { x, y })` with y the baseline from the bottom.
 * Margins used 2.8346 pt/mm; the layout uses the exact 72/25.4 (a shift of at
 * most 0.003 pt at the largest margin).
 */
async function oldPlacement(font: PageNumberFont, size: number, position: string, label: string, mxMm: number, myMm: number, W: number, H: number) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(PDFLIB[font]);
  // pdf-lib's widthOfTextAtSize(label) adds kerning that Tj never applies, so the
  // original centred and right-aligned text was off by the kerning (up to
  // ~0.3 pt); the drawn width is the sum of the advance widths.
  const tw = [...label].reduce((sum, ch) => sum + f.widthOfTextAtSize(ch, size), 0);
  const mx = mxMm * 2.8346;
  const my = myMm * 2.8346;
  switch (position) {
    case 'bottom-left': return { x: mx, y: my };
    case 'bottom-right': return { x: W - mx - tw, y: my };
    case 'top-center': return { x: W / 2 - tw / 2, y: H - my - size };
    case 'top-left': return { x: mx, y: H - my - size };
    case 'top-right': return { x: W - mx - tw, y: H - my - size };
    default: return { x: W / 2 - tw / 2, y: my };
  }
}

describe('layoutPageNumber — placement', () => {
  for (const font of ['Helvetica', 'Times-Roman', 'Courier'] as PageNumberFont[]) {
    for (const position of PAGE_NUMBER_POSITIONS) {
      it(`pins the original placement: ${font}, ${position}`, async () => {
        const o = opts({ font, position, fontSize: 14, marginX: 25, marginY: 12 });
        const p = layoutPageNumber(LETTER, 2, 5, o)!;
        expect(p.text).toBe('Page 3 of 5');
        const old = await oldPlacement(font, 14, position, p.text, 25, 12, 612, 792);
        // Baseline-left of the text in PDF space (y up) from the layout box.
        const x = p.rect.x * 612;
        const baselineFromBottom = 792 - (p.rect.y + p.rect.height) * 792 + p.baselinePt;
        expect(Math.abs(x - old.x)).toBeLessThan(0.01);
        expect(Math.abs(baselineFromBottom - old.y)).toBeLessThan(0.01);
      });
    }
  }

  it('the box is the text as the font sets it, descender to ascender', () => {
    const p = layoutPageNumber(LETTER, 0, 5, opts({ font: 'Times-Roman', fontSize: 20 }))!;
    const { ascent, descent } = fontExtentEm('Times-Roman');
    expect(p.boxWidthPt).toBeCloseTo(textWidthEm('Times-Roman', 'Page 1 of 5') * 20, 9);
    expect(p.boxHeightPt).toBeCloseTo((ascent - descent) * 20, 9);
    expect(p.baselinePt).toBeCloseTo(-descent * 20, 9);
    expect(p.rect.width * 612).toBeCloseTo(p.boxWidthPt, 9);
    expect(p.rect.height * 792).toBeCloseTo(p.boxHeightPt, 9);
  });

  it('margins are millimetres from the displayed edges', () => {
    const p = layoutPageNumber(LETTER, 0, 1, opts({ position: 'bottom-right', marginX: 10, marginY: 30, format: 'n' }))!;
    expect(612 - (p.rect.x + p.rect.width) * 612).toBeCloseTo(10 * MM_TO_PT, 9);
    expect(792 - (p.rect.y + p.rect.height) * 792 + p.baselinePt).toBeCloseTo(30 * MM_TO_PT, 9);
    const left = layoutPageNumber(LETTER, 0, 1, opts({ position: 'top-left', marginX: 0, marginY: 0, format: 'n' }))!;
    expect(left.rect.x).toBe(0);
    // Top: the baseline sits the font size below the top edge.
    expect(left.rect.y * 792 + left.boxHeightPt - left.baselinePt).toBeCloseTo(10, 9);
  });

  it('centre positions ignore the horizontal margin', () => {
    const a = layoutPageNumber(LETTER, 0, 1, opts({ marginX: 0 }))!;
    const b = layoutPageNumber(LETTER, 0, 1, opts({ marginX: 40 }))!;
    expect(a.rect).toEqual(b.rect);
    expect(a.rect.x + a.rect.width / 2).toBeCloseTo(0.5, 12);
  });

  it('skipped pages get no placement', () => {
    expect(layoutPageNumber(LETTER, 0, 3, opts({ skipFirstN: 1 }))).toBeNull();
    expect(layoutPageNumber(LETTER, 1, 3, opts({ skipFirstN: 1 }))!.text).toBe('Page 1 of 2');
  });

  it('on a /Rotate 90 page it is placed on the displayed (landscape) page', () => {
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 90 });
    expect([geom.widthPt, geom.heightPt]).toEqual([792, 612]);
    const p = layoutPageNumber(geom, 0, 1, opts())!;
    expect(p.rect.x + p.rect.width / 2).toBeCloseTo(0.5, 12);
    expect(612 - (p.rect.y + p.rect.height) * 612 + p.baselinePt).toBeCloseTo(15 * MM_TO_PT, 9);
  });

  it('on an offset crop box it is placed on the visible box, not the media box', () => {
    const geom = makePageGeometry({ view: [50, 100, 562, 742], rotate: 0 });
    const p = layoutPageNumber(geom, 0, 1, opts({ position: 'top-right', format: 'n' }))!;
    expect(1 - p.rect.x - p.rect.width).toBeCloseTo((20 * MM_TO_PT) / 512, 9);
  });

  it('nothing for a zero-size page or font', () => {
    expect(layoutPageNumber({ widthPt: 0, heightPt: 792 }, 0, 1, opts())).toBeNull();
    expect(layoutPageNumber(LETTER, 0, 1, opts({ fontSize: 0 }))).toBeNull();
  });
});
