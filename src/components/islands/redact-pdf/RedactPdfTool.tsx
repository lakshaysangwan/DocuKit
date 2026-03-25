import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes, generateId } from '@/lib/utils';

type Status = 'idle' | 'processing' | 'done' | 'error';

/** A region marked for redaction, in page-relative percent (0-100) coords */
interface RedactMark {
  id: string;
  pageIndex: number;
  x: number; y: number; width: number; height: number; // percent
}

export default function RedactPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [marks, setMarks] = useState<RedactMark[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const { thumbnails, loadThumbnails } = usePdfThumbnails();

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setMarks([]); setStatus('idle'); setResult(null); setConfirmed(false);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      await loadThumbnails(buf); // Default is 800 now for high-clarity
    } catch { 
      setFile(null); setStatus('idle'); setMarks([]); setBuffer(null);
      toast.error('Failed to read PDF. If it is encrypted, please unlock it first.'); 
    }
  }, [loadThumbnails]);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setMarks([]); setStatus('idle'); setResult(null); setErrorMsg(null); setConfirmed(false);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, pageIdx: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setDrawStart({ x, y });
    setIsDrawing(true);
    setActivePage(pageIdx);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>, pageIdx: number) => {
    if (!isDrawing || !drawStart || pageIdx !== activePage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setDrawCurrent({ x, y });
  }, [isDrawing, drawStart, activePage]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>, pageIdx: number) => {
    if (!drawStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x2 = ((e.clientX - rect.left) / rect.width) * 100;
    const y2 = ((e.clientY - rect.top) / rect.height) * 100;

    const x = Math.min(drawStart.x, x2);
    const y = Math.min(drawStart.y, y2);
    const w = Math.abs(x2 - drawStart.x);
    const h = Math.abs(y2 - drawStart.y);

    if (w > 1 && h > 1) { // ignore tiny clicks
      setMarks((prev) => [...prev, { id: generateId(), pageIndex: pageIdx, x, y, width: w, height: h }]);
    }
    setDrawStart(null);
    setDrawCurrent(null);
    setIsDrawing(false);
  }, [drawStart]);

  const handleRedact = useCallback(async () => {
    if (!buffer || !file || marks.length === 0) { toast.error('Draw redaction areas first'); return; }
    if (!confirmed) { toast.error('Confirm the irreversible redaction warning first'); return; }

    setStatus('processing');
    setErrorMsg(null);
    setProgress(0);
    // Yield to the event loop so the processing overlay renders before we start heavy work
    await new Promise(r => setTimeout(r, 50));

    // Rasterize-and-replace: render redacted pages to canvas then embed as images.
    // This destroys the text layer completely — text is no longer selectable/copyable.
    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      const { PDFDocument } = await import('pdf-lib');

      const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
      const outDoc = await PDFDocument.create();

      // Group marks by page
      const marksByPage = new Map<number, typeof marks>();
      for (const m of marks) {
        const list = marksByPage.get(m.pageIndex) ?? [];
        list.push(m);
        marksByPage.set(m.pageIndex, list);
      }

      const RENDER_SCALE = 3; // ~216 DPI for quality
      const totalPgs = pdfDoc.numPages;

      for (let i = 0; i < totalPgs; i++) {
        setProgress(Math.round((i / totalPgs) * 90)); // reserved last 10% for final saving

        const page = await pdfDoc.getPage(i + 1);
        const vp = page.getViewport({ scale: RENDER_SCALE });

        const canvas = new OffscreenCanvas(vp.width, vp.height);
        const ctx = canvas.getContext('2d')!;

        await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any } as any).promise;

        // Draw black rectangles over redacted areas on this page
        const pageMarks = marksByPage.get(i);
        if (pageMarks) {
          ctx.fillStyle = '#000000';
          for (const m of pageMarks) {
            const rx = (m.x / 100) * vp.width;
            const ry = (m.y / 100) * vp.height;
            const rw = (m.width / 100) * vp.width;
            const rh = (m.height / 100) * vp.height;
            ctx.fillRect(rx, ry, rw, rh);
          }
        }

        // Export as JPEG and embed into new PDF
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        const imgBytes = new Uint8Array(await blob.arrayBuffer());
        const img = await outDoc.embedJpg(imgBytes);

        // Match original page dimensions
        const origVp = page.getViewport({ scale: 1 });
        const outPage = outDoc.addPage([origVp.width, origVp.height]);
        outPage.drawImage(img, { x: 0, y: 0, width: origVp.width, height: origVp.height });
      }

      pdfDoc.destroy();
      const bytes = await outDoc.save({ useObjectStreams: false });
      setResult(bytes.buffer as ArrayBuffer);
      setStatus('done');
      toast.success('Redactions applied — pages rasterized for permanent removal');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Redaction failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [buffer, file, marks, confirmed]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    triggerDownload(result, file.name.replace(/\.pdf$/i, '') + '-redacted.pdf', 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      {status === 'processing' && (
        <ProcessingOverlay progress={progress} label="Applying permanent redactions (rasterizing pages)…" />
      )}

      {/* Security notice */}
      <div className="flex gap-3 rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
        <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <div className="text-sm">
          <p className="font-medium text-[var(--color-error)]">Redaction is permanent and irreversible</p>
          <p className="mt-0.5 text-[var(--color-text-secondary)]">
            Redacted pages are rasterized (converted to images) to ensure complete content removal.
            The original text layer is destroyed — redacted content cannot be recovered or selected.
          </p>
        </div>
      </div>

      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to redact" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {/* Page viewer with draw overlay */}
      {thumbnails.length > 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Draw rectangles over the content you want to redact. Scroll to see all pages.
          </p>
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--color-border)] p-4">
            {thumbnails.map((thumb, i) => (
              <div key={i} className="flex flex-col gap-1">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">Page {i + 1}</p>
                <div
                  className="relative cursor-crosshair select-none overflow-hidden rounded-lg border border-[var(--color-border)]"
                  onMouseDown={(e) => handleMouseDown(e, i)}
                  onMouseMove={(e) => handleMouseMove(e, i)}
                  onMouseUp={(e) => handleMouseUp(e, i)}
                  aria-label={`Page ${i + 1} — draw to redact`}
                >
                  <img src={thumb.dataUrl} alt={`Page ${i + 1}`} className="block w-full" draggable={false} />
                  {/* Drawn marks overlay */}
                  {marks.filter((m) => m.pageIndex === i).map((mark) => (
                    <div key={mark.id}
                      className="absolute bg-red-600/60"
                      style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width}%`, height: `${mark.height}%` }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMarks((prev) => prev.filter((m) => m.id !== mark.id)); }}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] text-white hover:bg-red-700"
                        aria-label="Remove mark">×</button>
                    </div>
                  ))}
                  {/* Live preview while dragging */}
                  {isDrawing && drawStart && drawCurrent && activePage === i && (() => {
                    const x = Math.min(drawStart.x, drawCurrent.x);
                    const y = Math.min(drawStart.y, drawCurrent.y);
                    const w = Math.abs(drawCurrent.x - drawStart.x);
                    const h = Math.abs(drawCurrent.y - drawStart.y);
                    return (
                      <div className="absolute border-2 border-red-500 bg-red-500/30 pointer-events-none"
                        style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }} />
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
          {marks.length > 0 && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              {marks.length} area{marks.length !== 1 ? 's' : ''} marked for redaction
            </p>
          )}
        </div>
      )}

      {/* Confirmation */}
      {marks.length > 0 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 accent-[var(--color-error)]" />
          <span className="text-sm text-[var(--color-text-secondary)]">
            I understand that redaction is permanent and cannot be undone. The marked content will be removed.
          </span>
        </label>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {marks.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleRedact} disabled={!confirmed}
            className="w-full rounded-xl bg-[var(--color-error)] px-6 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-50 sm:w-auto">
            Apply Redactions
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download Redacted PDF" />}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Redactions applied!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
