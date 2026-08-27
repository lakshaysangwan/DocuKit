/// <reference lib="webworker" />
/**
 * True per-region redaction via MuPDF. For each marked rectangle we add a
 * `Redact` annotation and call `applyRedactions`, which physically removes the
 * underlying text/image/vector content beneath the mark and burns in a black
 * box — while leaving the rest of the page's text layer intact and selectable.
 *
 * This is lazy-loaded only on the redact route (the MuPDF WASM is ~10 MB), and
 * runs in its own worker so the heavy WASM never touches the main thread.
 */
import type * as MuPDF from 'mupdf';

interface RedactMark {
  pageIndex: number;
  /** page-relative percent (0–100), top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
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
      const page = doc.loadPage(pageIndex) as MuPDF.PDFPage;
      // MuPDF annotation rects use the page's own space, which for these pages is
      // top-left origin (y down) — the same convention as our percent marks.
      const [bx0, by0, bx1, by1] = page.getBounds();
      const w = bx1 - bx0;
      const h = by1 - by0;

      for (const m of pageMarks) {
        const x0 = bx0 + (m.x / 100) * w;
        const y0 = by0 + (m.y / 100) * h;
        const x1 = bx0 + ((m.x + m.width) / 100) * w;
        const y1 = by0 + ((m.y + m.height) / 100) * h;
        const annot = page.createAnnotation('Redact');
        annot.setRect([x0, y0, x1, y1]);
        // Flush the annotation's rect before applying — page.update() alone does
        // not sync it, and applyRedactions would then find an empty rect.
        annot.update();
      }

      // black_boxes = true; also strip images touched by a mark.
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_REMOVE);
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
