/// <reference lib="webworker" />
/**
 * True per-region redaction via MuPDF. For each marked rectangle we add a
 * `Redact` annotation and call `applyRedactions`, which removes from the file
 * the text under the mark, the image pixels under it and vector shapes it
 * covers entirely, and burns in a black box — while leaving the rest of the
 * page's text layer intact and selectable.
 *
 * Marks arrive in PDF user space, already mapped from the displayed page by
 * `page-geometry.ts` (which accounts for `/Rotate`, an offset CropBox and
 * UserUnit). MuPDF annotation rectangles are in its own page space, so each
 * rectangle goes through the page's transform here — no assumptions about
 * where the page starts or which way up it is.
 *
 * This is lazy-loaded only on the redact route (the MuPDF WASM is ~10 MB), and
 * runs in its own worker so the heavy WASM never touches the main thread.
 */
import type * as MuPDF from 'mupdf';

interface RedactMark {
  pageIndex: number;
  /** The area in PDF user space: lower-left corner, y up. */
  pdf: { x: number; y: number; width: number; height: number };
}

type Matrix = [number, number, number, number, number, number];

/** User-space rectangle → the upright rectangle covering it in MuPDF page space. */
function toPageSpace(m: Matrix, r: RedactMark['pdf']): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x, r.y + r.height],
    [r.x + r.width, r.y + r.height],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

interface Req {
  buffer: ArrayBuffer;
  marks: RedactMark[];
  /** Also drop XMP metadata and embedded file attachments. */
  stripMetadata?: boolean;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { buffer, marks, stripMetadata } = e.data;
  try {
    // Import inside the handler (not top-level) so the ~10 MB WASM loads lazily,
    // the message handler registers immediately, and any load error is reported
    // back rather than silently hanging the worker's module evaluation.
    const mupdf = (await import('mupdf')) as typeof MuPDF;

    const opened = mupdf.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
    const doc = opened.asPDF();
    if (!doc) throw new Error('Not a PDF document');

    // Group marks by page so we apply redactions once per page.
    const byPage = new Map<number, RedactMark[]>();
    for (const m of marks) {
      const list = byPage.get(m.pageIndex) ?? [];
      list.push(m);
      byPage.set(m.pageIndex, list);
    }

    for (const [pageIndex, pageMarks] of byPage) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.countPages()) {
        throw new Error(`A mark is on page ${pageIndex + 1}, which this PDF does not have`);
      }
      const page = doc.loadPage(pageIndex) as MuPDF.PDFPage;
      // User space → MuPDF page space (rotation, crop box origin and y-flip included).
      const ctm = page.getTransform() as unknown as Matrix;

      for (const m of pageMarks) {
        const annot = page.createAnnotation('Redact');
        annot.setRect(toPageSpace(ctm, m.pdf));
        // Flush the annotation's rect before applying — page.update() alone does
        // not sync it, and applyRedactions would then find an empty rect.
        annot.update();
      }

      // Black boxes; the image pixels under a mark (not the whole image); vector
      // shapes the mark covers entirely; every character under it.
      page.applyRedactions(
        true,
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
    }

    // Strip document metadata — redacted files shouldn't leak author/title/etc.
    for (const key of ['info:Title', 'info:Author', 'info:Subject', 'info:Keywords', 'info:Creator', 'info:Producer']) {
      try { doc.setMetaData(key, ''); } catch { /* key may not exist */ }
    }

    // "Full metadata strip" goes past the Info dictionary: the XMP packet is a
    // separate copy of the same fields, and attachments can carry anything at
    // all. Both survive an Info-only strip, so clear them explicitly.
    if (stripMetadata) {
      try {
        const root = doc.getTrailer().get('Root');
        root.delete('Metadata');
      } catch { /* no XMP stream present */ }

      try {
        for (const name of Object.keys(doc.getEmbeddedFiles())) {
          doc.deleteEmbeddedFile(name);
        }
      } catch { /* no embedded files */ }
    }

    const out = doc.saveToBuffer('compress').asUint8Array();
    // Copy into a fresh ArrayBuffer we can transfer (MuPDF's is WASM-heap backed).
    const copy = new Uint8Array(out.length);
    copy.set(out);
    (self as unknown as Worker).postMessage({ ok: true, result: copy.buffer }, [copy.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
