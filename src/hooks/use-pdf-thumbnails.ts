import { useState, useCallback } from 'react';

export interface ThumbnailResult {
  pageIndex: number;
  dataUrl: string;
}

interface UsePdfThumbnailsResult {
  thumbnails: ThumbnailResult[];
  pageCount: number;
  isLoading: boolean;
  error: string | null;
  loadThumbnails: (buffer: ArrayBuffer, size?: number) => Promise<number>;
  clear: () => void;
}

/**
 * Renders PDF page thumbnails using PDF.js directly on the main thread
 * (for small-to-medium PDFs). For large batches, use pdfjs-worker.ts.
 */
export function usePdfThumbnails(): UsePdfThumbnailsResult {
  const [thumbnails, setThumbnails] = useState<ThumbnailResult[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThumbnails = useCallback(async (buffer: ArrayBuffer, size = 800): Promise<number> => {
    setIsLoading(true);
    setError(null);
    setThumbnails([]);

    try {
      // Dynamically import pdfjs-dist to avoid affecting initial bundle
      const pdfjsLib = await import('pdfjs-dist');
      // Set worker source — pdfjs-dist ships its own worker
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

      const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;

      // Detect encrypted PDFs and reject with a clear message
      // pdfjs will set doc._transport._fullReader._isRangeSupported but the simplest
      // check is to try getting a page — if the PDF is encrypted, getDocument may
      // still succeed but individual page operations will fail. However, pdfjs also
      // exposes metadata we can check:
      try {
        await doc.getPermissions();
        // If we got here, the PDF is either unencrypted or has an empty password (owner-only restriction).
        // Empty-password PDFs are readable, so we allow them.
      } catch {
        // getPermissions() throws on encrypted PDFs that need a password
        throw new Error('This PDF is encrypted. Please use the Unlock PDF tool first to remove the password, then try again.');
      }

      setPageCount(doc.numPages);

      const results: ThumbnailResult[] = [];

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const scale = size / Math.max(viewport.width, viewport.height);
        const scaledViewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d')!;

        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas, viewport: scaledViewport }).promise;
        results.push({ pageIndex: i - 1, dataUrl: canvas.toDataURL('image/jpeg', 0.8) });

        // Update progressively
        setThumbnails([...results]);
      }

      return doc.numPages;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PDF');
      return 0;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setThumbnails([]);
    setPageCount(0);
    setError(null);
  }, []);

  return { thumbnails, pageCount, isLoading, error, loadThumbnails, clear };
}
