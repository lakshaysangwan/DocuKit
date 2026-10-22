import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, degrees } from 'pdf-lib';
import { makePageGeometry, pdfPointToView, type PageGeometry } from './pdf/page-geometry';
import { DEFAULT_PAGE_NUMBER_OPTIONS, PAGE_NUMBER_POSITIONS, layoutPageNumber } from './page-number-layout';
import { writePageNumbers, type PageNumberWriteOptions } from './page-number-write';

/**
 * Every number lands in the file exactly where the layout — and so the
 * preview — put it, and reads upright on the displayed page: the frame
 * (`q a b c d e f cm BT … Tj ET Q`) is read back from the saved content, its
 * box mapped to the displayed page with the inverse page geometry and
 * compared with the layout's box; its x axis must run left-to-right on screen.
 * On every `/Rotate`, an offset crop box, UserUnit, and a page that leaves
 * graphics states open.
 */

interface Case {
  name: string;
  media: [number, number, number, number];
  crop?: [number, number, number, number];
  rotate: number;
  userUnit?: number;
}

const CASES: Case[] = [
  { name: 'plain Letter', media: [0, 0, 612, 792], rotate: 0 },
  { name: '/Rotate 90', media: [0, 0, 612, 792], rotate: 90 },
  { name: '/Rotate 180', media: [0, 0, 612, 792], rotate: 180 },
  { name: '/Rotate 270', media: [0, 0, 612, 792], rotate: 270 },
  { name: 'offset crop box', media: [0, 0, 612, 792], crop: [50, 100, 562, 742], rotate: 0 },
  { name: 'offset crop box, /Rotate 270', media: [0, 0, 600, 800], crop: [50, 60, 550, 760], rotate: 270 },
  { name: 'UserUnit 2', media: [0, 0, 300, 400], rotate: 0, userUnit: 2 },
];

async function makePdf(c: Case, pages = 3, unbalanced = false): Promise<{ doc: PDFDocument; geom: PageGeometry }> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([c.media[2] - c.media[0], c.media[3] - c.media[1]]);
    if (c.crop) page.setCropBox(c.crop[0], c.crop[1], c.crop[2] - c.crop[0], c.crop[3] - c.crop[1]);
    page.setRotation(degrees(c.rotate));
    if (c.userUnit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(c.userUnit));
    page.drawRectangle({ x: 100, y: 100, width: 50, height: 50 });
    if (unbalanced) {
      const s = doc.context.flateStream('q 0.5 0 0 0.5 150 200 cm q 0.5 0 0 0.5 0 0 cm 0 0 400 300 re f');
      const contents = page.node.get(PDFName.of('Contents'));
      const list = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
      page.node.set(PDFName.of('Contents'), doc.context.obj([...list, doc.context.register(s)]));
    }
  }
  return { doc, geom: makePageGeometry({ view: c.crop ?? c.media, rotate: c.rotate, userUnit: c.userUnit }) };
}

function streamsOf(doc: PDFDocument, pageIndex = 0): string[] {
  const page = doc.getPages()[pageIndex];
  const raw = page.node.get(PDFName.of('Contents'));
  const entries = raw instanceof PDFArray ? raw.asArray() : [raw];
  return entries.map((e) => {
    const s = e instanceof PDFRef ? doc.context.lookup(e) : e;
    if (!(s instanceof PDFRawStream)) return '';
    const bytes = Buffer.from(s.getContents());
    try {
      return inflateSync(bytes).toString('latin1');
    } catch {
      return bytes.toString('latin1');
    }
  });
}

const NUM = '(-?\\d*\\.?\\d+(?:e-?\\d+)?)';
const FRAME = new RegExp(`q ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm BT /(\\S+) ${NUM} Tf 1 0 0 1 0 ${NUM} Tm <([0-9A-Fa-f]*)> Tj ET Q`, 'g');

interface Frame {
  matrix: number[];
  fontSize: number;
  baseline: number;
  text: string;
}

