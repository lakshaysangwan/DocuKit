import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { notifyPdfLoadError } from '@/lib/notify';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';
import { createCanvas2D, canvasToBlob } from '@/lib/canvas-2d';
import { redactWithMupdf } from '@/lib/redact-with-mupdf';
import { triggerDownload } from '@/lib/download';
import { formatBytes, generateId } from '@/lib/utils';

type Status = 'idle' | 'processing' | 'done' | 'error';

/** A region marked for redaction, in page-relative percent (0-100) coords */
interface RedactMark {
  id: string;
  pageIndex: number;
  x: number; y: number; width: number; height: number; // percent
}

/**
 * Fallback redaction: render each page to a raster and paint black boxes over
 * the marks, then re-embed as images. Guarantees content removal but destroys
 * the text layer — used only if the MuPDF path fails.
 */
async function rasterizeRedact(
  buffer: ArrayBuffer,
  marks: RedactMark[],
  setProgress: (n: number) => void,
): Promise<ArrayBuffer> {
  const pdfjsLib = await getPdfjs();
  const { PDFDocument } = await import('pdf-lib');

  const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: new Uint8Array(buffer) }).promise;
  const outDoc = await PDFDocument.create();

  const marksByPage = new Map<number, RedactMark[]>();
  for (const m of marks) {
    const list = marksByPage.get(m.pageIndex) ?? [];
    list.push(m);
    marksByPage.set(m.pageIndex, list);
  }

  const RENDER_SCALE = 3; // ~216 DPI for quality
  const totalPgs = pdfDoc.numPages;

  for (let i = 0; i < totalPgs; i++) {
    setProgress(Math.round((i / totalPgs) * 90));

    const page = await pdfDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: RENDER_SCALE });

    const { canvas, ctx } = createCanvas2D(vp.width, vp.height);

    await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any } as any).promise;

    const pageMarks = marksByPage.get(i);
    if (pageMarks) {
      ctx.fillStyle = '#000000';
      for (const m of pageMarks) {
        ctx.fillRect((m.x / 100) * vp.width, (m.y / 100) * vp.height, (m.width / 100) * vp.width, (m.height / 100) * vp.height);
      }
    }

    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const imgBytes = new Uint8Array(await blob.arrayBuffer());
    const img = await outDoc.embedJpg(imgBytes);

    const origVp = page.getViewport({ scale: 1 });
    const outPage = outDoc.addPage([origVp.width, origVp.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: origVp.width, height: origVp.height });
  }

  pdfDoc.destroy();
  const bytes = await outDoc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

