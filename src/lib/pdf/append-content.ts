/**
 * Adding drawing to an existing page, in the page's own default coordinates.
 *
 * Shared by the tools that stamp something onto every page — Watermark PDF and
 * Add Page Numbers — so both place things the same way:
 *
 *   • each thing is drawn in its own frame: a box in displayed points with the
 *     origin at the box's bottom-left, put on the page by one `cm` from
 *     `placementMatrix`, which goes through `page-geometry.ts` — so `/Rotate`,
 *     a crop box that does not start at 0,0 and UserUnit are handled;
 *   • drawing put in front is appended after the page's own content, once every
 *     graphics state that content leaves open has been closed (see
 *     content-balance.ts) — otherwise a page that leaves a `cm` behind would
 *     have it drawn shrunk and shifted;
 *   • drawing put behind is a self-contained stream before the page's content.
 *
 * Runs wherever pdf-lib runs (the PDF worker, and unit tests).
 */
import { PDFArray, PDFName, type PDFDocument, type PDFPage } from 'pdf-lib';
import { viewRectToPdfDraw, type PageGeometry, type RectNorm } from './page-geometry';
import { unclosedStates } from '../edit-pdf/write';

/** `#rgb` or `#rrggbb` → 0–1 components. Anything unreadable is black. */
export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = Number.parseInt(h || '000000', 16);
  if (!Number.isFinite(v)) return [0, 0, 0];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * The `cm` that maps a frame (displayed points, the box's bottom-left at 0,0)
 * into user space: `rect` is the box on the displayed page, turned `rotation`
 * degrees clockwise about its centre.
 */
export function placementMatrix(geom: PageGeometry, rect: RectNorm, rotation: number): number[] {
  const draw = viewRectToPdfDraw(geom, rect, rotation);
  const angle = (draw.rotateDeg * Math.PI) / 180;
  const s = 1 / geom.userUnit;
  return [Math.cos(angle) * s, Math.sin(angle) * s, -Math.sin(angle) * s, Math.cos(angle) * s, draw.x, draw.y];
}

/**
 * Add `drawing` (content-stream operators, self-contained: every `q` closed)
 * to `page`, in front of its content or behind it.
 */
export function appendToPage(doc: PDFDocument, page: PDFPage, drawing: string, layer: 'front' | 'behind' = 'front'): void {
  const context = doc.context;
  const raw = page.node.get(PDFName.of('Contents'));
  const existing = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
  if (layer === 'behind') {
    // Painted first, so everything on the page paints over it.
    const stream = context.register(context.flateStream(`${drawing}\n`));
    page.node.set(PDFName.of('Contents'), context.obj([stream, ...existing]));
  } else {
    // Close whatever the page's own content leaves open, so the drawing is in
    // the page's default coordinates.
    const open = unclosedStates(doc, page);
    const start = context.register(context.flateStream('q\n'));
    const end = context.register(context.flateStream(`${'Q\n'.repeat(open + 1)}${drawing}\n`));
    page.node.set(PDFName.of('Contents'), context.obj([start, ...existing, end]));
  }
}
