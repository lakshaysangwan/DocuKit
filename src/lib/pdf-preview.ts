import { getPdfjs } from '@/lib/pdfjs';

/**
 * Render a single PDF page to a JPEG data URL for preview/comparison surfaces.
 * Kept small (default longest edge 900px) so it's cheap to composite in the UI.
 */
export async function renderPdfPageToDataUrl(
  buffer: ArrayBuffer,
  pageIndex = 0,
  maxSize = 900,
): Promise<string> {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxSize / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    doc.destroy();
  }
}
