/**
 * Emit real PDF annotation objects (FreeText / Square / Circle / Line / Ink /
 * Stamp) from the editor's plain-data annotation model, instead of flattening
 * them into the page content. Each annotation carries a normal appearance
 * stream (`/AP /N`) so it renders in every viewer, while remaining a first-class
 * annotation object that Adobe Reader (etc.) can select, move and delete.
 *
 * Coordinate model: the editor canvas uses a top-left origin (y grows down) at
 * pdf.js scale 1, so canvas dimensions ≈ PDF points. PDF user space has a
 * bottom-left origin (y grows up). We map per page from the rendered canvas
 * dimensions to the real page size so odd/rotated/scaled pages stay aligned.
 */
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFArray,
  PDFRef,
  PDFFont,
  StandardFonts,
} from 'pdf-lib';
import type { AnnotationObject } from '@/components/islands/edit-pdf/AnnotationCanvas';

const KAPPA = 0.5522847498307936;

/** Parse a #rgb / #rrggbb hex string into PDF unit color components (0–1). */
function col(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h || '000000', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Escape a string for a PDF literal string in a content stream. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r?\n/g, '');
}

/** Trim a number to a compact PDF-friendly representation. */
function n(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

interface PageMap {
  /** PDF page height in points (for y-flip). */
  pdfH: number;
  /** canvas→PDF scale on each axis. */
  sx: number;
  sy: number;
}

/** Context shared while building one document's annotations. */
interface Ctx {
  pdfDoc: PDFDocument;
  helv?: PDFFont;
  helvBold?: PDFFont;
}

async function getHelv(ctx: Ctx): Promise<PDFFont> {
  if (!ctx.helv) ctx.helv = await ctx.pdfDoc.embedFont(StandardFonts.Helvetica);
  return ctx.helv;
}
async function getHelvBold(ctx: Ctx): Promise<PDFFont> {
  if (!ctx.helvBold) ctx.helvBold = await ctx.pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return ctx.helvBold;
}

/** Register a Form XObject appearance stream and return its ref. */
function appearance(
  ctx: Ctx,
  rect: [number, number, number, number],
  content: string,
  resources?: Record<string, any>,
): PDFRef {
  const context = ctx.pdfDoc.context;
  const dict: Record<string, any> = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: rect,
  };
  if (resources) dict.Resources = context.obj(resources);
  const stream = context.stream(content, dict);
  return context.register(stream);
}

/** Convert a canvas rect (top-left origin) to a PDF rect [llx, lly, urx, ury]. */
function toPdfRect(m: PageMap, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const llx = x * m.sx;
  const urx = (x + w) * m.sx;
  const ury = m.pdfH - y * m.sy;
  const lly = m.pdfH - (y + h) * m.sy;
  return [llx, lly, urx, ury];
}

/**
 * Build the annotation dictionary for a single editor object, returning its
 * indirect ref (or null if it produced nothing renderable).
 */
