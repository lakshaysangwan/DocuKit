/**
 * Flatten-crop: permanently remove everything outside the crop rectangle.
 *
 * Setting a /CropBox only *hides* the surrounding content — every byte of it
 * stays in the file and one editor command brings it back. Flatten mode instead
 * rasterises each cropped page at the crop rectangle and replaces the page with
 * that image, so the trimmed-away content is genuinely gone from the output.
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

export interface FlattenCropMargins {
  /** All in PDF points, measured inward from each edge. */
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** ~216 DPI, matching the redact rasteriser's quality target. */
const RENDER_SCALE = 3;

export async function flattenCrop(
  buffer: ArrayBuffer,
  margins: FlattenCropMargins,
  targetPages: number[],
  onProgress?: (pct: number) => void
): Promise<ArrayBuffer> {
  const pdfjsLib = await getPdfjs();
  const { PDFDocument } = await import('pdf-lib');

  // pdf.js takes ownership of the bytes it is handed and detaches the buffer, so
  // pdf-lib's copy has to be taken *before* getDocument, not after.
  const srcBytes = new Uint8Array(buffer);
  const srcDoc = await PDFDocument.load(srcBytes.slice(), { ignoreEncryption: true });
  const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: srcBytes }).promise;
  const outDoc = await PDFDocument.create();

  const targets = new Set(targetPages);
  const total = pdfDoc.numPages;

  for (let i = 0; i < total; i++) {
    onProgress?.(Math.round((i / total) * 90));

    if (!targets.has(i)) {
      // Untouched pages are copied as-is so they keep selectable text.
      const [copied] = await outDoc.copyPages(srcDoc, [i]);
      outDoc.addPage(copied);
      continue;
    }

    const page = await pdfDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: RENDER_SCALE });
    const unscaled = page.getViewport({ scale: 1 });

    // Crop rect in output points, clamped so a too-large margin can't invert it.
    const cropWidth = Math.max(1, unscaled.width - margins.left - margins.right);
    const cropHeight = Math.max(1, unscaled.height - margins.top - margins.bottom);

    // Render the whole page, then copy just the crop window out of it. Going via
    // a full-page render keeps pdf.js's own transform handling (rotation, user
    // units) authoritative instead of reimplementing it in the viewport maths.
    const { canvas: full, ctx: fullCtx } = createCanvas2D(vp.width, vp.height);
    await page.render({
      canvasContext: fullCtx as unknown as CanvasRenderingContext2D,
      viewport: vp,
      canvas: full as unknown as HTMLCanvasElement,
    }).promise;

    const sx = margins.left * RENDER_SCALE;
    // Canvas y runs from the top; PDF margins name `top` from the top edge too.
    const sy = margins.top * RENDER_SCALE;
    const sw = cropWidth * RENDER_SCALE;
    const sh = cropHeight * RENDER_SCALE;

    const { canvas: cropped, ctx: cropCtx } = createCanvas2D(sw, sh);
    cropCtx.drawImage(full as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh);

    const blob = await canvasToBlob(cropped, 'image/jpeg', 0.92);
    const img = await outDoc.embedJpg(new Uint8Array(await blob.arrayBuffer()));

    const outPage = outDoc.addPage([cropWidth, cropHeight]);
    outPage.drawImage(img, { x: 0, y: 0, width: cropWidth, height: cropHeight });
  }

  pdfDoc.destroy();
  onProgress?.(95);

  const bytes = await outDoc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}
