import { useState, useCallback, useReducer } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import PageThumbnailGrid, { type PageItem } from '@/components/islands/shared/PageThumbnailGrid';
import { useWorker } from '@/hooks/use-worker';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes, generateId } from '@/lib/utils';
import type { WorkerResponse } from '@/types/worker-messages';

type Status = 'idle' | 'processing' | 'done' | 'error';

type HistoryAction =
  | { type: 'push'; pages: PageItem[] }
  | { type: 'undo' }
  | { type: 'redo' };

interface HistoryStore {
  past: PageItem[][];
  present: PageItem[];
  future: PageItem[][];
}

function historyReducer(state: HistoryStore, action: HistoryAction): HistoryStore {
  switch (action.type) {
    case 'push':
      return { past: [...state.past.slice(-19), state.present], present: action.pages, future: [] };
    case 'undo':
      if (state.past.length === 0) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
      };
    case 'redo':
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      };
  }
}

function makePageItems(count: number): PageItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: generateId(),
    originalIndex: i,
    rotation: 0,
  }));
}

export default function OrganizePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [history, dispatch] = useReducer(historyReducer, {
    past: [],
    present: [],
    future: [],
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [thumbnailSize, setThumbnailSize] = useState(120);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();
  const { thumbnails, isLoading, loadThumbnails } = usePdfThumbnails();

  const pages = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const updatePages = useCallback((next: PageItem[]) => {
    dispatch({ type: 'push', pages: next });
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); dispatch({ type: 'push', pages: [] }); setSelectedIds(new Set());
    setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const handleDrop = useCallback(async (newFiles: File[]) => {
    const f = newFiles[0];
    if (!f) return;
    setFile(f);
    setStatus('idle');
    setResult(null);
    setSelectedIds(new Set());

    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      const count = await loadThumbnails(buf, 150);
      if (count > 0) {
        dispatch({ type: 'push', pages: makePageItems(count) });
      }
    } catch {
      setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.');
    }
  }, [loadThumbnails]);

  const handleReorder = useCallback((fromId: string, toId: string) => {
    const fromIdx = pages.findIndex((p) => p.id === fromId);
    const toIdx = pages.findIndex((p) => p.id === toId);
    if (fromIdx !== -1 && toIdx !== -1) {
      updatePages(arrayMove(pages, fromIdx, toIdx));
    }
  }, [pages, updatePages]);

  const handleSelect = useCallback((id: string, mode: 'single' | 'toggle' | 'range') => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (mode === 'single') { next.clear(); next.add(id); }
      else if (mode === 'toggle') { if (next.has(id)) next.delete(id); else next.add(id); }
      else next.add(id);
      return next;
    });
  }, []);

  const handleRotate = useCallback((id: string, direction: 'cw' | 'ccw') => {
    updatePages(pages.map((p) => {
      if (p.id !== id) return p;
      const delta = direction === 'cw' ? 90 : -90;
      return { ...p, rotation: ((p.rotation + delta) % 360 + 360) % 360 as 0 | 90 | 180 | 270 };
    }));
  }, [pages, updatePages]);

  const handleDelete = useCallback((id: string) => {
    updatePages(pages.filter((p) => p.id !== id));
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }, [pages, updatePages]);

  const handleApply = useCallback(async () => {
    if (!buffer || !file || pages.length === 0) {
      toast.error('Load a PDF first');
      return;
    }

    setStatus('processing');
    setErrorMsg(null);

    try {
      const order = pages.map((p) => p.originalIndex);
      const rotations: Record<number, 0 | 90 | 180 | 270> = {};
      pages.forEach((p) => { if (p.rotation) rotations[p.originalIndex] = p.rotation as 0 | 90 | 180 | 270; });

      const { port1, port2 } = new MessageChannel();
      const bufCopy = buffer.slice(0);

      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'reorder', buffer: bufCopy, options: { order, rotations }, progressPort: port2 },
        [bufCopy, port2]
      );

      port1.close();

      if (!response) { setStatus('idle'); return; }
      if (response.status === 'error') {
        setStatus('error');
        setErrorMsg(response.message);
        toast.error(response.message);
        return;
      }
      if (response.status === 'success') {
        setResult(response.result);
        setStatus('done');
        toast.success('Pages organized!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [buffer, file, pages, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    const base = file.name.replace(/\.pdf$/i, '');
    triggerDownload(result, `${base}-organized.pdf`, 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone
        accept={['application/pdf']}
        multiple={false}
        onFiles={handleDrop}
        hint="Single PDF file"
      />

      {file && <FileInfoCard file={file} extra={pages.length ? `${pages.length} pages` : undefined} onRemove={handleRemoveFile} />}

      {file && pages.length === 0 && isLoading && (
        <div className="flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading pages…
        </div>
      )}

      {/* Toolbar */}
      {pages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!canUndo}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-[var(--color-surface)]"
            title="Undo (Ctrl+Z)">
            ↩ Undo
          </button>
          <button onClick={() => dispatch({ type: 'redo' })} disabled={!canRedo}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-[var(--color-surface)]"
            title="Redo">
            ↪ Redo
          </button>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-[var(--color-text-muted)]">Size</span>
            {[80, 120, 160].map((s) => (
              <button key={s} onClick={() => setThumbnailSize(s)}
                className={`rounded-lg px-2 py-1 text-xs ${thumbnailSize === s ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)] hover:bg-[var(--color-surface)]'}`}>
                {s === 80 ? 'S' : s === 120 ? 'M' : 'L'}
              </button>
            ))}
          </div>

          <span className="text-xs text-[var(--color-text-muted)]">
            {pages.length} page{pages.length !== 1 ? 's' : ''}
            {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
          </span>
        </div>
      )}

      {/* Grid */}
      {pages.length > 0 && (
        <PageThumbnailGrid
          pages={pages}
          thumbnails={thumbnails}
          selectedIds={selectedIds}
          onSelect={handleSelect}
          onReorder={handleReorder}
          onRotate={handleRotate}
          onDelete={handleDelete}
          thumbnailSize={thumbnailSize}
        />
      )}

      {/* Processing */}
      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Applying changes…'}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && pages.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={handleApply}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto"
          >
            Apply & Download
          </button>
          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label="Download PDF" />
          )}
        </div>
      )}

      {status === 'done' && result && file && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Done!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {pages.length} pages · {formatBytes(result.byteLength)}
          </p>
        </div>
      )}
    </div>
  );
}
