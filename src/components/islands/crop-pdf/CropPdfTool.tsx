import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { triggerDownload } from '@/lib/download';
import { formatBytes } from '@/lib/utils';
import type { WorkerResponse, CropOptions } from '@/types/worker-messages';

type ApplyTo = 'all' | 'range';
type Status = 'idle' | 'processing' | 'done' | 'error';

const MM_TO_PT = 2.8346;

export default function CropPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [unit, setUnit] = useState<'mm' | 'pt'>('mm');
  const [applyTo, setApplyTo] = useState<ApplyTo>('all');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [pageRangeStr, setPageRangeStr] = useState('');

  const { isRunning, progress, progressLabel, run } = useWorker();

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResult(null);
    try { setBuffer(await fileToArrayBuffer(f)); } catch { setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.'); }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const parsePageRange = (str: string, totalPages: number): number[] => {
    if (!str.trim()) return [];
    const pages = new Set<number>();
    const parts = str.split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n.trim(), 10));
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          for (let i = Math.max(1, start); i <= end; i++) pages.add(i - 1);
        }
      } else {
        const p = parseInt(part.trim(), 10);
        if (!isNaN(p)) pages.add(p - 1);
      }
    }
    return Array.from(pages).filter(p => p >= 0 && p < totalPages).sort((a, b) => a - b);
  };

  const handleCrop = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }

    setStatus('processing');
    const factor = unit === 'mm' ? MM_TO_PT : 1;
    
    // In order to validate pageRange against page count, we briefly load just to get total pages.
    // Given we want to parse the range string accurately:
    const tempLib = await import('pdf-lib');
    const tempDoc = await tempLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    const parsedRange = parsePageRange(pageRangeStr, tempDoc.getPageCount());

    if (applyTo === 'range' && parsedRange.length === 0) {
      setStatus('idle');
      toast.error('Please enter a valid page range');
      return;
    }

    const opts: CropOptions = {
      mode: 'cropbox',
      margins: {
        top: margins.top * factor,
        right: margins.right * factor,
        bottom: margins.bottom * factor,
        left: margins.left * factor,
      },
      applyTo,
      pageRange: parsedRange,
    };
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'crop', buffer: bufCopy, options: opts, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('PDF cropped!'); }
  }, [buffer, file, margins, unit, applyTo, pageRangeStr, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    triggerDownload(result, file.name.replace(/\.pdf$/i, '') + '-cropped.pdf', 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to crop" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {file && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Crop Margins</h3>
            <div className="flex gap-1 rounded-lg bg-[var(--color-background)] p-0.5">
              {(['mm', 'pt'] as const).map((u) => (
                <button key={u} onClick={() => setUnit(u)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${unit === u ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]' : 'text-[var(--color-text-muted)]'}`}>
                  {u}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <div key={side}>
                <label className="mb-1 block text-xs capitalize text-[var(--color-text-secondary)]">{side}</label>
                <input type="number" min={0} step={1} value={margins[side]}
                  onChange={(e) => setMargins((p) => ({ ...p, [side]: Math.max(0, Number(e.target.value)) }))}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]" />
              </div>
            ))}
          </div>

          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">Apply to</p>
            <div className="flex gap-2">
              {(['all', 'range'] as ApplyTo[]).map((a) => (
                <button key={a} onClick={() => setApplyTo(a)}
                  className={`rounded-lg border px-3 py-1.5 text-xs capitalize transition-colors ${applyTo === a ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'}`}>
                  {a === 'all' ? 'All pages' : 'Page range'}
                </button>
              ))}
            </div>
            
            {applyTo === 'range' && (
              <div className="mt-3">
                <input
                  type="text"
                  placeholder="e.g. 1-5, 8, 11-13"
                  value={pageRangeStr}
                  onChange={(e) => setPageRangeStr(e.target.value)}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || 'Cropping PDF…'} />}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleCrop}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Crop PDF
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download Cropped PDF" />}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Crop applied!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
