import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload, createZipAndDownload } from '@/lib/download';
import { formatBytes } from '@/lib/utils';
import { parsePageRange, parseMultiRanges, formatPageRange } from '@/lib/pdf-page-range';
import type { WorkerResponse } from '@/types/worker-messages';
import { cn } from '@/lib/utils';

type SplitMode = 'extract' | 'ranges' | 'every-n' | 'each' | 'remove';
type Status = 'idle' | 'processing' | 'done' | 'error';

const MODES: { value: SplitMode; label: string; description: string }[] = [
  { value: 'extract', label: 'Extract Pages', description: 'Get specific pages as a single PDF' },
  { value: 'remove', label: 'Remove Pages', description: 'Delete pages and keep the rest' },
  { value: 'ranges', label: 'Split by Range', description: 'Split into multiple PDFs by range' },
  { value: 'every-n', label: 'Split Every N', description: 'Split into equal chunks' },
  { value: 'each', label: 'Extract Each Page', description: 'One PDF per page (ZIP download)' },
];

export default function SplitPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [mode, setMode] = useState<SplitMode>('extract');
  const [rangeInput, setRangeInput] = useState('');
  const [everyN, setEveryN] = useState(2);
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<ArrayBuffer[]>([]);
  const [singleResult, setSingleResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();
  const { pageCount, loadThumbnails } = usePdfThumbnails();

  const handleFiles = useCallback(async (newFiles: File[]) => {
    const f = newFiles[0];
    if (!f) return;
    setFile(f);
    setStatus('idle');
    setResults([]);
    setSingleResult(null);
    setErrorMsg(null);

    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      await loadThumbnails(buf, 80);
    } catch {
      setFile(null); setBuffer(null); toast.error('Failed to load. If it is encrypted, please unlock it first.');
    }
  }, [loadThumbnails]);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResults([]); setSingleResult(null); setErrorMsg(null);
  }, []);

  // Compute selected page count for display
  const selectedCount = (() => {
    if (!pageCount || mode === 'each' || mode === 'every-n') return null;
    if (!rangeInput.trim()) return 0;
    try {
      const pages = parsePageRange(rangeInput, pageCount);
      return pages.length;
    } catch {
      return null;
    }
  })();

  const handleSplit = useCallback(async () => {
    if (!buffer || !file || !pageCount) {
      toast.error('Upload a PDF first');
      return;
    }

    setStatus('processing');
    setErrorMsg(null);
    setResults([]);
    setSingleResult(null);

    try {
      // Build SplitOptions based on mode
      let splitOptions: import('@/types/worker-messages').SplitOptions;

      if (mode === 'extract') {
        const pages = parsePageRange(rangeInput, pageCount);
        if (pages.length === 0) { toast.error('No valid pages selected'); setStatus('idle'); return; }
        splitOptions = { mode: 'extract', pages };
      } else if (mode === 'remove') {
        const pages = parsePageRange(rangeInput, pageCount);
        if (pages.length === 0) { toast.error('No pages to remove'); setStatus('idle'); return; }
        splitOptions = { mode: 'remove', pages };
      } else if (mode === 'ranges') {
        const ranges = parseMultiRanges(rangeInput, pageCount);
        if (ranges.length === 0) { toast.error('No valid ranges'); setStatus('idle'); return; }
        splitOptions = { mode: 'ranges', ranges };
      } else if (mode === 'every-n') {
        if (everyN < 1) { toast.error('N must be at least 1'); setStatus('idle'); return; }
        splitOptions = { mode: 'every-n', n: everyN };
      } else {
        splitOptions = { mode: 'each' };
      }

      const { port1, port2 } = new MessageChannel();
      const bufCopy = buffer.slice(0);

      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'split', buffer: bufCopy, options: splitOptions, progressPort: port2 },
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

      if (response.status === 'success-multi') {
        setResults(response.results);
        setStatus('done');
        toast.success(`Split into ${response.results.length} PDFs`);
      } else if (response.status === 'success') {
        setSingleResult(response.result);
        setStatus('done');
        toast.success('Pages extracted successfully!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Split failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [buffer, file, pageCount, mode, rangeInput, everyN, run]);

  const handleDownload = useCallback(async () => {
    if (singleResult) {
      const baseName = file?.name.replace(/\.pdf$/i, '') ?? 'document';
      triggerDownload(singleResult, `${baseName}-split.pdf`, 'application/pdf');
    } else if (results.length > 0) {
      const baseName = file?.name.replace(/\.pdf$/i, '') ?? 'document';
      const files = results.map((buf, i) => ({ name: `${baseName}-part${i + 1}.pdf`, buffer: buf }));
      await createZipAndDownload(files, `${baseName}-split.zip`);
    }
  }, [singleResult, results, file]);

  const isMultiOutput = results.length > 0;
  const outputSize = singleResult?.byteLength ?? results.reduce((s, b) => s + b.byteLength, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Drop zone */}
      <DropZone
        accept={['application/pdf']}
        multiple={false}
        onFiles={handleFiles}
        hint="Single PDF file"
      >
        {file && (
          <div className="flex flex-col items-center gap-2 p-6">
            <svg className="h-10 w-10 text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <p className="font-medium text-[var(--color-text-primary)] text-sm">{file.name}</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {formatBytes(file.size)}{pageCount ? ` · ${pageCount} pages` : ''}
            </p>
          </div>
        )}
      </DropZone>

      {file && <FileInfoCard file={file} extra={pageCount ? `${pageCount} pages` : undefined} onRemove={handleRemoveFile} />}

      {/* Mode selector */}
      {file && (
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
              Split mode
            </label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={cn(
                    'rounded-xl border p-3 text-left transition-colors',
                    mode === m.value
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50'
                  )}
                >
                  <p className="text-sm font-medium">{m.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{m.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Range input */}
          {(mode === 'extract' || mode === 'remove' || mode === 'ranges') && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">
                {mode === 'ranges' ? 'Page ranges (comma-separated)' : 'Page selection'}
              </label>
              <input
                type="text"
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                placeholder={mode === 'ranges' ? '1-5, 6-10, 11-last' : '1-5, 8, odd, last'}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/20"
              />
              {pageCount && selectedCount !== null && (
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  {selectedCount} of {pageCount} pages selected
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Supports: <code className="rounded bg-[var(--color-surface)] px-1">1-5</code>,{' '}
                <code className="rounded bg-[var(--color-surface)] px-1">odd</code>,{' '}
                <code className="rounded bg-[var(--color-surface)] px-1">even</code>,{' '}
                <code className="rounded bg-[var(--color-surface)] px-1">last</code>
              </p>
            </div>
          )}

          {/* Every N input */}
          {mode === 'every-n' && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">
                Pages per chunk
              </label>
              <input
                type="number"
                min={1}
                max={pageCount ?? 9999}
                value={everyN}
                onChange={(e) => setEveryN(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-32 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
              />
              {pageCount && (
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  Creates ~{Math.ceil(pageCount / everyN)} parts
                </p>
              )}
            </div>
          )}

          {mode === 'each' && pageCount && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              Will create {pageCount} individual PDF files, downloaded as a ZIP.
            </p>
          )}
        </div>
      )}

      {/* Processing overlay */}
      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Splitting PDF…'}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      )}

      {/* Error */}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={handleSplit}
            disabled={!file || !pageCount}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            Split PDF
          </button>

          {status === 'done' && (singleResult || results.length > 0) && (
            <DownloadButton
              onClick={handleDownload}
              label={isMultiOutput ? `Download ZIP (${results.length} files)` : 'Download PDF'}
            />
          )}
        </div>
      )}

      {/* Result stats */}
      {status === 'done' && (singleResult || results.length > 0) && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Split complete!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {isMultiOutput ? `${results.length} files` : '1 file'} · {formatBytes(outputSize)}
          </p>
        </div>
      )}
    </div>
  );
}
