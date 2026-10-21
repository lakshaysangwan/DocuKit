import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, degrees } from 'pdf-lib';
import { makePageGeometry, pdfPointToView, type PageGeometry, type RectNorm } from '../pdf/page-geometry';
import { newObject, type EditObject, type TextObject } from './objects';
import { writeEditObjects } from './write';

/**
 * The objects land in the file where their boxes were on the displayed page:
 * each object's frame (`q … cm  0 0 W H re W n`) is read back out of the saved
 * content stream and its four corners mapped to the view with the inverse of
 * the page geometry — on a plain page, a /Rotate 90 page and a page whose crop
 * box does not start at the origin.
 */

interface Case {
  name: string;
  media: [number, number, number, number];
  crop?: [number, number, number, number];
  rotate: number;
}

const CASES: Case[] = [
  { name: 'plain A4', media: [0, 0, 595.28, 841.89], rotate: 0 },
  { name: '/Rotate 90', media: [0, 0, 595.28, 841.89], rotate: 90 },
  { name: 'offset crop box', media: [0, 0, 600, 800], crop: [50, 60, 550, 760], rotate: 0 },
  { name: 'offset crop box, /Rotate 270', media: [0, 0, 600, 800], crop: [50, 60, 550, 760], rotate: 270 },
];

async function makePdf(c: Case, unbalanced = false): Promise<{ doc: PDFDocument; geom: PageGeometry }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([c.media[2] - c.media[0], c.media[3] - c.media[1]]);
  page.setMediaBox(c.media[0], c.media[1], c.media[2] - c.media[0], c.media[3] - c.media[1]);
  if (c.crop) page.setCropBox(c.crop[0], c.crop[1], c.crop[2] - c.crop[0], c.crop[3] - c.crop[1]);
  page.setRotation(degrees(c.rotate));
  // Some page content, optionally leaving two graphics states open.
  page.drawRectangle({ x: 100, y: 100, width: 50, height: 50 });
  if (unbalanced) {
    const s = doc.context.flateStream('q q 2 0 0 2 0 0 cm');
    const contents = page.node.get(PDFName.of('Contents'));
    const list = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    page.node.set(PDFName.of('Contents'), doc.context.obj([...list, doc.context.register(s)]));
  }
  const view = c.crop ?? c.media;
  return { doc, geom: makePageGeometry({ view, rotate: c.rotate }) };
}

function contentOf(doc: PDFDocument): string {
  const page = doc.getPages()[0];
  const raw = page.node.get(PDFName.of('Contents'));
  const entries = raw instanceof PDFArray ? raw.asArray() : [raw];
  return entries
    .map((e) => {
      const s = e instanceof PDFRef ? doc.context.lookup(e) : e;
      if (!(s instanceof PDFRawStream)) return '';
      const bytes = Buffer.from(s.getContents());
      try {
        return inflateSync(bytes).toString('latin1');
      } catch {
        return bytes.toString('latin1');
      }
    })
    .join('\n');
}

const NUM = '(-?\\d*\\.?\\d+)';
const FRAME = new RegExp(`q\\n${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm\\n0 0 ${NUM} ${NUM} re W n`, 'g');

/** Each object frame in the content, as the box it covers on the displayed page. */
function framesInView(content: string, geom: PageGeometry): RectNorm[] {
  return [...content.matchAll(FRAME)].map((m) => {
    const [a, b, c, d, e, f, w, h] = m.slice(1, 9).map(Number);
    const corners = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ].map(([u, v]) => pdfPointToView(geom, a * u + c * v + e, b * u + d * v + f));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  });
}

function expectRect(actual: RectNorm, expected: RectNorm) {
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(actual[k]).toBeCloseTo(expected[k], 5);
}