async function buildAnnot(ctx: Ctx, m: PageMap, o: AnnotationObject): Promise<PDFRef | null> {
  const context = ctx.pdfDoc.context;
  const opacity = Math.max(0, Math.min(1, o.opacity ?? 1));
  const lineScale = (m.sx + m.sy) / 2;

  switch (o.type) {
    case 'text': {
      const font = await getHelv(ctx);
      const fsPdf = o.fontSize * m.sy;
      const lines = o.text.split('\n');
      const [r, g, b] = col(o.color);
      const xPdf = o.x * m.sx;
      const topY = m.pdfH - o.y * m.sy;
      const lineH = fsPdf * 1.2;
      const width = Math.max(...lines.map((l) => font.widthOfTextAtSize(l || ' ', fsPdf))) + fsPdf * 0.5;
      const height = lines.length * lineH + fsPdf * 0.4;
      const rect: [number, number, number, number] = [xPdf, topY - height, xPdf + width, topY];
      const baseline0 = topY - fsPdf * 0.9;
      let body = `BT\n/Helv ${n(fsPdf)} Tf\n${n(r)} ${n(g)} ${n(b)} rg\n${n(xPdf)} ${n(baseline0)} Td\n`;
      lines.forEach((l, i) => {
        if (i > 0) body += `0 ${n(-lineH)} Td\n`;
        body += `(${esc(l)}) Tj\n`;
      });
      body += 'ET';
      const ap = appearance(ctx, rect, body, { Font: { Helv: font.ref } });
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'FreeText',
          Rect: rect,
          Contents: PDFString.of(o.text),
          DA: PDFString.of(`/Helv ${n(fsPdf)} Tf ${n(r)} ${n(g)} ${n(b)} rg`),
          Q: 0,
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'rect': {
      const [llx, lly, urx, ury] = toPdfRect(m, o.x, o.y, o.w, o.h);
      const [r, g, b] = col(o.stroke);
      const lw = o.strokeWidth * lineScale;
      const inset = lw / 2;
      const body = `${n(r)} ${n(g)} ${n(b)} RG\n${n(lw)} w\n${n(llx + inset)} ${n(lly + inset)} ${n(urx - llx - lw)} ${n(ury - lly - lw)} re\nS`;
      const rect: [number, number, number, number] = [llx, lly, urx, ury];
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: rect,
          C: [r, g, b],
          BS: { W: lw, S: 'S' },
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'ellipse': {
      const cx = o.x * m.sx;
      const cy = m.pdfH - o.y * m.sy;
      const rx = Math.abs(o.rx) * m.sx;
      const ry = Math.abs(o.ry) * m.sy;
      const [r, g, b] = col(o.stroke);
      const lw = o.strokeWidth * lineScale;
      const ox = rx * KAPPA;
      const oy = ry * KAPPA;
      const body = [
        `${n(r)} ${n(g)} ${n(b)} RG`,
        `${n(lw)} w`,
        `${n(cx + rx)} ${n(cy)} m`,
        `${n(cx + rx)} ${n(cy + oy)} ${n(cx + ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
        `${n(cx - ox)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + oy)} ${n(cx - rx)} ${n(cy)} c`,
        `${n(cx - rx)} ${n(cy - oy)} ${n(cx - ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
        `${n(cx + ox)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - oy)} ${n(cx + rx)} ${n(cy)} c`,
        'S',
      ].join('\n');
      const rect: [number, number, number, number] = [cx - rx - lw, cy - ry - lw, cx + rx + lw, cy + ry + lw];
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Circle',
          Rect: rect,
          C: [r, g, b],
          BS: { W: lw, S: 'S' },
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'line':
    case 'arrow': {
      const x1 = o.x * m.sx;
      const y1 = m.pdfH - o.y * m.sy;
      const x2 = o.x2 * m.sx;
      const y2 = m.pdfH - o.y2 * m.sy;
      const [r, g, b] = col(o.stroke);
      const lw = o.strokeWidth * lineScale;
      let body = `${n(r)} ${n(g)} ${n(b)} RG\n${n(lw)} w\n1 J\n${n(x1)} ${n(y1)} m\n${n(x2)} ${n(y2)} l\nS`;
      if (o.type === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, lw * 4);
        const hx1 = x2 - head * Math.cos(ang - Math.PI / 6);
        const hy1 = y2 - head * Math.sin(ang - Math.PI / 6);
        const hx2 = x2 - head * Math.cos(ang + Math.PI / 6);
        const hy2 = y2 - head * Math.sin(ang + Math.PI / 6);
        body += `\n${n(x2)} ${n(y2)} m\n${n(hx1)} ${n(hy1)} l\n${n(x2)} ${n(y2)} m\n${n(hx2)} ${n(hy2)} l\nS`;
      }
      const pad = lw + 12;
      const rect: [number, number, number, number] = [
        Math.min(x1, x2) - pad,
        Math.min(y1, y2) - pad,
        Math.max(x1, x2) + pad,
        Math.max(y1, y2) + pad,
      ];
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Line',
          Rect: rect,
          L: [x1, y1, x2, y2],
          LE: o.type === 'arrow' ? ['None', 'OpenArrow'] : ['None', 'None'],
          C: [r, g, b],
          BS: { W: lw, S: 'S' },
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'path': {
      if (o.points.length < 2) return null;
      const [r, g, b] = col(o.stroke);
      const lw = o.strokeWidth * lineScale;
      const pts = o.points.map((p) => ({ x: p.x * m.sx, y: m.pdfH - p.y * m.sy }));
      let body = `${n(r)} ${n(g)} ${n(b)} RG\n${n(lw)} w\n1 J\n1 j\n${n(pts[0].x)} ${n(pts[0].y)} m\n`;
      for (let i = 1; i < pts.length; i++) body += `${n(pts[i].x)} ${n(pts[i].y)} l\n`;
      body += 'S';
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pad = lw + 2;
      const rect: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
      const inkList = context.obj([pts.flatMap((p) => [p.x, p.y])]);
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Ink',
          Rect: rect,
          InkList: inkList,
          C: [r, g, b],
          BS: { W: lw, S: 'S' },
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'highlight': {
      const [llx, lly, urx, ury] = toPdfRect(m, o.x, o.y, o.w, o.h);
      const [r, g, b] = col(o.color);
      // No underlying text selection here, so this is a filled translucent box
      // (a Square with interior colour) rather than a text-markup Highlight.
      const body = `${n(r)} ${n(g)} ${n(b)} rg\n${n(llx)} ${n(lly)} ${n(urx - llx)} ${n(ury - lly)} re\nf`;
      const rect: [number, number, number, number] = [llx, lly, urx, ury];
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: rect,
          IC: [r, g, b],
          C: [r, g, b],
          BS: { W: 0, S: 'S' },
          CA: 0.3,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'whiteout': {
      const [llx, lly, urx, ury] = toPdfRect(m, o.x, o.y, o.w, o.h);
      const body = `1 1 1 rg\n${n(llx)} ${n(lly)} ${n(urx - llx)} ${n(ury - lly)} re\nf`;
      const rect: [number, number, number, number] = [llx, lly, urx, ury];
      const ap = appearance(ctx, rect, body);
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: rect,
          IC: [1, 1, 1],
          C: [1, 1, 1],
          BS: { W: 0, S: 'S' },
          CA: 1,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'stamp': {
      const font = await getHelvBold(ctx);
      const [llx, lly, urx, ury] = toPdfRect(m, o.x, o.y, o.borderW, o.borderH);
      const [r, g, b] = col(o.color);
      const boxH = ury - lly;
      const fsPdf = Math.min(boxH * 0.6, (urx - llx) / Math.max(1, o.text.length) * 1.6);
      const textW = font.widthOfTextAtSize(o.text, fsPdf);
      const tx = llx + (urx - llx - textW) / 2;
      const ty = lly + (boxH - fsPdf) / 2 + fsPdf * 0.18;
      const lw = 2 * lineScale;
      const body = [
        `${n(r)} ${n(g)} ${n(b)} RG`,
        `${n(lw)} w`,
        `${n(llx + lw)} ${n(lly + lw)} ${n(urx - llx - 2 * lw)} ${n(boxH - 2 * lw)} re`,
        'S',
        'BT',
        `/HelvB ${n(fsPdf)} Tf`,
        `${n(r)} ${n(g)} ${n(b)} rg`,
        `${n(tx)} ${n(ty)} Td`,
        `(${esc(o.text)}) Tj`,
        'ET',
      ].join('\n');
      const rect: [number, number, number, number] = [llx, lly, urx, ury];
      const ap = appearance(ctx, rect, body, { Font: { HelvB: font.ref } });
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Stamp',
          Rect: rect,
          Contents: PDFString.of(o.text),
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }

    case 'image': {
      const bytes = dataUrlToBytes(o.dataUrl);
      if (!bytes) return null;
      const isPng = o.dataUrl.startsWith('data:image/png');
      const img = isPng ? await ctx.pdfDoc.embedPng(bytes) : await ctx.pdfDoc.embedJpg(bytes);
      const [llx, lly, urx, ury] = toPdfRect(m, o.x, o.y, o.w, o.h);
      const w = urx - llx;
      const h = ury - lly;
      const body = `q\n${n(w)} 0 0 ${n(h)} ${n(llx)} ${n(lly)} cm\n/Img Do\nQ`;
      const rect: [number, number, number, number] = [llx, lly, urx, ury];
      const ap = appearance(ctx, rect, body, { XObject: { Img: img.ref } });
      return context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Stamp',
          Rect: rect,
          CA: opacity,
          F: 4,
          AP: { N: ap },
        }),
      );
    }
  }
}

/** Decode a data: URL to raw bytes (or null if malformed). */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    const base64 = dataUrl.slice(comma + 1);
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Attach the editor's annotation objects to `pdfDoc` as real PDF annotations,
 * preserving any annotations already present on each page.
 *
 * @param pageObjects  per-page-index list of annotation objects to emit
 * @param pageDims     per-page-index rendered canvas dimensions (px at scale 1)
 */
export async function embedAnnotations(
  pdfDoc: PDFDocument,
  pageObjects: Record<number, AnnotationObject[]>,
  pageDims: Record<number, { width: number; height: number }>,
): Promise<void> {
  const ctx: Ctx = { pdfDoc };
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();

  for (const key of Object.keys(pageObjects)) {
    const i = Number(key);
    const objects = pageObjects[i];
    const page = pages[i];
    const dims = pageDims[i];
    if (!page || !dims || !objects || objects.length === 0) continue;

    const { width: pdfW, height: pdfH } = page.getSize();
    const m: PageMap = { pdfH, sx: pdfW / dims.width, sy: pdfH / dims.height };

    const refs: PDFRef[] = [];
    for (const o of objects) {
      const ref = await buildAnnot(ctx, m, o);
      if (ref) refs.push(ref);
    }
    if (refs.length === 0) continue;

    let annots = page.node.Annots();
    if (!annots) {
      annots = context.obj([]) as PDFArray;
      page.node.set(PDFName.of('Annots'), annots);
    }
    for (const ref of refs) annots.push(ref);
  }
}
