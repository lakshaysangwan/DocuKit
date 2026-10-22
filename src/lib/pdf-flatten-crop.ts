/**
 * Flatten-crop: permanently remove everything outside the crop rectangle.
 *
 * Setting a /CropBox only *hides* the surrounding content — every byte of it
 * stays in the file and one editor command brings it back. Flatten mode instead
 * replaces each cropped page with a picture of just the area that was kept, so
 * the trimmed-away content is genuinely gone from the output.
 *
 * The area is found exactly as CropBox mode finds it: the crop boxes are first
 * written with `writeCropBoxes` (and so `viewMarginsToCropBox`) into a scratch
 * copy, and pdf.js then renders those pages — which draws precisely the crop
 * box, turned by the page's `/Rotate`. So a rotated scan or a page with an
 * offset crop box is cut at the visual edges the visitor chose, and the
 * flattened page is upright, the size the crop leaves.
 *
 * The cost is the page's text layer: a flattened page is a picture, so its text
 * is no longer selectable or searchable. Pages outside the crop selection are
 * copied through untouched and keep their vector content.
 *
 * Rasterising runs on the main thread because PDF page rendering needs pdf.js
 * plus a 2D surface, and Playwright's WebKit has no OffscreenCanvas in workers —
 * the same reason `rasterizeRedact` lives on the main thread.
 */
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';
import { createCanvas2D, canvasToBlob } from '@/lib/canvas-2d';
import { writeCropBoxes, type CropPageTarget } from '@/lib/crop-write';
import type { CropMargins } from '@/lib/crop-layout';

/** ~216 DPI, matching the redact rasteriser's quality target… */
const RENDER_SCALE = 3;
/** …unless that would make a raster larger than this (large-format pages). */
const MAX_PIXELS = 24_000_000;
const MAX_EDGE_PX = 8192;

export async function flattenCrop(
  buffer: ArrayBuffer,
  pages: CropPageTarget[],
  margins: CropMargins,
  onProgress?: (pct: number) => void,
): Promise<ArrayBuffer> {
  const pdfjsLib = await getPdfjs();
  const { PDFDocument } = await import('pdf-lib');

  const srcBytes = new Uint8Array(buffer);
  const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });

  // A scratch copy with the crop boxes set: what CropBox mode would write.
  const scratch = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  writeCropBoxes(scratch, pages, margins);
  const croppedBytes = await scratch.save({ useObjectStreams: false });

  // pdf.js takes ownership of the bytes it is handed, so it gets its own copy.
  const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: croppedBytes }).promise;
  const outDoc = await PDFDocument.create();

  const targets = new Set(pages.map((p) => p.pageIndex));
  const total = srcDoc.getPageCount();

  try {
    for (let i = 0; i < total; i++) {
      onProgress?.(Math.round((i / total) * 90));

      if (!targets.has(i)) {
        // Untouched pages are copied as-is so they keep selectable text.
        const [copied] = await outDoc.copyPages(srcDoc, [i]);
        outDoc.addPage(copied);
        continue;
      }

      const page = await pdfDoc.getPage(i + 1);
      // At scale 1 the viewport is the crop area as displayed, in points.
      const size = page.getViewport({ scale: 1 });
      let scale = RENDER_SCALE;
      const area = size.width * size.height * scale * scale;
      if (area > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / area);
      if (Math.max(size.width, size.height) * scale > MAX_EDGE_PX) scale = MAX_EDGE_PX / Math.max(size.width, size.height);
      const vp = page.getViewport({ scale });

      const { canvas, ctx } = createCanvas2D(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
      // JPEG has no alpha: start from white paper, as a viewer shows it.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: vp,
        canvas: canvas as unknown as HTMLCanvasElement,
      }).promise;
      page.cleanup();

      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      const img = await outDoc.embedJpg(new Uint8Array(await blob.arrayBuffer()));

      const outPage = outDoc.addPage([size.width, size.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
    }
  } finally {
    await pdfDoc.destroy();
  }
  onProgress?.(95);

  const bytes = await outDoc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}
