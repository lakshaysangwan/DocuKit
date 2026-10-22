/**
 * Write the page list of Rearrange / Rotate PDF Pages into a new PDF.
 *
 *   • Pages come out in `order`; a source index may repeat (a duplicate), and
 *     `BLANK` (-1) is a new empty page.
 *   • `rotations[i]` is the turn the visitor added to output page i. It is
 *     ADDED to the page's own `/Rotate` and the sum normalised to 0, 90, 180 or
 *     270 — a page that already reads `/Rotate 90` turned right is 180, as the
 *     grid showed it.
 *   • A blank page takes the size and shape of the nearest real page before it
 *     as that page appears in the original (its own `/Rotate` counted, the
 *     visitor's turn not), or of the original's first page when none comes
 *     before it — the rule `blankSizeSource` gives the grid.
 *
 * Runs wherever pdf-lib runs (the PDF worker, and unit tests).
 */
import { PDFDocument, degrees, type PDFPage } from 'pdf-lib';
import { BLANK, normaliseTurn } from './organize-pages';

export interface OrganizeWriteOptions {
  order: number[];
  rotations: number[];
}

/** Letter, for a file with no pages at all (pdf-lib's own default). */
const FALLBACK_SIZE: [number, number] = [612, 792];

/** A page's size as displayed: width and height swapped by a quarter-turn `/Rotate`. */
function displayedSize(page: PDFPage): [number, number] {
  const { width, height } = page.getSize();
  const r = normaliseTurn(page.getRotation().angle);
  return r === 90 || r === 270 ? [height, width] : [width, height];
}

export async function organizePdf(
  src: PDFDocument,
  { order, rotations }: OrganizeWriteOptions,
  onProgress?: (fraction: number) => void,
): Promise<PDFDocument> {
  const out = await PDFDocument.create();

  // Copy each distinct source page once. pdf-lib's copier is per call and
  // caches by object, so asking for one index twice in a call would yield a
  // single shared page — turning either copy would turn both. Repeats get their
  // own copyPages call, which keeps them independent.
  const distinct = [...new Set(order.filter((i) => i !== BLANK))];
  const copied = await out.copyPages(src, distinct);
  const firstCopy = new Map<number, PDFPage>();
  distinct.forEach((srcIdx, i) => firstCopy.set(srcIdx, copied[i]));

  let blankSize: [number, number] = src.getPageCount() > 0 ? displayedSize(src.getPage(0)) : FALLBACK_SIZE;
  const used = new Set<number>();

  for (let pos = 0; pos < order.length; pos++) {
    const srcIdx = order[pos];
    let page: PDFPage;
    if (srcIdx === BLANK) {
      page = out.addPage(blankSize);
    } else {
      if (used.has(srcIdx)) {
        [page] = await out.copyPages(src, [srcIdx]);
      } else {
        page = firstCopy.get(srcIdx)!;
        used.add(srcIdx);
      }
      out.addPage(page);
      blankSize = displayedSize(page);
    }

    const turn = normaliseTurn(rotations[pos] ?? 0);
    if (turn !== 0) page.setRotation(degrees(normaliseTurn(page.getRotation().angle + turn)));
    onProgress?.((pos + 1) / order.length);
  }

  return out;
}
