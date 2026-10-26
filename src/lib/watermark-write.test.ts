import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, degrees } from 'pdf-lib';
import { makePageGeometry, pdfPointToView, type PageGeometry } from './pdf/page-geometry';
import { layoutWatermark, type WatermarkPlacement } from './watermark-layout';
import { writeWatermark, type WatermarkWriteOptions } from './watermark-write';

/**
 * The watermark lands in the file exactly where the layout — and so the
 * preview — put it: every copy's frame (`q a b c d e f cm … Q`) is read back
 * out of the saved content and its four corners mapped to the displayed page
 * with the inverse of the page geometry, then compared with the corners of the
 * layout's box turned about its centre. On every `/Rotate`, an offset crop
 * box, UserUnit, and a page that leaves graphics states open.
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
  { name: 'offset crop box, /Rotate 90', media: [0, 0, 600, 800], crop: [50, 60, 550, 760], rotate: 90 },
  { name: 'UserUnit 2', media: [0, 0, 300, 400], rotate: 0, userUnit: 2 },
];

async function makePdf(c: Case, unbalanced = false): Promise<{ doc: PDFDocument; geom: PageGeometry }> {
  const doc = await PDFDocument.create();
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
const FRAME = new RegExp(`q ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm `, 'g');

type Pt = [number, number];

/** Each copy's frame in the content: its box's corners on the displayed page, as fractions. */
function framesInView(content: string, geom: PageGeometry, boxW: number, boxH: number): Pt[][] {
  return [...content.matchAll(FRAME)].map((m) => {
    const [a, b, c, d, e, f] = m.slice(1, 7).map(Number);
    return (
      [
        [0, 0],
        [boxW, 0],
        [boxW, boxH],
        [0, boxH],
      ] as Pt[]
    ).map(([u, v]) => pdfPointToView(geom, a * u + c * v + e, b * u + d * v + f));
  });
}

/** The corners of a placement on the displayed page (bottom-left, bottom-right, top-right, top-left of the box), turned clockwise about its centre. */
function layoutCorners(p: WatermarkPlacement, geom: PageGeometry): Pt[] {
  const W = geom.widthPt;
  const H = geom.heightPt;
  const x = p.rect.x * W;
  const y = p.rect.y * H;
  const w = p.rect.width * W;
  const h = p.rect.height * H;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const t = (p.rotation * Math.PI) / 180;
  const turn = ([px, py]: Pt): Pt => {
    const dx = px - cx;
    const dy = py - cy;
    return [(cx + dx * Math.cos(t) - dy * Math.sin(t)) / W, (cy + dx * Math.sin(t) + dy * Math.cos(t)) / H];
  };
  return ([
    [x, y + h],
    [x + w, y + h],
    [x + w, y],
    [x, y],
  ] as Pt[]).map(turn);
}

function expectSameCorners(actual: Pt[], expected: Pt[], what: string) {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(actual[i][0] - expected[i][0]), `${what} corner ${i} x`).toBeLessThan(1e-4);
    expect(Math.abs(actual[i][1] - expected[i][1]), `${what} corner ${i} y`).toBeLessThan(1e-4);
  }
}

const TEXT: WatermarkWriteOptions = {
  type: 'text',
  text: 'CONFIDENTIAL',
  font: 'Helvetica-Bold',
  fontSize: 40,
  color: '#ff0000',
  opacity: 0.3,
  rotation: -45,
  placement: 'single',
  position: 'center',
  layer: 'front',
};

// A 2×1 PNG (red, blue).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDwHwAJ/wH/qGkK3wAAAABJRU5ErkJggg==',
  'base64',
);

describe('writeWatermark — placements match the layout', () => {
  for (const c of CASES) {
    for (const variant of [
      { label: 'text, single, turned', options: TEXT },
      { label: 'text, tiled, unturned', options: { ...TEXT, placement: 'tiled' as const, rotation: 0 } },
      { label: 'text, custom position near a corner, turned', options: { ...TEXT, position: 'custom' as const, centre: { x: 0.15, y: 0.85 }, rotation: 25 } },
      { label: 'image, single, turned', options: { ...TEXT, type: 'image' as const, imageBytes: new Uint8Array(PNG), imageMime: 'image/png' as const, imageWidthPx: 2, imageHeightPx: 1, imageScale: 0.3, rotation: 30 } },
      { label: 'image, tiled, turned', options: { ...TEXT, type: 'image' as const, imageBytes: new Uint8Array(PNG), imageMime: 'image/png' as const, imageWidthPx: 2, imageHeightPx: 1, imageScale: 0.2, rotation: -20, placement: 'tiled' as const } },
    ]) {
      it(`${c.name}: ${variant.label}`, async () => {
        const { doc, geom } = await makePdf(c);
        await writeWatermark(doc, [{ pageIndex: 0, geometry: geom }], variant.options);
        const saved = await PDFDocument.load(await doc.save());
        const content = streamsOf(saved).join('\n');
        const layout = layoutWatermark(geom, variant.options);
        const frames = framesInView(content, geom, layout.boxWidthPt, layout.boxHeightPt);
        expect(frames.length).toBe(layout.placements.length);
        expect(frames.length).toBeGreaterThan(0);
        layout.placements.forEach((p, i) => expectSameCorners(frames[i], layoutCorners(p, geom), `copy ${i}`));
      });
    }
  }
});

