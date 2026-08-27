import { useState, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import NextStep from '@/components/islands/shared/NextStep';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';
import { parsePageRange } from '@/lib/pdf-page-range';
import { triggerDownload } from '@/lib/download';
import { generateId, formatBytes } from '@/lib/utils';
import type { WorkerResponse, MergeOptions } from '@/types/worker-messages';

type Status = 'idle' | 'processing' | 'done' | 'error';

async function generateThumbnail(file: File): Promise<{ dataUrl: string; pageCount: number }> {
  const pdfjsLib = await getPdfjs();

  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: buffer }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const scale = 400 / Math.max(viewport.width, viewport.height);
  const scaledViewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  const ctx = canvas.getContext('2d')!;

  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas, viewport: scaledViewport }).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const pageCount = doc.numPages;
  doc.destroy();
  return { dataUrl, pageCount };
}

export default function MergePdfTool() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Optional per-file page-range strings (empty = all pages), keyed by file id.
  const [pageRanges, setPageRanges] = useState<Record<string, string>>({});

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();

  const handleFiles = useCallback((newFiles: File[]) => {
    const items: FileItem[] = newFiles.map((f) => ({ id: generateId(), file: f }));
    setFiles((prev) => [...prev, ...items]);

    for (const item of items) {
      generateThumbnail(item.file)
        .then(({ dataUrl, pageCount }) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, thumbnailUrl: dataUrl, pageCount } : f))
          );
        })
        .catch(() => {});
    }
  }, []);

  const handleReorder = useCallback((fromId: string, toId: string) => {
    setFiles((prev) => {
      const fi = prev.findIndex((f) => f.id === fromId);
      const ti = prev.findIndex((f) => f.id === toId);
      return fi !== -1 && ti !== -1 ? arrayMove(prev, fi, ti) : prev;
    });
  }, []);

  const handleRemove = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleMerge = useCallback(async () => {
    if (files.length < 2) { toast.error('Add at least 2 PDF files to merge'); return; }
    setStatus('processing'); setErrorMsg(null); setResult(null);

    try {
      const buffers = await Promise.all(files.map((f) => fileToArrayBuffer(f.file)));

      // Build per-file page selections (0-indexed); null = include all pages.
      const pageSelections = files.map((f) => {
        const raw = (pageRanges[f.id] ?? '').trim();
        if (!raw || !f.pageCount) return null;
        const idx = parsePageRange(raw, f.pageCount);
        return idx.length > 0 ? idx : null;
      });
      const options: MergeOptions = pageSelections.some((s) => s !== null) ? { pageSelections } : {};

      const { port1, port2 } = new MessageChannel();
      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'merge', buffers, options, progressPort: port2 },
        [...buffers, port2]
      );
      port1.close();
      if (!response) { setStatus('idle'); return; }
      if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
      if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('PDFs merged!'); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Merge failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [files, run, pageRanges]);

  const handleDownload = useCallback(async () => {
    if (!result) return;
    triggerDownload(result, 'merged.pdf', 'application/pdf');
  }, [result]);

  const totalSize = files.reduce((s, f) => s + f.file.size, 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Drop zone — full when empty, compact bar when files exist */}
      <DropZone
        accept={['application/pdf']}
        multiple
        maxFiles={50}
        onFiles={handleFiles}
        hint="PDF files only · Up to 50 files · Drag to reorder"
        compact={files.length > 0}
      />

      {/* All uploaded files as preview cards */}
      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">
              {files.length} file{files.length !== 1 ? 's' : ''} · {formatBytes(totalSize)} total
            </span>
            <button
              onClick={() => { setFiles([]); setStatus('idle'); setResult(null); }}
              className="text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-error)]"
            >
              Clear all
            </button>
          </div>

          {/* Card grid — all files, drag to reorder */}
          <FileList files={files} onReorder={handleReorder} onRemove={handleRemove} variant="cards" />

          {/* Optional per-file page selection */}
          <details className="rounded-lg border border-[var(--color-border)]" data-testid="page-select">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-text-primary)]">
              Choose pages per file (optional)
            </summary>
            <div className="flex flex-col gap-2 p-3">
              {files.map((f) => (
                <div key={f.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">
                    {f.file.name}{f.pageCount ? ` · ${f.pageCount}p` : ''}
                  </span>
                  <input
                    type="text"
                    value={pageRanges[f.id] ?? ''}
                    onChange={(e) => setPageRanges((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    placeholder="All pages (e.g. 1-3, 5)"
                    aria-label={`Pages to include from ${f.file.name}`}
                    data-testid="page-range-input"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1.5 text-xs outline-none focus:border-[var(--color-primary)] sm:w-56"
                  />
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Processing */}
      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Merging PDFs…'}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <button
              onClick={handleMerge}
              disabled={files.length < 2}
              data-testid="tool-action"
              className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
            >
              Merge {files.length > 0 ? `${files.length} PDFs` : 'PDFs'}
            </button>
            {files.length > 0 && files.length < 2 && (
              <p className="text-xs text-[var(--color-text-muted)]">Add at least 2 PDFs to merge</p>
            )}
          </div>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} fileName="merged.pdf" label="Download Merged PDF" />
          )}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Merge complete</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {formatBytes(result.byteLength)} · merged from {files.length} files
          </p>
        </div>
      )}

      {status === 'done' && result && (
        <NextStep href="/compress-pdf" label="Compress PDF">Large merged file? Shrink it with</NextStep>
      )}
    </div>
  );
}
