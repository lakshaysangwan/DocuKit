/**
 * PDF.js Worker — thumbnail rendering + text extraction
 * Uses OffscreenCanvas for off-main-thread rendering.
 *
 * Week 3: render-thumbnails (for PageThumbnailGrid)
 * Week 6: extract-text (for PDF search)
 */

import type { WorkerRequest, WorkerResponse, TextWord } from '../types/worker-messages';

let pdfjsLib: typeof import('pdfjs-dist') | null = null;

async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist');
    // Use the bundled legacy worker (avoid fetch issues in nested workers)
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }
  return pdfjsLib;
}

async function renderThumbnails(
  buffer: ArrayBuffer,
  pageIndices: number[],
  size: number,
  sendProgress: (pct: number, label?: string) => void
): Promise<ImageBitmap[]> {
  const lib = await getPdfJs();

  sendProgress(5, 'Loading PDF…');
  const doc = await lib.getDocument({ data: buffer }).promise;

  const bitmaps: ImageBitmap[] = [];
  const total = pageIndices.length;

  for (let i = 0; i < total; i++) {
    sendProgress(5 + Math.round(((i + 1) / total) * 90), `Rendering page ${i + 1}/${total}…`);
    const pageNum = pageIndices[i] + 1; // pdfjs is 1-indexed
    const page = await doc.getPage(pageNum);

    const viewport = page.getViewport({ scale: 1 });
    const scale = size / Math.max(viewport.width, viewport.height);
    const scaledViewport = page.getViewport({ scale });

    const canvas = new OffscreenCanvas(
      Math.ceil(scaledViewport.width),
      Math.ceil(scaledViewport.height)
    );
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaledViewport,
    }).promise;

    const bitmap = await createImageBitmap(canvas);
    bitmaps.push(bitmap);
    page.cleanup();
  }

  doc.destroy();
  return bitmaps;
}

async function extractText(
  buffer: ArrayBuffer,
  sendProgress: (pct: number, label?: string) => void
): Promise<Array<{ pageIndex: number; text: string; words: TextWord[] }>> {
  const lib = await getPdfJs();

  sendProgress(5, 'Loading PDF…');
  const doc = await lib.getDocument({ data: buffer }).promise;
  const total = doc.numPages;
  const pages: Array<{ pageIndex: number; text: string; words: TextWord[] }> = [];

  for (let i = 0; i < total; i++) {
    sendProgress(5 + Math.round(((i + 1) / total) * 90), `Indexing page ${i + 1}/${total}…`);
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    const words: TextWord[] = [];
    let fullText = '';

    for (const item of content.items) {
      if (!('str' in item)) continue;
      const textItem = item as { str: string; transform: number[]; width: number; height: number };
      if (!textItem.str.trim()) continue;

      // pdfjs uses bottom-left origin; normalize to top-left
      const [, , , , tx, ty] = textItem.transform;
      words.push({
        text: textItem.str,
        bbox: {
          x: tx,
          y: viewport.height - ty - (textItem.height || 12),
          width: textItem.width || 50,
          height: textItem.height || 12,
        },
      });
      fullText += textItem.str + ' ';
    }

    pages.push({ pageIndex: i, text: fullText.trim(), words });
    page.cleanup();
  }

  doc.destroy();
  return pages;
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const progressPort = (msg as WorkerRequest & { progressPort: MessagePort }).progressPort;

  function sendProgress(percent: number, label?: string) {
    progressPort?.postMessage({ percent, label });
  }

  try {
    sendProgress(0, 'Starting…');
    let response: WorkerResponse;

    switch (msg.op) {
      case 'render-thumbnails': {
        const bitmaps = await renderThumbnails(msg.buffer, msg.pageIndices, msg.size, sendProgress);
        response = { status: 'success-thumbnails', thumbnails: bitmaps };
        (self as unknown as Worker).postMessage(response, bitmaps as unknown as Transferable[]);
        progressPort?.close();
        return;
      }

      case 'extract-text': {
        const pages = await extractText(msg.buffer, sendProgress);
        response = { status: 'success-text', pages };
        break;
      }

      default:
        response = {
          status: 'error',
          message: `Operation "${(msg as { op: string }).op}" not implemented in pdfjs-worker`,
        };
    }

    sendProgress(100, 'Done');
    self.postMessage(response);
  } catch (err) {
    self.postMessage({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    } as WorkerResponse);
  } finally {
    progressPort?.close();
  }
};