/** Hex SHA-256 of a buffer, for the before/after integrity panel. */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const [stripMetadata, setStripMetadata] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hashes, setHashes] = useState<{ before: string; after: string } | null>(null);

  const { thumbnails, loadThumbnails } = usePdfThumbnails();

  // Compute a before/after SHA-256 once redaction completes, so users can prove
  // the file actually changed (and record the redacted hash for their audit log).
  useEffect(() => {
    let cancelled = false;
    if (status !== 'done' || !result || !buffer) { setHashes(null); return; }
    (async () => {
      try {
        const [before, after] = await Promise.all([sha256Hex(buffer.slice(0)), sha256Hex(result.slice(0))]);
        if (!cancelled) setHashes({ before, after });
      } catch { if (!cancelled) setHashes(null); }
    })();
    return () => { cancelled = true; };
  }, [status, result, buffer]);

  /**
   * Find & Redact: search the text layer for a phrase and add a redaction mark
   * over every match on every page. Turns "remove all SSNs" into one click.
   */
  const handleFindAndMark = useCallback(async () => {
    const q = query.trim().toLowerCase();
    if (!buffer || !q) { toast.error('Enter text to find'); return; }
    setSearching(true);
    try {
      const pdfjsLib = await getPdfjs();
      const doc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: buffer.slice(0) }).promise;
      const found: RedactMark[] = [];
      for (let p = 0; p < doc.numPages; p++) {
        const page = await doc.getPage(p + 1);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!('str' in item) || !item.str.toLowerCase().includes(q)) continue;
          const m = pdfjsLib.Util.transform(vp.transform, item.transform);
          const x = m[4];
          const baseline = m[5];
          const w = item.width;
          const h = item.height || Math.abs(m[3]) || 10;
          const pad = h * 0.25;
          found.push({
            id: generateId(),
            pageIndex: p,
            x: Math.max(0, ((x - pad) / vp.width) * 100),
            y: Math.max(0, ((baseline - h - pad) / vp.height) * 100),
            width: ((w + pad * 2) / vp.width) * 100,
            height: ((h + pad * 2) / vp.height) * 100,
          });
        }
      }
      doc.destroy();
      if (found.length === 0) { toast.info(`No matches for “${query.trim()}”`); return; }
      setMarks((prev) => [...prev, ...found]);
      toast.success(`Marked ${found.length} match${found.length !== 1 ? 'es' : ''}`);
    } catch {
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  }, [buffer, query]);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setMarks([]); setStatus('idle'); setResult(null); setConfirmed(false);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      const count = await loadThumbnails(buf); // Default is 800 now for high-clarity
      if (count === 0) throw new Error('PDF could not be parsed');
    } catch {
      setFile(null); setStatus('idle'); setMarks([]); setBuffer(null);
      notifyPdfLoadError();
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

    try {
      // Primary path: true per-region redaction via MuPDF. Content under each
      // mark is physically removed; the rest of the text layer stays selectable.
      setProgress(30);
      const bytes = await redactWithMupdf(buffer, marks, stripMetadata);
      setProgress(100);
      setResult(bytes);
      setStatus('done');
      toast.success('Redactions applied — marked content permanently removed');
    } catch (mupdfErr) {
      // Fallback: rasterize pages so content is still destroyed even if MuPDF
      // rejects the document. This loses the selectable text layer.
      console.warn('MuPDF redaction failed, falling back to rasterization:', mupdfErr);
      try {
        const bytes = await rasterizeRedact(buffer, marks, setProgress);
        setResult(bytes);
        setStatus('done');
        toast.success('Redactions applied (rasterized fallback)');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Redaction failed';
        setStatus('error'); setErrorMsg(msg); toast.error(msg);
      }
    }
  }, [buffer, file, marks, confirmed, stripMetadata]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    triggerDownload(result, file.name.replace(/\.pdf$/i, '') + '-redacted.pdf', 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      {status === 'processing' && (
        <ProcessingOverlay progress={progress} label="Applying permanent redactions…" />
      )}

      {/* Security notice */}
      <div className="flex gap-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
        <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <div className="text-sm">
          <p className="font-medium text-[var(--color-error)]">Redaction is permanent and irreversible</p>
          <p className="mt-0.5 text-[var(--color-text-secondary)]">
            The text, images, and vector content beneath each mark are permanently removed from the
            file — not just hidden. The rest of the document stays intact and selectable.
          </p>
        </div>
      </div>

      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to redact" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {/* Find & Redact — auto-mark every occurrence of a phrase */}
      {thumbnails.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleFindAndMark(); }}
            placeholder="Find text to redact (e.g. a name or number)"
            aria-label="Find text to redact"
            data-testid="redact-search"
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
          />
          <button
            onClick={handleFindAndMark}
            disabled={searching || !query.trim()}
            data-testid="redact-find"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:border-[var(--color-primary)] disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Find & mark all'}
          </button>
        </div>
      )}

      {/* Page viewer with draw overlay */}
      {thumbnails.length > 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Draw rectangles over the content you want to redact. Scroll to see all pages.
          </p>
          <p className="sr-only">
            Drawing redaction boxes requires a pointer. For keyboard access, use the
            “Find text to redact” field above to mark every occurrence of a phrase, then
            remove any unwanted mark with its focusable “Remove mark” button.
          </p>
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto rounded-lg border border-[var(--color-border)] p-4">
            {thumbnails.map((thumb, i) => (
              <div key={i} className="flex flex-col gap-1">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">Page {i + 1}</p>
                <div
                  className="relative cursor-crosshair select-none overflow-hidden rounded-lg border border-[var(--color-border)]"
                  onMouseDown={(e) => handleMouseDown(e, i)}
                  onMouseMove={(e) => handleMouseMove(e, i)}
                  onMouseUp={(e) => handleMouseUp(e, i)}
                  data-testid="redact-page"
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

      {/* Metadata strip option */}
      {marks.length > 0 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-4">
          <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)}
            data-testid="strip-metadata" className="mt-0.5" />
          <span className="text-sm text-[var(--color-text-secondary)]">
            Full metadata strip
            <span className="block text-xs text-[var(--color-text-muted)]">
              Also removes the XMP metadata packet and any embedded file attachments. Author,
              title and the other document-info fields are always cleared.
            </span>
          </span>
        </label>
      )}

      {/* Confirmation */}
      {marks.length > 0 && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
            data-testid="confirm-redaction"
            className="mt-0.5 accent-[var(--color-error)]" />
          <span className="text-sm text-[var(--color-text-secondary)]">
            I understand that redaction is permanent and cannot be undone. The marked content will be removed.
          </span>
        </label>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {marks.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleRedact} disabled={!confirmed} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-error)] px-6 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-50 sm:w-auto">
            Apply Redactions
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download Redacted PDF" />}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Redactions applied!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
          {hashes && (
            <div className="mt-3 border-t border-[var(--color-success)]/20 pt-3" data-testid="sha-panel">
              <p className="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">SHA-256 integrity</p>
              <p className="break-all font-mono text-[10px] text-[var(--color-text-muted)]">
                <span className="font-sans font-medium">Original:</span> <span data-testid="sha-before">{hashes.before}</span>
              </p>
              <p className="break-all font-mono text-[10px] text-[var(--color-text-muted)]">
                <span className="font-sans font-medium">Redacted:</span> <span data-testid="sha-after">{hashes.after}</span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
