/**
 * The live quality preview's first step: cut one page out of the PDF as a PDF
 * of its own, and take an inventory of every page's images.
 *
 * Compression replaces image objects one at a time, each with a result that
 * depends only on its own bytes and the settings. So a one-page PDF holding a
 * page and the images it draws, run through the very same `compressPdf`, looks
 * exactly as that page will in the full output — at one page's cost.
 *
 * Pure pdf-lib, no canvas: runs in the PDF worker on every engine. Eligibility
 * is `planImagePass`, the rule the compression pass itself follows.
 */
import { planImagePass } from './pdf-compress';
import { pageImageRefs } from './pdf-page-images';
import type { ProbePageInfo } from '../types/worker-messages';

export interface ProbeResult {
  pagePdf: ArrayBuffer;
  pageIndex: number;
  pageCount: number;
  pages: ProbePageInfo[];
}

/**
 * The page a preview opens on when the visitor has not chosen one. The first
 * page, when compression may change anything on it — the visitor starts where
 * the document starts. Otherwise (a text-only cover, say) the page with the
 * most bytes of images compression may change, where its effect is largest;
 * with no such page, the one with the most images; with none, the first. Ties
 * go to the earlier page.
 */
export function choosePreviewPage(pages: ProbePageInfo[]): number {
  if ((pages[0]?.eligible ?? 0) > 0) return 0;
  let best: ProbePageInfo | undefined;
  for (const page of pages) {
    if (!best || page.eligibleBytes > best.eligibleBytes) best = page;
  }
  if (best && best.eligibleBytes > 0) return best.pageIndex;
  let most: ProbePageInfo | undefined;
  for (const page of pages) {
    if (!most || page.images > most.images) most = page;
  }
  return most && most.images > 0 ? most.pageIndex : 0;
}

/** Inventory every page and cut out `pageIndex` (or the page `choosePreviewPage` picks). */
export async function probePdf(buffer: ArrayBuffer, pageIndex?: number): Promise<ProbeResult> {
  const lib = await import('pdf-lib');
  const { PDFDocument, PDFRawStream } = lib;
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });

  const plans = new Map(planImagePass(lib, doc.context).map((p) => [p.ref, p] as const));
  const pages: ProbePageInfo[] = pageImageRefs(lib, doc).map((refs, i) => {
    const info: ProbePageInfo = { pageIndex: i, images: refs.length, eligible: 0, eligibleBytes: 0, eligiblePixels: 0 };
    for (const ref of refs) {
      const planned = plans.get(ref);
      if (!planned || !planned.plan.reencode || !(planned.stream instanceof PDFRawStream)) continue;
      info.eligible++;
      info.eligibleBytes += planned.stream.contents.byteLength;
      info.eligiblePixels += planned.plan.width * planned.plan.height;
    }
    return info;
  });

  const pageCount = doc.getPageCount();
  const chosen = pageIndex !== undefined && pageIndex >= 0 && pageIndex < pageCount ? pageIndex : choosePreviewPage(pages);

  const out = await PDFDocument.create({ updateMetadata: false });
  const [copy] = await out.copyPages(doc, [chosen]);
  out.addPage(copy);
  const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
  const pagePdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { pagePdf, pageIndex: chosen, pageCount, pages };
}