function objectsFor(geom: PageGeometry): EditObject[] {
  const base = { pageIndex: 0, page: geom };
  const rect = newObject('rect', { ...base, id: 'r' });
  const text = newObject('text', { ...base, id: 't' }) as TextObject;
  const arrow = newObject('arrow', { ...base, id: 'a' });
  return [
    { ...rect, rect: { x: 0.1, y: 0.15, width: 0.3, height: 0.2 } },
    { ...text, rect: { ...text.rect, x: 0.55, y: 0.6 }, fontSize: 16 },
    { ...arrow, rect: { x: 0.2, y: 0.8, width: 0.5, height: 0.05 } },
  ];
}

describe('writeEditObjects — flatten', () => {
  for (const c of CASES) {
    it(`puts every box where it was shown: ${c.name}`, async () => {
      const { doc, geom } = await makePdf(c);
      const objects = objectsFor(geom);
      await writeEditObjects(doc, objects, { mode: 'flatten', geometry: () => geom });
      const saved = await PDFDocument.load(await doc.save());
      const frames = framesInView(contentOf(saved), geom);
      expect(frames).toHaveLength(objects.length);
      frames.forEach((f, i) => expectRect(f, objects[i].rect));
    });
  }

  it('writes text as real Helvetica at the chosen font size', async () => {
    const { doc, geom } = await makePdf(CASES[0]);
    const text = { ...(newObject('text', { id: 't', pageIndex: 0, page: geom }) as TextObject), fontSize: 30 };
    await writeEditObjects(doc, [text], { mode: 'flatten', geometry: () => geom });
    const content = contentOf(await PDFDocument.load(await doc.save()));
    expect(content).toMatch(/\/EdHelv\S* 30 Tf/);
  });

  it('applies opacity through a named ExtGState the page resources hold', async () => {
    const { doc, geom } = await makePdf(CASES[0]);
    const faint = { ...newObject('rect', { id: 'r', pageIndex: 0, page: geom }), opacity: 0.4 };
    await writeEditObjects(doc, [faint], { mode: 'flatten', geometry: () => geom });
    const saved = await PDFDocument.load(await doc.save());
    const name = contentOf(saved).match(/\n\/(\S+) gs\n/)?.[1];
    expect(name).toBeTruthy();
    const states = saved.getPages()[0].node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict);
    const state = states.lookup(PDFName.of(name!), PDFDict);
    expect((state.lookup(PDFName.of('ca'), PDFNumber) as PDFNumber).asNumber()).toBe(0.4);
  });

  it('closes graphics states the page leaves open before drawing', async () => {
    const { doc, geom } = await makePdf(CASES[0], true);
    await writeEditObjects(doc, objectsFor(geom), { mode: 'flatten', geometry: () => geom });
    const content = contentOf(await PDFDocument.load(await doc.save()));
    // Two left open by the page plus the one opened around the page's content.
    expect(content).toMatch(/Q\nQ\nQ\nq\n/);
    const frames = framesInView(content, geom);
    expectRect(frames[0], { x: 0.1, y: 0.15, width: 0.3, height: 0.2 });
  });
});

describe('writeEditObjects — annotations', () => {
  for (const c of CASES) {
    it(`each annotation covers the box that was shown: ${c.name}`, async () => {
      const { doc, geom } = await makePdf(c);
      const objects = objectsFor(geom);
      await writeEditObjects(doc, objects, { mode: 'annotations', geometry: () => geom });
      const saved = await PDFDocument.load(await doc.save());
      const annots = saved.getPages()[0].node.Annots()!.asArray().map((r) => saved.context.lookup(r) as PDFDict);
      expect(annots.map((a) => (a.get(PDFName.of('Subtype')) as PDFName).asString())).toEqual([
        '/Square',
        '/FreeText',
        '/Line',
      ]);
      annots.forEach((a, i) => {
        const [x1, y1, x2, y2] = (a.get(PDFName.of('Rect')) as PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
        const p = pdfPointToView(geom, x1, y1);
        const q = pdfPointToView(geom, x2, y2);
        expectRect(
          { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), width: Math.abs(q[0] - p[0]), height: Math.abs(q[1] - p[1]) },
          objects[i].rect,
        );
      });
    });
  }
});