function frames(content: string): Frame[] {
  return [...content.matchAll(FRAME)].map((m) => ({
    matrix: m.slice(1, 7).map(Number),
    fontSize: Number(m[8]),
    baseline: Number(m[9]),
    text: Buffer.from(m[10], 'hex').toString('latin1'),
  }));
}

const OPTIONS: PageNumberWriteOptions = { ...DEFAULT_PAGE_NUMBER_OPTIONS, color: '#cc0000', fontSize: 12 };

describe('writePageNumbers — every number where the layout put it, upright', () => {
  for (const c of CASES) {
    for (const position of PAGE_NUMBER_POSITIONS) {
      it(`${c.name}: ${position}`, async () => {
        const { doc, geom } = await makePdf(c);
        const options = { ...OPTIONS, position };
        await writePageNumbers(doc, [0, 1, 2].map((pageIndex) => ({ pageIndex, geometry: geom })), options);
        for (let i = 0; i < 3; i++) {
          const found = frames(streamsOf(doc, i).join('\n'));
          const want = layoutPageNumber(geom, i, 3, options)!;
          expect(found.map((f) => f.text)).toEqual([want.text]);
          const [a, b, cc, d, e, f] = found[0].matrix;
          const at = (u: number, v: number) => pdfPointToView(geom, a * u + cc * v + e, b * u + d * v + f);
          const [blx, bly] = at(0, 0);
          const [trx, try_] = at(want.boxWidthPt, want.boxHeightPt);
          expect(blx).toBeCloseTo(want.rect.x, 4);
          expect(bly).toBeCloseTo(want.rect.y + want.rect.height, 4);
          expect(trx).toBeCloseTo(want.rect.x + want.rect.width, 4);
          expect(try_).toBeCloseTo(want.rect.y, 4);
          expect(found[0].fontSize).toBe(12);
          expect(found[0].baseline).toBeCloseTo(want.baselinePt, 3);
        }
      });
    }
  }
});

describe('writePageNumbers — content', () => {
  it('skipped pages are untouched; the font, colour and size are the chosen ones', async () => {
    const { doc, geom } = await makePdf(CASES[0], 4);
    const before = streamsOf(doc, 0);
    await writePageNumbers(doc, [0, 1, 2, 3].map((pageIndex) => ({ pageIndex, geometry: geom })), {
      ...OPTIONS,
      skipFirstN: 2,
      startNumber: 5,
      format: 'n-of-total',
      font: 'Courier',
    });
    expect(streamsOf(doc, 0)).toEqual(before);
    expect(frames(streamsOf(doc, 1).join('\n'))).toEqual([]);
    expect(frames(streamsOf(doc, 2).join('\n')).map((f) => f.text)).toEqual(['5/2']);
    expect(frames(streamsOf(doc, 3).join('\n')).map((f) => f.text)).toEqual(['6/2']);
    expect(streamsOf(doc, 3).join('\n')).toContain('0.8 0 0 rg');
    const saved = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
    expect(saved).toContain('/Courier');
    expect(saved).not.toContain('/Helvetica');
  });

  it('after closing the states the page left open, as the last stream', async () => {
    const { doc, geom } = await makePdf(CASES[0], 1, true);
    await writePageNumbers(doc, [{ pageIndex: 0, geometry: geom }], OPTIONS);
    const streams = streamsOf(doc);
    expect(streams[0].trim()).toBe('q');
    const last = streams[streams.length - 1];
    expect(last.startsWith('Q\nQ\nQ\nq')).toBe(true);
    expect(frames(last).map((f) => f.text)).toEqual(['Page 1 of 1']);
  });

  it('a balanced page gets one Q (closing the wrapping q)', async () => {
    const { doc, geom } = await makePdf(CASES[0], 1);
    await writePageNumbers(doc, [{ pageIndex: 0, geometry: geom }], OPTIONS);
    const streams = streamsOf(doc);
    expect(streams[streams.length - 1].startsWith('Q\nq')).toBe(true);
  });
});
