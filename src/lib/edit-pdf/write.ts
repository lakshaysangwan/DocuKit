/**
 * Write the objects a visitor added in Edit PDF into the file.
 *
 * Each object is drawn in its own frame: the box it has on screen, in displayed
 * points with the origin at the box's bottom-left. One `cm` maps that frame
 * into the page's user space through `viewRectToPdfDraw` — the same mapping
 * Sign PDF uses — so the object lands where it was shown on a `/Rotate`d page,
 * on a page whose crop box does not start at 0,0 and on a UserUnit page alike.
 * The frame is clipped to the box, so nothing spills outside what was shown.
 *
 * Two ways to save, as before:
 *
 *   • flatten      the objects become part of the page content (vector: text
 *                  stays real text, pictures are embedded once each);
 *   • annotations  each object is a PDF annotation whose appearance is the same
 *                  drawing, so another PDF app can select, move or delete it.
 *
 * Runs wherever pdf-lib runs; it needs the pages' geometry, which the caller
 * gets from pdf.js (`PdfDocHandle.geometry`).
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { viewRectToPdfDraw, viewRectToPdfRect, type PageGeometry } from '../pdf/page-geometry';
import { countUnclosedGraphicsStates } from '../pdf/content-balance';
import {
  HIGHLIGHT_ALPHA,
  arrowHeadPt,
  baselineEm,
  lineEndsPt,
  stampLayout,
  type EditObject,
} from './objects';

export type SaveMode = 'flatten' | 'annotations';

const KAPPA = 0.5522847498307936;

/** Compact number for a content stream. */
export const n = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = Number.parseInt(h || '000000', 16);
  if (!Number.isFinite(v)) return [0, 0, 0];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const fillColour = (hex: string) => rgb(hex).map(n).join(' ') + ' rg';
const strokeColour = (hex: string) => rgb(hex).map(n).join(' ') + ' RG';

export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `[a b c d e f]`: the object's frame (displayed points, y up, box's bottom-left at 0,0) → user space. */
export type Frame = [number, number, number, number, number, number];

export interface ObjectFrame {
  matrix: Frame;
  /** The box in displayed points. */
  widthPt: number;
  heightPt: number;
}

/** Where an object's frame sits in the page's user space. */
export function objectFrame(geom: PageGeometry, obj: EditObject): ObjectFrame {
  const draw = viewRectToPdfDraw(geom, obj.rect, 0);
  const angle = (draw.rotateDeg * Math.PI) / 180;
  // The angle is always a multiple of 90°: snap so 0 and ±1 are exact.
  const cos = Math.round(Math.cos(angle));
  const sin = Math.round(Math.sin(angle));
  const s = 1 / geom.userUnit;
  return {
    matrix: [cos * s, sin * s, -sin * s, cos * s, draw.x, draw.y],
    widthPt: obj.rect.width * geom.widthPt,
    heightPt: obj.rect.height * geom.heightPt,
  };
}

