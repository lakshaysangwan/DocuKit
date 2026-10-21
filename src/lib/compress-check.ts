/**
 * The after-compression check: does a page of the real output look grossly
 * different from the same page of the original? Both are drawn small by pdf.js
 * and compared with `render-compare` (brightness grids, named thresholds).
 */
import { compareRenders, type GridComparison } from './render-compare';
import type { PdfDocHandle } from './pdf/doc-handle';
import { PRIORITY_BACKGROUND } from './pdf/render-scheduler';

/** Width the check renders a page at, in pixels. Small: it only looks at cell averages. */
export const CHECK_RENDER_WIDTH = 192;

/** Pages checked in the background after a run, besides the one being looked at. */
export const SAMPLED_PAGES = 6;

/**
 * Which pages to check, in order: the one on screen, then the first, the last
 * and the middle, then those whose images were changed most — the pages where
 * damage is likeliest — up to `SAMPLED_PAGES` besides the shown one.
 */
export function pagesToCheck(shown: number, pageCount: number, byImageChange: number[] = []): number[] {
  const out: number[] = [];
  const add = (i: number) => {
    if (i >= 0 && i < pageCount && !out.includes(i)) out.push(i);
  };
  add(shown);
  const limit = Math.min(pageCount, SAMPLED_PAGES + 1);
  for (const i of [0, pageCount - 1, Math.floor((pageCount - 1) / 2), ...byImageChange]) {
    if (out.length >= limit) break;
    add(i);
  }
  return out;
}

/** Pages ordered by how many image bytes the run removed from them, most first. */
export function pagesByImageChange(
  images: { pages: number[]; bytesBefore: number; bytesAfter: number; action: string }[] | undefined,
): number[] {
  if (!images) return [];
  const removed = new Map<number, number>();
  for (const image of images) {
    if (image.action !== 'recompressed') continue;
    for (const p of image.pages) removed.set(p, (removed.get(p) ?? 0) + image.bytesBefore - image.bytesAfter);
  }
  return [...removed.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** Render page `pageIndex` of both documents small and compare them. */
export async function comparePage(
  original: PdfDocHandle,
  output: PdfDocHandle,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<GridComparison> {
  const render = async (doc: PdfDocHandle) => {
    const page = await doc.renderPage(pageIndex, {
      cssWidth: CHECK_RENDER_WIDTH,
      dpr: 1,
      pixels: true,
      priority: PRIORITY_BACKGROUND,
      signal,
    });
    doc.releasePage(page.url);
    if (!page.imageData) throw new Error('The page could not be read back.');
    return page.imageData;
  };
  const before = await render(original);
  const after = await render(output);
  return compareRenders(before, after);
}
