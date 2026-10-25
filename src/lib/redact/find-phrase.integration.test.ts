/**
 * "Find & mark all" against real PDFs and the real engine: build pages with
 * pdf-lib, find a phrase with MuPDF as the worker does, redact exactly those
 * marks as the worker does, and read the text back out of the result. The
 * phrase must be gone and every other character of the page still there —
 * neighbouring letters, the rest of the line, and the lines above and below
 * on single-spaced text.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFNumber, StandardFonts, degrees, type PDFFont } from 'pdf-lib';
import type * as MuPDF from 'mupdf';
import { findPhrase, type PhraseMatch } from './find-phrase';
import type { PdfRect } from '../pdf/page-geometry';

type Matrix = [number, number, number, number, number, number];

async function load(bytes: Uint8Array) {
  const mupdf = (await import('mupdf')) as typeof MuPDF;
  return { mupdf, doc: mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()! };
}

/** What the worker does with the marks: a Redact annotation each, through the page transform, then apply. */
async function redact(bytes: Uint8Array, matches: PhraseMatch[]): Promise<Uint8Array> {
  const { mupdf, doc } = await load(bytes);
  for (let i = 0; i < doc.countPages(); i++) {
    const rects = matches.filter((m) => m.pageIndex === i).flatMap((m) => m.rects);
    if (rects.length === 0) continue;
    const page = doc.loadPage(i) as MuPDF.PDFPage;
    const m = page.getTransform() as unknown as Matrix;
    for (const r of rects) {
      const pts = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]];
      const xs = pts.map(([x, y]) => m[0] * x + m[2] * y + m[4]);
      const ys = pts.map(([x, y]) => m[1] * x + m[3] * y + m[5]);
      const annot = page.createAnnotation('Redact');
      annot.setRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      annot.update();
    }
    page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  }
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

/** Each line of a page's text, as MuPDF reads it. */
async function lines(bytes: Uint8Array, pageIndex: number): Promise<string[]> {
  const { doc } = await load(bytes);
  return doc.loadPage(pageIndex).toStructuredText().asText().split('\n').map((l) => l.trim()).filter(Boolean);
}

const text = (lines: string[]) => lines.join('\n');

function draw(page: ReturnType<PDFDocument['addPage']>, font: PDFFont, rows: string[][], x: number, top: number, leading: number, size = 12) {
  rows.forEach((pieces, i) => {
    // Each piece its own text object, so a match can cross from one to the next.
    let at = x;
    for (const piece of pieces) {
      page.drawText(piece, { x: at, y: top - i * leading, size, font });
      at += font.widthOfTextAtSize(piece, size);
    }
  });
}

describe('findPhrase + redaction: the phrase goes, nothing else does', () => {
  it('on a plain page: tight neighbours, any capitals, a match across two text items', async () => {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 400]);
    draw(page, helv, [
      ['The secret code is WWW and iii'],
      ['isecreti tight on both sides'],
      ['llsecretll and WsecretW'],
      ['Split sec', 'ret across two items'],
      ['SECRET in capitals, and Secret'],
      ['nothing to see on this line'],
    ], 40, 360, 30);
    const bytes = await pdf.save();
    const { doc } = await load(bytes);
    const matches = findPhrase(doc, 'secret');
    expect(matches).toHaveLength(7);
    // One rectangle a match, each far narrower than its line.
    for (const m of matches) {
      expect(m.rects).toHaveLength(1);
      expect(m.rects[0].width).toBeLessThan(helv.widthOfTextAtSize('SECRET', 12) + 4); // the widest way it is written
    }

    const out = await redact(bytes, matches);
    expect(text(await lines(out, 0)).toLowerCase()).not.toContain('secret');
    expect(await lines(out, 0)).toEqual([
      'The', 'code is WWW and iii',
      'i', 'i tight on both sides',
      'll', 'll and W', 'W',
      'Split', 'across two items',
      'in capitals, and',
      'nothing to see on this line',
    ]);
  });

  it('on single-spaced text, the lines above and below keep every letter', async () => {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 300]);
    for (const leading of [12, 14]) {
      draw(page, helv, [['gjpqy above gjpqy'], ['Tight secret leading'], ['ABCDEf below bdhklf']], 40, leading === 12 ? 250 : 150, leading);
    }
    const bytes = await pdf.save();
    const { doc } = await load(bytes);
    const out = await redact(bytes, findPhrase(doc, 'secret'));
    const got = text(await lines(out, 0));
    expect(got).not.toContain('secret');
    expect(got.match(/gjpqy above gjpqy/g)).toHaveLength(2);
    expect(got.match(/ABCDEf below bdhklf/g)).toHaveLength(2);
    expect(got.match(/Tight/g)).toHaveLength(2);
    expect(got.match(/leading/g)).toHaveLength(2);
  });

  it('a match that runs onto the next line gets a mark on each line', async () => {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 300]);
    draw(page, helv, [['Keep this, then the account'], ['number follows here']], 40, 250, 16);
    const bytes = await pdf.save();
    const { doc } = await load(bytes);
    const matches = findPhrase(doc, 'account number');
    expect(matches).toHaveLength(1);
    expect(matches[0].rects).toHaveLength(2);
    const out = await redact(bytes, matches);
    expect(await lines(out, 0)).toEqual(['Keep this, then the', 'follows here']);
  });

  it('on a /Rotate 90 page with an offset crop box', async () => {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of('CropBox'), PDFArray.withContext(pdf.context));
    const crop = page.node.lookup(PDFName.of('CropBox'), PDFArray);
    for (const n of [30, 40, 600, 780]) crop.push(PDFNumber.of(n));
    // Drawn turned so that it reads across the displayed (turned) page.
    page.drawText('Rotated secret text stays', { x: 300, y: 100, size: 14, font: helv, rotate: degrees(90) });
    const bytes = await pdf.save();
    const { doc } = await load(bytes);
    const matches = findPhrase(doc, 'SECRET');
    expect(matches).toHaveLength(1);
    const [r] = matches[0].rects as PdfRect[];
    // In user space the text runs up the page: the mark is tall and thin, over the word only.
    expect(r.height).toBeGreaterThan(r.width);
    expect(r.height).toBeLessThan(helv.widthOfTextAtSize('secret', 14) + 6);
    const out = await redact(bytes, matches);
    expect(await lines(out, 0)).toEqual(['Rotated', 'text stays']);
  });

  it('finds nothing for an empty phrase or one that is not there', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]).drawText('hello', { x: 20, y: 100, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const { doc } = await load(await pdf.save());
    expect(findPhrase(doc, '   ')).toEqual([]);
    expect(findPhrase(doc, 'goodbye')).toEqual([]);
  });
});
