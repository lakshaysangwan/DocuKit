import { useState, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { generateId, formatBytes } from '@/lib/utils';
import type { WorkerResponse } from '@/types/worker-messages';

type Status = 'idle' | 'processing' | 'done' | 'error';

export default function MergePdfTool() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();
  const { thumbnails, loadThumbnails } = usePdfThumbnails();

  const handleFiles = useCallback(
    (newFiles: File[]) => {
      const items: FileItem[] = newFiles.map((f) => ({ id: generateId(), file: f }));
      setFiles((prev) => [...prev, ...items]);
      // Load thumbnail for page-count extraction on first file in batch
      if (newFiles[0]) {
        fileToArrayBuffer(newFiles[0])
          .then((buf) => loadThumbnails(buf, 120))
          .catch(() => {});
      }
    },
    [loadThumbnails]
  );

  const filesWithThumbs: FileItem[] = files.map((item, idx) => ({
    ...item,
    thumbnailUrl: thumbnails[idx]?.dataUrl,
  }));

  const handleReorder = useCallback(
    (fromId: string, toId: string) => {
      setFiles((prev) => {
        const fromIdx = prev.findIndex((f) => f.id === fromId);
        const toIdx = prev.findIndex((f) => f.id === toId);
        return fromIdx !== -1 && toIdx !== -1 ? arrayMove(prev, fromIdx, toIdx) : prev;
      });
    },
    []
  );

  const handleRemove = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleMerge = useCallback(async () => {
    if (files.length < 2) {
      toast.error('Add at least 2 PDF files to merge');
      return;
    }

    setStatus('processing');
    setErrorMsg(null);
    setResult(null);

    try {
      const buffers = await Promise.all(files.map((f) => fileToArrayBuffer(f.file)));

      // Create progress MessageChannel
      const { port1, port2 } = new MessageChannel();

      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'merge', buffers, options: {}, progressPort: port2 },
        [...buffers, port2]
      );

      port1.close();

      if (!response) {
        setStatus('idle');
        return;
      }

      if (response.status === 'error') {
        setStatus('error');
        setErrorMsg(response.message);
        toast.error(response.message);
        return;
      }

      if (response.status === 'success') {
        setResult(response.result);
        setStatus('done');
        toast.success('PDFs merged successfully!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Merge failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [files, run]);

  const handleDownload = useCallback(async () => {
    if (!result) return;
    triggerDownload(result, 'merged.pdf', 'application/pdf');
  }, [result]);

  const handleCancel = useCallback(() => {
    cancel();
    setStatus('idle');
  }, [cancel]);

  const totalSize = files.reduce((s, f) => s + f.file.size, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Drop zone */}
      <DropZone
        accept={['application/pdf']}
        multiple
        maxFiles={50}
        onFiles={handleFiles}
        hint="PDF files only · Up to 50 files · Drag to reorder"
      />

      {/* File list */}
      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-[var(--color-text-secondary)]">
            <span>
              {files.length} file{files.length !== 1 ? 's' : ''} · {formatBytes(totalSize)} total
            </span>
            <button
              onClick={() => setFiles([])}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
            >
              Clear all
            </button>
          </div>

          <FileList
            files={filesWithThumbs}
            onReorder={handleReorder}
            onRemove={handleRemove}
          />
        </div>
      )}

      {/* Processing overlay */}
      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Merging PDFs…'}
          onCancel={handleCancel}
        />
      )}

      {/* Error */}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={handleMerge}
            disabled={files.length < 2}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            Merge {files.length > 0 ? `${files.length} PDFs` : 'PDFs'}
          </button>

          {status === 'done' && result && (
            <DownloadButton
              onClick={handleDownload}
              fileName="merged.pdf"
              label="Download Merged PDF"
            />
          )}
        </div>
      )}

      {/* Success stats */}
      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Merge complete!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Output: {formatBytes(result.byteLength)} from {files.length} files
          </p>
        </div>
      )}
    </div>
  );
}
