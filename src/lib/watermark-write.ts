/**
 * Write a watermark into a PDF, at exactly the places the preview drew it.
 *
 * The places come from `layoutWatermark` — the same function the preview uses
 * — and each one is mapped into the page's user space by `viewRectToPdfDraw`,
 * so the watermark lands where it was shown on a `/Rotate`d page, on a page
 * whose crop box does not start at 0,0 and on a UserUnit page alike.
 *
 * Each copy is drawn in its own frame: its box in displayed points with the
 * origin at the box's bottom-left, placed by one `cm`. Text is set with a
 * standard font (nothing embedded) on a baseline `baselinePt` above the bottom
 * of the box; an image fills its box.
 *
 * Layers:
 *   front   appended after the page's own content. Whatever graphics states
 *           that content leaves open are closed first (see content-balance.ts),
 *           or a page that leaves a `cm` behind would have the watermark drawn
 *           shrunk and shifted.
 *   behind  a self-contained stream put before the page's own content, so the
 *           page paints over it.
 *
 * Runs wherever pdf-lib runs (the PDF worker, and unit tests).
 */
import { StandardFonts, type PDFDocument, type PDFFont, type PDFImage } from 'pdf-lib';
import type { PageGeometry } from './pdf/page-geometry';
import { appendToPage, hexToRgb01, placementMatrix } from './pdf/append-content';
import { encode, n } from './edit-pdf/write';
import { layoutWatermark, type WatermarkLayoutOptions } from './watermark-layout';
import type { WatermarkFont } from './watermark-fonts';

export interface WatermarkWriteOptions extends WatermarkLayoutOptions {
  /** `#rrggbb`, for text. */
  color?: string;
  /** 0–1. */
  opacity: number;
  layer: 'front' | 'behind';
  /** Image watermark: PNG or JPEG bytes, exactly as previewed. */
  imageBytes?: Uint8Array;
  imageMime?: 'image/png' | 'image/jpeg';
}

export interface WatermarkPageTarget {
  pageIndex: number;
  /** The page as pdf.js displays it — the geometry the preview was drawn on. */
  geometry: PageGeometry;
}

const STANDARD: Record<WatermarkFont, StandardFonts> = {
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Courier-Bold': StandardFonts.CourierBold,
};

/** The `cm` that maps a copy's frame (displayed points, box bottom-left at 0,0) into user space. */
export { placementMatrix };

/**
 * Add the watermark to `targets` of `doc` (in place). `onPage` is called after
 * each page, for progress.
 */
export async function writeWatermark(
  doc: PDFDocument,
  targets: readonly WatermarkPageTarget[],
  options: WatermarkWriteOptions,
  onPage?: (done: number, total: number) => void,
): Promise<void> {
  const context = doc.context;
  const pages = doc.getPages();

  let font: PDFFont | null = null;
  let image: PDFImage | null = null;
  if (options.type === 'text') {
    if (!options.text) return;
    font = await doc.embedFont(STANDARD[options.font ?? 'Helvetica-Bold']);
  } else {
    if (!options.imageBytes) return;
    // Stored once, however many pages and copies draw it.
    image = options.imageMime === 'image/png' ? await doc.embedPng(options.imageBytes) : await doc.embedJpg(options.imageBytes);
  }
  const opacity = Math.min(1, Math.max(0, options.opacity));
  const alphaState = opacity < 1 ? context.register(context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity })) : null;
  const colour = hexToRgb01(options.color ?? '#000000').map(n).join(' ');
  const encoded = font && options.text ? encode(font, options.text) : '';

  for (let t = 0; t < targets.length; t++) {
    const { pageIndex, geometry } = targets[t];
    const page = pages[pageIndex];
    if (!page) continue;
    const layout = layoutWatermark(geometry, options);
    if (layout.placements.length === 0) continue;

    page.node.normalize();
    const ops: string[] = ['q'];
    if (alphaState) ops.push(`/${page.node.newExtGState('WmGS', alphaState).asString().slice(1)} gs`);
    let body: string;
    if (font) {
      const fontName = page.node.newFontDictionary('WmF', font.ref).asString().slice(1);
      ops.push(`${colour} rg`);
      body = `BT /${fontName} ${n(options.fontSize ?? 0)} Tf 1 0 0 1 0 ${n(layout.baselinePt)} Tm ${encoded} Tj ET`;
    } else {
      const imageName = page.node.newXObject('WmImg', image!.ref).asString().slice(1);
      body = `${n(layout.boxWidthPt)} 0 0 ${n(layout.boxHeightPt)} 0 0 cm /${imageName} Do`;
    }
    for (const p of layout.placements) {
      ops.push(`q ${placementMatrix(geometry, p.rect, p.rotation).map(n).join(' ')} cm ${body} Q`);
    }
    ops.push('Q');
    const drawing = ops.join('\n');

    appendToPage(doc, page, drawing, options.layer);
    onPage?.(t + 1, targets.length);
  }
}
