/**
 * Which image XObjects each page draws.
 *
 * Pure pdf-lib, no canvas: it runs in the PDF worker on every engine. Compress
 * PDF uses it twice — to say per page what the image pass did ("3 of 4 images
 * on this page re-encoded"), and to choose and cut out the page the quality
 * preview shows — so both read the same answer.
 *
 * An image counts for a page when the page's resources name it, directly or
 * inside a form XObject the page names (forms nest; each is walked once).
 * Images only reachable from annotations, patterns or soft-mask groups are not
 * counted for any page; inline images are not XObjects and are never changed.
 */
import type { PDFContext, PDFDict, PDFDocument, PDFRef } from 'pdf-lib';

type PdfLib = typeof import('pdf-lib');

/** For each page, in order, the references of the image XObjects it draws. */
export function pageImageRefs(lib: PdfLib, doc: PDFDocument): PDFRef[][] {
  return doc.getPages().map((page) => {
    const found = new Set<PDFRef>();
    collect(lib, doc.context, page.node.Resources(), found, new Set());
    return [...found];
  });
}

/** The inverse: for each image reference, the zero-based pages that draw it. */
export function imagePages(perPage: PDFRef[][]): Map<PDFRef, number[]> {
  const out = new Map<PDFRef, number[]>();
  perPage.forEach((refs, pageIndex) => {
    for (const ref of refs) {
      const pages = out.get(ref);
      if (pages) pages.push(pageIndex);
      else out.set(ref, [pageIndex]);
    }
  });
  return out;
}

function collect(
  lib: PdfLib,
  context: PDFContext,
  resources: PDFDict | undefined,
  found: Set<PDFRef>,
  seenForms: Set<PDFRef>,
): void {
  const { PDFName, PDFDict, PDFRef, PDFRawStream } = lib;
  if (!resources) return;
  const xobjects = resources.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return;
  for (const [, value] of xobjects.entries()) {
    // Only indirect objects can be re-encoded (the pass enumerates them), so a
    // direct stream here would be nothing to report on.
    if (!(value instanceof PDFRef)) continue;
    const stream = context.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.lookup(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Image')) {
      found.add(value);
    } else if (subtype === PDFName.of('Form') && !seenForms.has(value)) {
      seenForms.add(value);
      const inner = stream.dict.lookup(PDFName.of('Resources'));
      collect(lib, context, inner instanceof PDFDict ? inner : undefined, found, seenForms);
    }
  }
}