function apply(m: Frame, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Names of the resources one piece of content refers to. */
interface Names {
  font: () => string;
  boldFont: () => string;
  image: (obj: EditObject & { kind: 'image' }) => string;
  alpha: (opacity: number) => string;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Encode text for `Tj`. Characters Helvetica has no glyph for become "?" rather than failing the save. */
export function encode(font: PDFFont, text: string): string {
  try {
    return font.encodeText(text).toString();
  } catch {
    return font.encodeText(text.replace(/[^\x20-\x7e]/g, '?')).toString();
  }
}

/**
 * The drawing of one object in its own frame (not including the `cm` that
 * places the frame, nor the clip). Units are displayed points, y up.
 */
function objectBody(obj: EditObject, W: number, H: number, names: Names, fonts: Fonts): string {
  const ops: string[] = [];
  const alpha = obj.kind === 'highlight' ? HIGHLIGHT_ALPHA : obj.kind === 'whiteout' ? 1 : obj.opacity;
  if (alpha < 1) ops.push(`/${names.alpha(alpha)} gs`);

  switch (obj.kind) {
    case 'text': {
      const font = names.font();
      ops.push('BT', `/${font} ${n(obj.fontSize)} Tf`, fillColour(obj.color));
      obj.text.split('\n').forEach((line, i) => {
        if (!line) return;
        ops.push(`1 0 0 1 0 ${n(H - baselineEm(i) * obj.fontSize)} Tm`, `${encode(fonts.regular, line)} Tj`);
      });
      ops.push('ET');
      break;
    }
    case 'image':
      ops.push('q', `${n(W)} 0 0 ${n(H)} 0 0 cm`, `/${names.image(obj)} Do`, 'Q');
      break;
    case 'rect':
    case 'ellipse': {
      const lw = Math.min(obj.strokeWidth, W / 2, H / 2);
      ops.push(strokeColour(obj.color), `${n(lw)} w`);
      if (obj.kind === 'rect') {
        ops.push(`${n(lw / 2)} ${n(lw / 2)} ${n(W - lw)} ${n(H - lw)} re`, 'S');
      } else {
        const cx = W / 2;
        const cy = H / 2;
        const rx = (W - lw) / 2;
        const ry = (H - lw) / 2;
        const ox = rx * KAPPA;
        const oy = ry * KAPPA;
        ops.push(
          `${n(cx + rx)} ${n(cy)} m`,
          `${n(cx + rx)} ${n(cy + oy)} ${n(cx + ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
          `${n(cx - ox)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + oy)} ${n(cx - rx)} ${n(cy)} c`,
          `${n(cx - rx)} ${n(cy - oy)} ${n(cx - ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
          `${n(cx + ox)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - oy)} ${n(cx + rx)} ${n(cy)} c`,
          'S',
        );
      }
      break;
    }
    case 'line':
    case 'arrow': {
      // lineEndsPt works y-down; flip into the frame.
      const [x1, y1, x2, y2] = lineEndsPt(obj, W, H);
      ops.push(strokeColour(obj.color), `${n(obj.strokeWidth)} w`, '1 J', '1 j');
      ops.push(`${n(x1)} ${n(H - y1)} m`, `${n(x2)} ${n(H - y2)} l`, 'S');
      if (obj.kind === 'arrow') {
        const [ax, ay, bx, by] = arrowHeadPt(x1, y1, x2, y2, obj.strokeWidth);
        ops.push(`${n(ax)} ${n(H - ay)} m`, `${n(x2)} ${n(H - y2)} l`, `${n(bx)} ${n(H - by)} l`, 'S');
      }
      break;
    }
    case 'draw': {
      if (obj.points.length < 2) break;
      ops.push(strokeColour(obj.color), `${n(obj.strokeWidth)} w`, '1 J', '1 j');
      obj.points.forEach(([px, py], i) => ops.push(`${n(px * W)} ${n(H - py * H)} ${i === 0 ? 'm' : 'l'}`));
      ops.push('S');
      break;
    }
    case 'highlight':
      ops.push(fillColour(obj.color), `0 0 ${n(W)} ${n(H)} re`, 'f');
      break;
    case 'whiteout':
      ops.push('1 1 1 rg', `0 0 ${n(W)} ${n(H)} re`, 'f');
      break;
    case 'stamp': {
      const s = stampLayout(W, H);
      const natural = fonts.bold.widthOfTextAtSize(obj.label, s.fontSize);
      ops.push(
        strokeColour(obj.color),
        `${n(s.lineWidth)} w`,
        `${n(s.lineWidth / 2)} ${n(s.lineWidth / 2)} ${n(W - s.lineWidth)} ${n(H - s.lineWidth)} re`,
        'S',
        'BT',
        `/${names.boldFont()} ${n(s.fontSize)} Tf`,
        fillColour(obj.color),
        `${n((100 * s.textWidth) / natural)} Tz`,
        `1 0 0 1 ${n(s.textX)} ${n(H - s.baseline)} Tm`,
        `${encode(fonts.bold, obj.label)} Tj`,
        'ET',
      );
      break;
    }
  }
  return ops.join('\n');
}

/** The object's content in its frame, clipped to its box. */
function framedBody(frame: ObjectFrame, body: string): string {
  const [a, b, c, d, e, f] = frame.matrix;
  return [
    'q',
    `${[a, b, c, d, e, f].map(n).join(' ')} cm`,
    `0 0 ${n(frame.widthPt)} ${n(frame.heightPt)} re W n`,
    body,
    'Q',
  ].join('\n');
}

/** Concatenated, decoded page content — to count the graphics states it leaves open. */
export function unclosedStates(doc: PDFDocument, page: PDFPage): number {
  try {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((e) => doc.context.lookup(e)) : [contents];
    const parts: Uint8Array[] = [];
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode(), new Uint8Array([10]));
    }
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      all.set(p, offset);
      offset += p.length;
    }
    return countUnclosedGraphicsStates(all);
  } catch {
    return 0;
  }
}

