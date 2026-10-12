import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, popGraphicsState, rgb } from 'pdf-lib';
import { countUnclosedGraphicsStates } from './content-balance';

const bytes = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'));
const count = (text: string) => countUnclosedGraphicsStates(bytes(text));

describe('countUnclosedGraphicsStates', () => {
  it('is zero for balanced content', () => {
    expect(count('')).toBe(0);
    expect(count('q 1 0 0 1 10 10 cm 0 0 5 5 re f Q')).toBe(0);
    expect(count('q q Q q Q Q')).toBe(0);
    expect(count('0.5 0 0 0.5 150 200 cm 0 0 400 300 re f')).toBe(0);
  });

  it('counts each q that is never closed', () => {
    expect(count('q 0.5 0 0 0.5 0 0 cm')).toBe(1);
    expect(count('q 2 0 0 2 0 0 cm q 1 0 0 1 5 5 cm 0 0 1 1 re f')).toBe(2);
    expect(count('q q q Q')).toBe(2);
    expect(count('q\nq\r\nq\tQ')).toBe(2);
  });

  it('ignores a Q with nothing to close', () => {
    expect(count('Q Q q')).toBe(1);
    expect(count('Q')).toBe(0);
  });

  it('does not mistake the letters inside other tokens for operators', () => {
    expect(count('/q gs /Q Do /Fq 12 Tf')).toBe(0);
    expect(count('BT (q Q q) Tj ET')).toBe(0);
    expect(count('BT (nested (q) \\( q \\) q) Tj ET q')).toBe(1);
    expect(count('<7120> Tj q <51> Tj Q')).toBe(0);
    expect(count('% q q q\nq % Q\n')).toBe(1);
    expect(count('qq Qq q1 1q')).toBe(0);
    expect(count('/OC << /q 1 >> BDC q EMC')).toBe(1);
    expect(count('[(q) -20 (Q)] TJ')).toBe(0);
  });

  it('skips inline image data, whatever bytes it holds', () => {
    // The image data contains "q", "Q" and even " EI" without the whitespace after it.
    expect(count('q BI /W 2 /H 1 /BPC 8 /CS /G ID q Q q EIx q \nEI Q')).toBe(0);
    expect(count('BI /W 1 /H 1 /BPC 8 /CS /G ID q\nEI q')).toBe(1);
  });
});

/**
 * The count is only useful if emitting that many `Q`s really does put a stamp
 * back where it belongs. Build the awkward pages, do what the sign worker does,
 * render with MuPDF and look for the rectangle.
 */
describe('restoring the graphics state before stamping', () => {
  async function stampAndLocate(content: string, repair: boolean) {
    const source = await PDFDocument.create();
    const made = source.addPage([612, 792]);
    made.node.set(PDFName.of('Contents'), source.context.register(source.context.flateStream(content)));

    const doc = await PDFDocument.load(await source.save());
    const page = doc.getPage(0);
    if (repair) {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
      const decoded = streams
        .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
        .map((s) => Buffer.from(decodePDFRawStream(s).decode()));
      const open = countUnclosedGraphicsStates(Buffer.concat(decoded.flatMap((d) => [d, Buffer.from('\n')])));
      page.pushOperators(...Array.from({ length: open }, () => popGraphicsState()));
    }
    page.drawRectangle({ x: 400, y: 600, width: 100, height: 60, color: rgb(1, 0, 0.6) });
    const out = await doc.save({ useObjectStreams: false });

    const mupdf = await import('mupdf');
    const rendered = mupdf.Document.openDocument(out, 'application/pdf');
    try {
      const pix = rendered.loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false);
      const width = pix.getWidth();
      const height = pix.getHeight();
      const stride = pix.getStride();
      const n = pix.getNumberOfComponents();
      const px = pix.getPixels();
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const o = y * stride + x * n;
          if (px[o] > 200 && px[o + 1] < 80 && px[o + 2] > 100 && px[o + 2] < 220) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    } finally {
      rendered.destroy();
    }
  }

  /** x 400–500, y 600–660 from the bottom of a 792pt page, in top-left pixels. */
  const WANT = { x: 400, y: 132, width: 100, height: 60 };
  const TWO_OPEN = 'q 0.5 0 0 0.5 150 200 cm q 0.5 0 0 0.5 0 0 cm 0.8 g 0 0 400 300 re f';
  const CM_THEN_OPEN = '0.5 0 0 0.5 150 200 cm q 0.5 0 0 0.5 0 0 cm 0.8 g 0 0 400 300 re f';

  it('pdf-lib alone copes with a bare cm and with one unclosed q', async () => {
    expect(await stampAndLocate('0.5 0 0 0.5 150 200 cm 0.8 g 0 0 400 300 re f', false)).toEqual(WANT);
    expect(await stampAndLocate('q 0.5 0 0 0.5 150 200 cm 0.8 g 0 0 400 300 re f', false)).toEqual(WANT);
  });

  it('but two open states shrink and shift the stamp — the problem is real', async () => {
    const found = await stampAndLocate(TWO_OPEN, false);
    expect(found).not.toBeNull();
    expect(found).not.toEqual(WANT);
    expect(found!.width).toBe(50);
    expect(await stampAndLocate(CM_THEN_OPEN, false)).not.toEqual(WANT);
  });

  it('closing the counted states first puts the stamp where it was asked for', async () => {
    expect(await stampAndLocate(TWO_OPEN, true)).toEqual(WANT);
    expect(await stampAndLocate(CM_THEN_OPEN, true)).toEqual(WANT);
    // And a healthy page is left exactly as it was.
    expect(await stampAndLocate('q 1 0 0 1 0 0 cm 0.8 g 0 0 400 300 re f Q', true)).toEqual(WANT);
  });
});
