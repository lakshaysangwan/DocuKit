import { describe, it, expect } from 'vitest';
import * as pdfLib from 'pdf-lib';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import { imageEffectiveDpi, readOperators } from './pdf-image-placement';

/** A one-page document; `content` is the page's content stream, drawing /Im (600 × 400 px). */
async function docWith(content: string, extra?: (doc: PDFDocument, image: PDFRef) => void) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const image = doc.context.register(doc.context.flateStream(new Uint8Array(600 * 400), {
    Type: 'XObject', Subtype: 'Image', Width: 600, Height: 400, BitsPerComponent: 8, ColorSpace: 'DeviceGray',
  }));
  page.node.setXObject(PDFName.of('Im'), image);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  extra?.(doc, image);
  // Round-trip, as a real file would be read.
  const loaded = await PDFDocument.load(await doc.save());
  const ref = loaded.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), pdfLib.PDFDict).get(PDFName.of('Im')) as PDFRef;
  const placed = imageEffectiveDpi(pdfLib, loaded).get(ref);
  // The lower of the two axes, for the single-figure checks below.
  return { placed, dpi: placed && Math.min(placed.x, placed.y) };
}

describe('imageEffectiveDpi', () => {
  it('is pixels per inch where the image is drawn', async () => {
    // 600 px across 300 pt (4.17 in) = 144 DPI.
    expect((await docWith('q 300 0 0 200 50 50 cm /Im Do Q')).dpi).toBeCloseTo(144);
  });

  it('takes the largest placement, for width and height separately', async () => {
    const { placed } = await docWith('q 100 0 0 50 0 0 cm /Im Do Q q 600 0 0 100 0 300 cm /Im Do Q q 200 0 0 400 0 0 cm /Im Do Q');
    // Across, the second placement is largest: 600 px over 600 pt = 72 DPI.
    // Down, the third: 400 px over 400 pt = 72 DPI too — not the 288 of the second.
    expect(placed!.x).toBeCloseTo(72);
    expect(placed!.y).toBeCloseTo(72);
    const stretched = await docWith('q 300 0 0 400 0 0 cm /Im Do Q');
    expect(stretched.placed!.x).toBeCloseTo(144);
    expect(stretched.placed!.y).toBeCloseTo(72);
  });

  it('follows nested q/Q, a rotated matrix, and a form with its own /Matrix', async () => {
    expect((await docWith('q 0 300 -200 0 400 50 cm /Im Do Q')).dpi).toBeCloseTo(144);
    expect((await docWith('2 0 0 2 0 0 cm q 150 0 0 100 0 0 cm /Im Do Q')).dpi).toBeCloseTo(144);

    const viaForm = await docWith('q 1.5 0 0 1.5 0 0 cm /Fm Do Q', (doc, image) => {
      const form = doc.context.register(doc.context.flateStream('q 100 0 0 50 0 0 cm /Im Do Q', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 400], Matrix: [2, 0, 0, 2, 0, 0],
        Resources: { XObject: { Im: image } },
      }));
      doc.getPages()[0].node.setXObject(PDFName.of('Fm'), form);
    });
    // 100 pt × 2 × 1.5 = 300 pt across (144 DPI); 50 pt × 3 = 150 pt down (192 DPI).
    expect(viaForm.dpi).toBeCloseTo(144);
  });

  it('reads past strings, dictionaries and inline images that look like operators', async () => {
    const content = [
      'BT /F1 12 Tf (a \\) (Do) cm) Tj ET',
      '/Span <</MCID 3 /Alt (q Q)>> BDC EMC',
      'BI /W 4 /H 1 /BPC 8 /CS /G ID \x00Do Q\xff EI',
      'q 300 0 0 200 0 0 cm /Im Do Q',
    ].join('\n');
    expect((await docWith(content)).dpi).toBeCloseTo(144);
  });

  it('gives no figure when some unread content can draw the image', async () => {
    const annotated = await docWith('q 300 0 0 200 0 0 cm /Im Do Q', (doc, image) => {
      const appearance = doc.context.register(doc.context.flateStream('q 10 0 0 10 0 0 cm /Im Do Q', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { XObject: { Im: image } },
      }));
      const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 10, 10], AP: { N: appearance } }));
      doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    });
    expect(annotated.dpi).toBeUndefined();
  });

  it('gives no figure when the page cannot be read, or never draws the image', async () => {
    expect((await docWith('q 300 0 0 cm /Im Do Q')).dpi, 'cm short of numbers').toBeUndefined();
    expect((await docWith('q (unterminated /Im Do Q')).dpi, 'broken string').toBeUndefined();
    expect((await docWith('0 0 m 10 10 l S')).dpi, 'not drawn').toBeUndefined();
    expect((await docWith('q 0 0 0 0 0 0 cm /Im Do Q')).dpi, 'drawn at no size').toBeUndefined();
  });
});

describe('readOperators', () => {
  it('passes each operator its numbers and names', () => {
    const seen: Array<[string, unknown[]]> = [];
    readOperators(new TextEncoder().encode('q 1 0 0 1 -2.5 .5 cm /Im0 Do Q % note Do\n[1 2] 0 d'), (op, args) => seen.push([op, args]));
    expect(seen).toEqual([
      ['q', []],
      ['cm', [1, 0, 0, 1, -2.5, 0.5]],
      ['Do', ['/Im0']],
      ['Q', []],
      ['d', [null, 1, 2, null, 0]],
    ]);
  });
});
