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
import { cn } from '@/lib/utils';
import type { WorkerResponse, PageNumberOptions } from '@/types/worker-messages';

type Status = 'idle' | 'processing' | 'done' | 'error';

const POSITIONS: PageNumberOptions['position'][] = [
  'bottom-center', 'bottom-left', 'bottom-right',
  'top-center', 'top-left', 'top-right',
];
const FORMATS: { value: PageNumberOptions['format']; label: string }[] = [
  { value: 'n', label: '1, 2, 3…' },
  { value: 'page-n', label: 'Page 1, Page 2…' },
  { value: 'page-n-of-total', label: 'Page 1 of 10…' },
  { value: 'n-of-total', label: '1/10, 2/10…' },
  { value: 'roman', label: 'i, ii, iii…' },
  { value: 'alpha', label: 'a, b, c…' },
];

export default function PageNumbersTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [position, setPosition] = useState<PageNumberOptions['position']>('bottom-center');
  const [format, setFormat] = useState<PageNumberOptions['format']>('page-n-of-total');
  const [startNumber, setStartNumber] = useState(1);
  const [skipFirstN, setSkipFirstN] = useState(0);
  const [fontSize, setFontSize] = useState(10);
  const [color, setColor] = useState('#333333');
  const [marginX, setMarginX] = useState(20);
  const [marginY, setMarginY] = useState(15);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run } = useWorker();

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResult(null);
    try { setBuffer(await fileToArrayBuffer(f)); } catch { setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.'); }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const handleApply = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }

    setStatus('processing');
    const opts: PageNumberOptions = {
      position, format, startNumber, skipFirstN,
      font: 'Helvetica', fontSize, color, marginX, marginY,
    };
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'add-page-numbers', buffer: bufCopy, options: opts, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('Page numbers added!'); }
  }, [buffer, file, position, format, startNumber, skipFirstN, fontSize, color, marginX, marginY, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    triggerDownload(result, file.name.replace(/\.pdf$/i, '') + '-numbered.pdf', 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to number" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {file && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="flex flex-col gap-5">
            {/* Position */}
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Position</label>
              <div className="grid grid-cols-3 gap-2">
                {POSITIONS.map((p) => (
                  <button key={p} onClick={() => setPosition(p)}
                    className={cn('rounded-xl border py-2 text-xs capitalize transition-colors',
                      position === p ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                    )}>
                    {p.replace('-', ' ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Format */}
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Format</label>
              <div className="flex flex-col gap-2">
                {FORMATS.map((f) => (
                  <label key={f.value} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="radio" name="format" value={f.value} checked={format === f.value}
                      onChange={() => setFormat(f.value)} className="accent-[var(--color-primary)]" />
                    <span className="text-[var(--color-text-secondary)]">{f.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Options */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Start number</label>
                <input type="number" min={1} value={startNumber} onChange={(e) => setStartNumber(Math.max(1, Number(e.target.value)))}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Skip first N pages</label>
                <input type="number" min={0} value={skipFirstN} onChange={(e) => setSkipFirstN(Math.max(0, Number(e.target.value)))}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>Font size</span><span>{fontSize}pt</span>
                </label>
                <input type="range" min={6} max={24} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full accent-[var(--color-primary)]" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Color</label>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-full cursor-pointer rounded-xl border border-[var(--color-border)]" />
              </div>
            </div>
          </div>
        </div>
      )}

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || 'Adding page numbers…'} />}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleApply}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Add Page Numbers
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download PDF" />}
        </div>
      )}

      {status === 'done' && result && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Page numbers added!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