export interface WriteOptions {
  mode: SaveMode;
  /** Displayed geometry of every page an object is on. */
  geometry: (pageIndex: number) => PageGeometry;
}

/**
 * Add `objects` to `doc` (in place). Text objects must already be plain ASCII
 * — the caller turns any other text into a picture first, so that what was
 * shown in the browser's font is what is saved.
 */
export async function writeEditObjects(doc: PDFDocument, objects: EditObject[], options: WriteOptions): Promise<void> {
  if (objects.length === 0) return;
  const context = doc.context;
  const pages = doc.getPages();

  let fonts: Fonts | null = null;
  const getFonts = async (): Promise<Fonts> => {
    if (!fonts) {
      fonts = {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
      };
    }
    return fonts;
  };
  // Fonts are cheap references to the standard 14; embed both once if any object uses text.
  const needsFonts = objects.some((o) => o.kind === 'text' || o.kind === 'stamp');
  const f = needsFonts ? await getFonts() : ({} as Fonts);

  // Each picture is stored once, however many times it is drawn.
  const images = new Map<string, PDFImage>();
  for (const o of objects) {
    if (o.kind !== 'image' || images.has(o.src)) continue;
    const bytes = dataUrlBytes(o.src);
    images.set(o.src, o.mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
  }
  const alphaState = (opacity: number) => context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity });

  const byPage = new Map<number, EditObject[]>();
  for (const o of objects) {
    if (!pages[o.pageIndex]) continue;
    byPage.set(o.pageIndex, [...(byPage.get(o.pageIndex) ?? []), o]);
  }

  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    const geom = options.geometry(pageIndex);

    if (options.mode === 'flatten') {
      page.node.normalize();
      const fontName = new Map<string, string>();
      const imageName = new Map<string, string>();
      const alphaName = new Map<number, string>();
      const names: Names = {
        font: () => {
          if (!fontName.has('r')) fontName.set('r', page.node.newFontDictionary('EdHelv', f.regular.ref).asString().slice(1));
          return fontName.get('r')!;
        },
        boldFont: () => {
          if (!fontName.has('b')) fontName.set('b', page.node.newFontDictionary('EdHelvB', f.bold.ref).asString().slice(1));
          return fontName.get('b')!;
        },
        image: (o) => {
          if (!imageName.has(o.src)) imageName.set(o.src, page.node.newXObject('EdImg', images.get(o.src)!.ref).asString().slice(1));
          return imageName.get(o.src)!;
        },
        alpha: (opacity) => {
          if (!alphaName.has(opacity)) alphaName.set(opacity, page.node.newExtGState('EdGS', alphaState(opacity)).asString().slice(1));
          return alphaName.get(opacity)!;
        },
      };

      const parts = list.map((o) => {
        const frame = objectFrame(geom, o);
        return framedBody(frame, objectBody(o, frame.widthPt, frame.heightPt, names, f));
      });

      // Close whatever the page's own content leaves open, so the objects are
      // drawn in the page's default coordinates — see content-balance.ts.
      const open = unclosedStates(doc, page);
      const raw = page.node.get(PDFName.of('Contents'));
      const existing = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
      const start = context.register(context.flateStream('q\n'));
      const end = context.register(context.flateStream(`${'Q\n'.repeat(open + 1)}${parts.join('\n')}\n`));
      page.node.set(PDFName.of('Contents'), context.obj([start, ...existing, end]));
      continue;
    }

    // Annotations: the same drawing, as each annotation's appearance.
    const refs: PDFRef[] = [];
    for (const o of list) {
      const frame = objectFrame(geom, o);
      const resources: Record<string, Record<string, PDFRef | PDFDict>> = {};
      const add = (group: string, name: string, value: PDFRef | PDFDict) => {
        resources[group] = { ...(resources[group] ?? {}), [name]: value };
        return name;
      };
      const names: Names = {
        font: () => add('Font', 'Helv', f.regular.ref),
        boldFont: () => add('Font', 'HelvB', f.bold.ref),
        image: (img) => add('XObject', 'Img', images.get(img.src)!.ref),
        alpha: (opacity) => add('ExtGState', 'GS', alphaState(opacity) as PDFDict),
      };
      const body = objectBody(o, frame.widthPt, frame.heightPt, names, f);
      const appearance = context.register(
        context.flateStream(`0 0 ${n(frame.widthPt)} ${n(frame.heightPt)} re W n\n${body}`, {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, frame.widthPt, frame.heightPt],
          Matrix: frame.matrix,
          Resources: context.obj(resources),
        }),
      );
      const area = viewRectToPdfRect(geom, o.rect);
      const rect = [area.x, area.y, area.x + area.width, area.y + area.height];
      const common = { Type: 'Annot', Rect: rect, F: 4, AP: { N: appearance } };
      const toUser = (x: number, yDown: number) => apply(frame.matrix, x, frame.heightPt - yDown);
      const s = 1 / geom.userUnit;
      let dict: Record<string, unknown>;
      switch (o.kind) {
        case 'text':
          dict = {
            ...common,
            Subtype: 'FreeText',
            Contents: PDFString.of(o.text),
            DA: PDFString.of(`/Helv ${n(o.fontSize * s)} Tf ${fillColour(o.color)}`),
            Q: 0,
          };
          break;
        case 'rect':
        case 'ellipse':
          dict = { ...common, Subtype: o.kind === 'rect' ? 'Square' : 'Circle', C: rgb(o.color), BS: { W: o.strokeWidth * s, S: 'S' } };
          break;
        case 'line':
        case 'arrow': {
          const [x1, y1, x2, y2] = lineEndsPt(o, frame.widthPt, frame.heightPt);
          dict = {
            ...common,
            Subtype: 'Line',
            L: [...toUser(x1, y1), ...toUser(x2, y2)],
            LE: o.kind === 'arrow' ? ['None', 'OpenArrow'] : ['None', 'None'],
            C: rgb(o.color),
            BS: { W: o.strokeWidth * s, S: 'S' },
          };
          break;
        }
        case 'draw':
          dict = {
            ...common,
            Subtype: 'Ink',
            InkList: [o.points.flatMap(([px, py]) => toUser(px * frame.widthPt, py * frame.heightPt))],
            C: rgb(o.color),
            BS: { W: o.strokeWidth * s, S: 'S' },
          };
          break;
        case 'highlight':
          dict = { ...common, Subtype: 'Square', C: rgb(o.color), IC: rgb(o.color), BS: { W: 0, S: 'S' } };
          break;
        case 'whiteout':
          dict = { ...common, Subtype: 'Square', C: [1, 1, 1], IC: [1, 1, 1], BS: { W: 0, S: 'S' } };
          break;
        case 'stamp':
          dict = { ...common, Subtype: 'Stamp', Contents: PDFString.of(o.label) };
          break;
        case 'image':
          dict = { ...common, Subtype: 'Stamp' };
          break;
      }
      refs.push(context.register(context.obj(dict as Parameters<typeof context.obj>[0])));
    }
    let annots = page.node.Annots();
    if (!annots) {
      annots = context.obj([]);
      page.node.set(PDFName.of('Annots'), annots);
    }
    for (const ref of refs) annots.push(ref);
  }
}
