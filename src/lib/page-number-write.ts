/**
 * Write page numbers into a PDF, at exactly the places the preview drew them.
 *
 * Each page's text and box come from `layoutPageNumber` — the function the
 * preview uses — and the box is put on the page by `placementMatrix`, so the
 * number lands where it was shown, reading upright, on a `/Rotate`d page, a
 * page whose crop box does not start at 0,0 and a UserUnit page alike.
 *
 * Each number is drawn in its own frame: its box in displayed points with the
 * origin at the box's bottom-left, placed by one `cm`, the text set with a
 * regular standard font (nothing embedded) on a baseline `baselinePt` above the
 * bottom of the box. It is appended after the page's own content once every
 * graphics state that content leaves open is closed (`appendToPage`).
 *
 * Runs wherever pdf-lib runs (the PDF worker, and unit tests).
 */
import { StandardFonts, type PDFDocument } from 'pdf-lib';
import type { PageGeometry } from './pdf/page-geometry';
import { appendToPage, hexToRgb01, placementMatrix } from './pdf/append-content';
import { encode, n } from './edit-pdf/write';
import { layoutPageNumber, type PageNumberFont, type PageNumberLayoutOptions } from './page-number-layout';

export interface PageNumberWriteOptions extends PageNumberLayoutOptions {
  /** `#rrggbb`. */
  color: string;
}

export interface PageNumberPageTarget {
  pageIndex: number;
  /** The page as pdf.js displays it — the geometry the preview was drawn on. */
  geometry: PageGeometry;
}

const STANDARD: Record<PageNumberFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Times-Roman': StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};

/**
 * Number the `targets` of `doc` (in place), counting from all of its pages.
 * Pages the options skip are left untouched. `onPage` is called after each
 * target, for progress.
 */
export async function writePageNumbers(
  doc: PDFDocument,
  targets: readonly PageNumberPageTarget[],
  options: PageNumberWriteOptions,
  onPage?: (done: number, total: number) => void,
): Promise<void> {
  const pages = doc.getPages();
  const font = await doc.embedFont(STANDARD[options.font] ?? StandardFonts.Helvetica);
  const colour = hexToRgb01(options.color || '#000000').map(n).join(' ');

  for (let t = 0; t < targets.length; t++) {
    const { pageIndex, geometry } = targets[t];
    const page = pages[pageIndex];
    const placement = page ? layoutPageNumber(geometry, pageIndex, pages.length, options) : null;
    if (page && placement) {
      page.node.normalize();
      const fontName = page.node.newFontDictionary('PnF', font.ref).asString().slice(1);
      const matrix = placementMatrix(geometry, placement.rect, 0).map(n).join(' ');
      const drawing = [
        'q',
        `${colour} rg`,
        `q ${matrix} cm BT /${fontName} ${n(options.fontSize)} Tf 1 0 0 1 0 ${n(placement.baselinePt)} Tm ${encode(font, placement.text)} Tj ET Q`,
        'Q',
      ].join('\n');
      appendToPage(doc, page, drawing, 'front');
    }
    onPage?.(t + 1, targets.length);
  }
}
