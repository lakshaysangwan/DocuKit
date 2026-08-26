import { useState, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes, generateId, cn } from '@/lib/utils';
import type { WorkerResponse, ImagesToPdfOptions } from '@/types/worker-messages';

type PageSize = 'fit' | 'a4' | 'letter' | 'legal';
type Placement = 'center' | 'stretch' | 'fit' | 'cover';
type Status = 'idle' | 'processing' | 'done' | 'error';

const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif'];

export default function ImageToPdfTool() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [placement, setPlacement] = useState<Placement>('center');
  const [margins, setMargins] = useState({ top: 28, right: 28, bottom: 28, left: 28 });
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { isRunning, progress, progressLabel, run } = useWorker();

  const handleFiles = useCallback((newFiles: File[]) => {
    const items: FileItem[] = newFiles.map((f) => ({
      id: generateId(),
      file: f,
      thumbnailUrl: URL.createObjectURL(f),
    }));
    setFiles((prev) => [...prev, ...items]);
    setStatus('idle');
    setResult(null);
  }, []);

  const handleReorder = useCallback((fromId: string, toId: string) => {
    setFiles((prev) => {
      const fi = prev.findIndex((f) => f.id === fromId);
      const ti = prev.findIndex((f) => f.id === toId);
      return fi !== -1 && ti !== -1 ? arrayMove(prev, fi, ti) : prev;
    });
  }, []);

  const handleRemove = useCallback((id: string) => {
    setFiles((prev) => {
      const removed = prev.find((f) => f.id === id);
      if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const handleConvert = useCallback(async () => {
    if (files.length === 0) { toast.error('Add at least one image'); return; }
    setStatus('processing');
    setErrorMsg(null);
    try {
      const buffers = await Promise.all(files.map((f) => fileToArrayBuffer(f.file)));
      const mimeTypes = files.map((f) => f.file.type || 'image/jpeg');
      const opts: ImagesToPdfOptions = { pageSize, placement, margins, backgroundColor: '#FFFFFF' };
      const { port1, port2 } = new MessageChannel();
      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'images-to-pdf', buffers, mimeTypes, options: opts, progressPort: port2 },
        [...buffers, port2]
      );
      port1.close();
      if (!response) { setStatus('idle'); return; }
      if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
      if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('PDF created!'); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Conversion failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [files, pageSize, placement, margins, run]);

  const handleDownload = useCallback(async () => {
    if (!result) return;
    triggerDownload(result, 'images.pdf', 'application/pdf');
  }, [result]);

  const totalSize = files.reduce((s, f) => s + f.file.size, 0);

  return (
    <div className="flex flex-col gap-5">
      <DropZone
        accept={ACCEPTED_MIMES}
        multiple
        onFiles={handleFiles}
        hint="JPEG, PNG, WebP, BMP, GIF · Drop multiple images"
        compact={files.length > 0}
      />

      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">
              {files.length} image{files.length !== 1 ? 's' : ''} · {formatBytes(totalSize)}
            </span>
            <button
              onClick={() => { files.forEach(f => f.thumbnailUrl && URL.revokeObjectURL(f.thumbnailUrl)); setFiles([]); setResult(null); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
            >
              Clear all
            </button>
          </div>
          <FileList files={files} onReorder={handleReorder} onRemove={handleRemove} variant="cards" />
        </div>
      )}

      {/* Settings */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex flex-col gap-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Page Size</label>
            <div className="flex flex-wrap gap-2">
              {(['fit', 'a4', 'letter', 'legal'] as PageSize[]).map((s) => (
                <button key={s} onClick={() => setPageSize(s)}
                  className={cn('rounded-lg border px-4 py-2 text-sm uppercase transition-colors',
                    pageSize === s ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>
                  {s === 'fit' ? 'Fit Image' : s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {pageSize !== 'fit' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Image Placement</label>
              <div className="flex flex-wrap gap-2">
                {(['center', 'fit', 'stretch', 'cover'] as Placement[]).map((p) => (
                  <button key={p} onClick={() => setPlacement(p)}
                    className={cn('rounded-lg border px-4 py-2 text-sm capitalize transition-colors',
                      placement === p ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                    )}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pageSize !== 'fit' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Margins (pt)</label>
              <div className="grid grid-cols-4 gap-3">
                {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                  <div key={side}>
                    <label className="mb-1 block text-xs capitalize text-[var(--color-text-muted)]">{side}</label>
                    <input type="number" min={0} value={margins[side]}
                      onChange={(e) => setMargins((p) => ({ ...p, [side]: Math.max(0, Number(e.target.value)) }))}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || 'Creating PDF…'} />}
      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && files.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleConvert} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 sm:w-auto">
            Convert {files.length} image{files.length !== 1 ? 's' : ''} to PDF
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download PDF" />}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">PDF created!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