describe('writeWatermark — content', () => {
  it('writes the text in the chosen standard font, size and colour, on the layout baseline', async () => {
    const { doc, geom } = await makePdf(CASES[0]);
    await writeWatermark(doc, [{ pageIndex: 0, geometry: geom }], { ...TEXT, font: 'Times-Bold' });
    const bytes = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
    expect(bytes).toContain('/Times-Bold');
    const content = streamsOf(doc).join('\n');
    const layout = layoutWatermark(geom, { ...TEXT, font: 'Times-Bold' });
    expect(content).toMatch(new RegExp(`/WmF\\S* 40 Tf 1 0 0 1 0 ${layout.baselinePt.toFixed(3).replace(/0+$/, '')}`));
    expect(content).toContain('1 0 0 rg');
  });

  it('applies the opacity through an ExtGState', async () => {
    const { doc, geom } = await makePdf(CASES[0]);
    await writeWatermark(doc, [{ pageIndex: 0, geometry: geom }], { ...TEXT, opacity: 0.45 });
    const content = streamsOf(doc).join('\n');
    const name = content.match(/\/(WmGS\S*) gs/)?.[1];
    expect(name).toBeTruthy();
    const states = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('ExtGState')) as import('pdf-lib').PDFDict;
    const state = states.lookup(PDFName.of(name!)) as import('pdf-lib').PDFDict;
    expect((state.lookup(PDFName.of('ca')) as PDFNumber).asNumber()).toBe(0.45);
  });

  it('on top: last stream, after closing the states the page left open', async () => {
    const { doc, geom } = await makePdf(CASES[0], true);
    await writeWatermark(doc, [{ pageIndex: 0, geometry: geom }], TEXT);
    const streams = streamsOf(doc);
    const last = streams[streams.length - 1];
    expect(streams[0].trim()).toBe('q');
    // The page leaves two states open; one more Q closes pdf-lib-style wrapping q.
    expect(last.startsWith('Q\nQ\nQ\nq')).toBe(true);
    expect(last).toContain(' Tj ');
  });

  it('behind: a self-contained first stream, the page content untouched after it', async () => {
    const { doc, geom } = await makePdf(CASES[0], true);
    const before = streamsOf(doc);
    await writeWatermark(doc, [{ pageIndex: 0, geometry: geom }], { ...TEXT, layer: 'behind' });
    const streams = streamsOf(doc);
    expect(streams.length).toBe(before.length + 1);
    expect(streams[0]).toContain(' Tj ');
    expect(streams.slice(1)).toEqual(before);
    const qs = (streams[0].match(/(^|\s)q(?=\s)/g) ?? []).length;
    const Qs = (streams[0].match(/(^|\s)Q(?=\s)/g) ?? []).length;
    expect(qs).toBe(Qs);
  });

  it('only touches the target pages, and stores an image once', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 5, height: 5 });
    const geom = makePageGeometry({ view: [0, 0, 612, 792], rotate: 0 });
    const options: WatermarkWriteOptions = { ...TEXT, type: 'image', imageBytes: new Uint8Array(PNG), imageMime: 'image/png', imageWidthPx: 2, imageHeightPx: 1, imageScale: 0.3 };
    await writeWatermark(doc, [0, 2].map((pageIndex) => ({ pageIndex, geometry: geom })), options);
    expect(streamsOf(doc, 0).join('\n')).toContain(' Do');
    expect(streamsOf(doc, 1).join('\n')).not.toContain(' Do');
    expect(streamsOf(doc, 2).join('\n')).toContain(' Do');
    const saved = await PDFDocument.load(await doc.save());
    let images = 0;
    for (const [, obj] of saved.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') images++;
    }
    expect(images).toBe(1);
  });
});
