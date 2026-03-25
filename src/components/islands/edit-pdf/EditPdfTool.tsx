import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import AnnotationToolbar, { type AnnotationTool, type StampType } from './AnnotationToolbar';
import AnnotationCanvas, { type AnnotationCanvasRef, type AnnotationObject, renderObjects, preloadImages } from './AnnotationCanvas';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { formatBytes } from '@/lib/utils';
import { triggerDownload } from '@/lib/download';

type Status = 'idle' | 'loading' | 'editing' | 'saving' | 'done' | 'error';
type SaveMode = 'flatten' | 'annotations';

interface PageData {
  index: number;
  dataUrl: string;
  width: number;
  height: number;
}

// History entry: per-page JSON snapshots
type HistoryEntry = Record<number, string>;

const MAX_HISTORY = 50;

export default function EditPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageData[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [status, setStatus] = useState<Status>('idle');
  const [saveMode, setSaveMode] = useState<SaveMode>('flatten');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Toolbar state
  const [activeTool, setActiveTool] = useState<AnnotationTool>('select');
  const [color, setColor] = useState('#1E293B');
  const [fontSize, setFontSize] = useState(16);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [opacity, setOpacity] = useState(1);
  const [stampType, setStampType] = useState<StampType>('APPROVED');

  // Undo/redo
  const [history, setHistory] = useState<HistoryEntry[]>([{}]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Per-page canvas JSON (persisted when switching pages)
  const pageStateRef = useRef<Record<number, string>>({});
  const fabricCanvasRef = useRef<AnnotationCanvasRef>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const [scaleFactor, setScaleFactor] = useState(1);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  // Measure container width and compute CSS transform scale factor.
  // Fabric canvas stays at native PDF dimensions; a parent div scales it visually.
  const currentPageData = pages[currentPage];
  useEffect(() => {
    if (!currentPageData || !canvasWrapperRef.current) { setScaleFactor(1); return; }
    const measure = () => {
      const containerW = canvasWrapperRef.current!.clientWidth;
      if (containerW <= 0) return;
      setScaleFactor(containerW / currentPageData.width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvasWrapperRef.current);
    return () => ro.disconnect();
  }, [currentPageData]);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    setStatus('loading');
    setPages([]);
    setCurrentPage(0);
    pageStateRef.current = {};
    setHistory([{}]);
    setHistoryIndex(0);

    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);

      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

      const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

      // Detect encrypted PDFs
      try { await doc.getPermissions(); } catch {
        throw new Error('This PDF is encrypted. Please use the Unlock PDF tool first to remove the password.');
      }

      const pageList: PageData[] = [];

      // Render all pages at 1.0 scale for universal UI compatibility
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d')!;
        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        }).promise;
        pageList.push({
          index: i - 1,
          dataUrl: canvas.toDataURL('image/jpeg', 0.8),
          width: canvas.width,
          height: canvas.height,
        });
      }

      setPages(pageList);
      setStatus('editing');
      toast.success(`Loaded ${doc.numPages} page${doc.numPages !== 1 ? 's' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load PDF';
      setStatus('idle');
      setFile(null);
      toast.error(msg);
    }
  }, []);

  // Save current page canvas state before switching
  const savePageState = useCallback(() => {
    const json = fabricCanvasRef.current?.getCanvasJSON();
    if (json) pageStateRef.current[currentPage] = json;
  }, [currentPage]);

  const switchPage = useCallback((idx: number) => {
    savePageState();
    setCurrentPage(idx);
  }, [savePageState]);

  // Push to undo history
  const pushHistory = useCallback(() => {
    const json = fabricCanvasRef.current?.getCanvasJSON();
    if (!json) return;
    const snapshot = { ...pageStateRef.current, [currentPage]: json };
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      const next = [...trimmed, snapshot].slice(-MAX_HISTORY);
      return next;
    });
    setHistoryIndex((prev) => Math.min(prev + 1, MAX_HISTORY - 1));
    pageStateRef.current = { ...pageStateRef.current, [currentPage]: json };
  }, [currentPage, historyIndex]);

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    const newIdx = historyIndex - 1;
    const snapshot = history[newIdx];
    pageStateRef.current = { ...snapshot };
    const pageJson = snapshot[currentPage];
    if (pageJson && fabricCanvasRef.current) {
      fabricCanvasRef.current.loadCanvasJSON(pageJson);
    }
    setHistoryIndex(newIdx);
  }, [canUndo, historyIndex, history, currentPage]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    const newIdx = historyIndex + 1;
    const snapshot = history[newIdx];
    pageStateRef.current = { ...snapshot };
    const pageJson = snapshot[currentPage];
    if (pageJson && fabricCanvasRef.current) {
      fabricCanvasRef.current.loadCanvasJSON(pageJson);
    }
    setHistoryIndex(newIdx);
  }, [canRedo, historyIndex, history, currentPage]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); handleRedo(); }
      if (e.key === 'Delete' || e.key === 'Backspace') fabricCanvasRef.current?.deleteSelected();
      if (e.key === 'v' || e.key === 'V') setActiveTool('select');
      if (e.key === 't' || e.key === 'T') setActiveTool('text');
      if (e.key === 'd' || e.key === 'D') setActiveTool('draw');
      if (e.key === 'r' || e.key === 'R') setActiveTool('rectangle');
      if (e.key === 'e' || e.key === 'E') setActiveTool('ellipse');
      if (e.key === 'l' || e.key === 'L') setActiveTool('line');
      if (e.key === 'h' || e.key === 'H') setActiveTool('highlight');
      if (e.key === 'w' || e.key === 'W') setActiveTool('whiteout');
      if (e.key === 's' || e.key === 'S') setActiveTool('stamp');
      if (e.key === 'i' || e.key === 'I') setActiveTool('image');
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo, handleRedo]);

  // Handle tool actions that need imperative calls
  const handleToolChange = useCallback((tool: AnnotationTool) => {
    const prev = activeTool;
    setActiveTool(tool);

    // Stop draw mode when leaving draw tool
    if (prev === 'draw' && tool !== 'draw') {
      fabricCanvasRef.current?.stopDrawMode();
    }

    if (tool === 'text') {
      fabricCanvasRef.current?.addText('Text', { fontSize, color, opacity });
    } else if (tool === 'stamp') {
      fabricCanvasRef.current?.addStamp(stampType, color, opacity);
    } else if (tool === 'draw') {
      fabricCanvasRef.current?.startDrawMode(strokeWidth, color, opacity);
    } else if (tool === 'image') {
      // Trigger file picker
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          fabricCanvasRef.current?.addImage(reader.result as string, opacity);
        };
        reader.readAsDataURL(f);
      };
      input.click();
      setActiveTool('select'); // revert to select after image insertion trigger
    }
  }, [activeTool, fontSize, color, opacity, stampType, strokeWidth]);

  const handleSave = useCallback(async () => {
    if (!buffer || !file || pages.length === 0) return;
    savePageState();
    setStatus('saving');

    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pdfPages = pdfDoc.getPages();

      const imageCache = new Map<string, HTMLImageElement>();

      for (let i = 0; i < pages.length; i++) {
        const pageJson = pageStateRef.current[i];
        if (!pageJson) continue;

        const pageData = pages[i];
        const pdfPage = pdfPages[i];
        const { width: pdfW, height: pdfH } = pdfPage.getSize();

        // Parse annotation objects from JSON
        let objects: AnnotationObject[];
        try { objects = JSON.parse(pageJson); } catch { continue; }
        if (!Array.isArray(objects) || objects.length === 0) continue;

        // Render annotations onto offscreen canvas at high resolution
        const scaleUp = Math.max(pdfW / pageData.width, 1) * 2;
        const offscreen = document.createElement('canvas');
        offscreen.width = pageData.width * scaleUp;
        offscreen.height = pageData.height * scaleUp;
        const ctx = offscreen.getContext('2d')!;
        ctx.scale(scaleUp, scaleUp);

        await preloadImages(objects, imageCache);
        renderObjects(ctx, objects, imageCache);

        const dataUrl = offscreen.toDataURL('image/png');

        // Extract base64 and generate Uint8Array
        const base64 = dataUrl.split(',')[1];
        const imgBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

        const pdfImg = await pdfDoc.embedPng(imgBytes);

        // Overlay onto the PDF page maintaining its native dimensions
        pdfPage.drawImage(pdfImg, { x: 0, y: 0, width: pdfW, height: pdfH });
      }

      const pdfBytes = await pdfDoc.save();
      triggerDownload(pdfBytes.buffer as ArrayBuffer, file.name.replace(/\.pdf$/i, '') + '-edited.pdf', 'application/pdf');
      setStatus('done');
      toast.success('PDF saved!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [buffer, file, pages, savePageState]);

  return (
    <div className="flex flex-col gap-6">
      {status === 'idle' && (
        <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to annotate" />
      )}

      {status === 'loading' && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <svg className="h-10 w-10 animate-spin text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-[var(--color-text-secondary)]">Loading PDF pages…</p>
        </div>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {(status === 'editing' || status === 'saving' || status === 'done') && file && pages.length > 0 && (
        <>
          {/* File info + page nav */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-secondary)]">
              {file.name} · {formatBytes(file.size)} · {pages.length} page{pages.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => { setStatus('idle'); setFile(null); setPages([]); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
            >
              Change file
            </button>
          </div>

          {/* Toolbar */}
          <AnnotationToolbar
            activeTool={activeTool}
            onToolChange={handleToolChange}
            color={color}
            onColorChange={setColor}
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            strokeWidth={strokeWidth}
            onStrokeWidthChange={setStrokeWidth}
            opacity={opacity}
            onOpacityChange={setOpacity}
            stampType={stampType}
            onStampTypeChange={setStampType}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            onDeleteSelected={() => fabricCanvasRef.current?.deleteSelected()}
          />

          {/* Page thumbnails */}
          {pages.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {pages.map((p, i) => (
                <button
                  key={i}
                  onClick={() => switchPage(i)}
                  className={[
                    'shrink-0 overflow-hidden rounded-lg border-2 transition-colors',
                    i === currentPage ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]',
                  ].join(' ')}
                  style={{ width: 60, height: 80 }}
                >
                  <img src={p.dataUrl} alt={`Page ${i + 1}`} className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}

          {/* Canvas editor — Fabric stays at native PDF dims, CSS transform scales visually */}
          <div
            ref={canvasWrapperRef}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] w-full overflow-hidden"
            style={{ height: currentPageData ? currentPageData.height * scaleFactor : undefined }}
          >
            {currentPageData && (
              <div style={{
                width: currentPageData.width,
                height: currentPageData.height,
                transform: `scale(${scaleFactor})`,
                transformOrigin: 'top left',
              }}>
                <AnnotationCanvas
                  ref={fabricCanvasRef}
                  backgroundUrl={currentPageData.dataUrl}
                  width={currentPageData.width}
                  height={currentPageData.height}
                  activeTool={activeTool}
                  color={color}
                  fontSize={fontSize}
                  strokeWidth={strokeWidth}
                  opacity={opacity}
                  stampType={stampType}
                  onHistoryChange={pushHistory}
                />
              </div>
            )}
          </div>

          {/* Save options + download */}
          <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Save mode</label>
              <div className="flex gap-2">
                {([['flatten', 'Flatten (permanent)'], ['annotations', 'Keep as Annotations']] as const).map(([v, l]) => (
                  <button key={v} onClick={() => setSaveMode(v)}
                    className={[
                      'rounded-xl border px-4 py-2 text-sm transition-colors',
                      saveMode === v
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)] font-medium'
                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)]',
                    ].join(' ')}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                {saveMode === 'flatten'
                  ? 'Annotations are composited into the page — not editable after saving.'
                  : 'Annotations are saved as PDF annotation objects, viewable in Adobe Reader.'}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              onClick={handleSave}
              disabled={status === 'saving'}
              className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] disabled:opacity-50 sm:w-auto"
            >
              {status === 'saving' ? 'Saving…' : 'Save & Download PDF'}
            </button>
            {status === 'done' && (
              <DownloadButton onClick={handleSave} label="Download Again" />
            )}
          </div>
        </>
      )}
    </div>
  );
}
