/**
 * Write Crop PDF's crop boxes: each target page gets the `/CropBox` that shows
 * exactly the visual area the margins leave, through `cropBoxFor` (and so
 * `viewMarginsToCropBox`). The geometry is the one pdf.js reported for the page
 * on screen, so a `/Rotate 90` scan loses its visual top, not its stored left,
 * and a page whose crop box already starts away from 0,0 is cut inside that box.
 *
 * Runs wherever pdf-lib runs (the PDF worker, the Flatten path, unit tests).
 */
import type { PDFDocument } from 'pdf-lib';
import type { PageGeometry } from './pdf/page-geometry';
import { cropBoxFor, type CropMargins } from './crop-layout';

export interface CropPageTarget {
  pageIndex: number;
  /** The page as pdf.js displays it — the geometry the crop box was drawn on. */
  geometry: PageGeometry;
}

export function writeCropBoxes(
  doc: PDFDocument,
  pages: CropPageTarget[],
  margins: CropMargins,
  onPage?: (done: number, total: number) => void,
): void {
  const all = doc.getPages();
  pages.forEach(({ pageIndex, geometry }, i) => {
    const page = all[pageIndex];
    if (!page) return;
    const [x, y, width, height] = cropBoxFor(geometry, margins);
    page.setCropBox(x, y, width, height);
    onPage?.(i + 1, pages.length);
  });
}
