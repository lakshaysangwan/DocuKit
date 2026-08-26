import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import BeforeAfterSlider from '@/components/islands/shared/BeforeAfterSlider';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { renderPdfPageToDataUrl } from '@/lib/pdf-preview';
import { triggerDownload } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import type { WorkerResponse, CompressPdfOptions } from '@/types/worker-messages';

type Level = 'low' | 'medium' | 'high' | 'custom';
type Status = 'idle' | 'processing' | 'done' | 'error';

const LEVELS: { value: Level; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Lossless — no quality loss' },
  { value: 'medium', label: 'Medium', description: 'Good balance' },
  { value: 'high', label: 'High', description: 'Maximum compression' },
  { value: 'custom', label: 'Custom', description: 'Fine-tune settings' },
];

export default function CompressPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [level, setLevel] = useState<Level>('medium');
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(75);
  const [grayscale, setGrayscale] = useState(false);
  const [stripFonts, setStripFonts] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [beforePreview, setBeforePreview] = useState<string | null>(null);
  const [afterPreview, setAfterPreview] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();

  // Render a page-1 before/after comparison once compression completes so the
  // visual effect of compression is inspectable, not just a size number.
  useEffect(() => {
    let cancelled = false;
    if (status !== 'done' || !result || !buffer) { setBeforePreview(null); setAfterPreview(null); return; }
    (async () => {
      try {
        const [before, after] = await Promise.all([
          renderPdfPageToDataUrl(buffer, 0),
          renderPdfPageToDataUrl(result, 0),
        ]);
        if (!cancelled) { setBeforePreview(before); setAfterPreview(after); }
      } catch {
        if (!cancelled) { setBeforePreview(null); setAfterPreview(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [status, result, buffer]);

  const handleFiles = useCallback(async (newFiles: File[]) => {
    const f = newFiles[0];
    if (!f) return;
    setFile(f);
    setStatus('idle');
    setResult(null);
    setErrorMsg(null);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
    } catch {
      setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.');
    }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null);
  }, []);

  const handleCompress = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }

    setStatus('processing');
    setErrorMsg(null);
    setResult(null);

    const options: CompressPdfOptions = {
      level,
      dpi: level === 'custom' ? dpi : level === 'low' ? 300 : level === 'medium' ? 150 : 72,
      jpegQuality: level === 'custom' ? jpegQuality : level === 'low' ? 90 : level === 'medium' ? 75 : 50,
      grayscale: level === 'custom' ? grayscale : false,
      stripFonts: level === 'custom' ? stripFonts : false,
    };

    try {
      const { port1, port2 } = new MessageChannel();
      const bufCopy = buffer.slice(0);

      const response: WorkerResponse | null = await run(
        'pdf',
        { op: 'compress-pdf', buffer: bufCopy, options, progressPort: port2 },
        [bufCopy, port2]
      );

      port1.close();

      if (!response) { setStatus('idle'); return; }
      if (response.status === 'error') {
        setStatus('error');
        setErrorMsg(response.message || 'Compression failed');
        toast.error(response.message || 'Compression failed');
        return;
      }

      if (response.status === 'success') {
        setResult(response.result);
        setStatus('done');
        toast.success('PDF compressed successfully!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Compression failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [buffer, file, level, dpi, jpegQuality, grayscale, stripFonts, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    const baseName = file.name.replace(/\.pdf$/i, '');
    triggerDownload(result, `${baseName}-compressed.pdf`, 'application/pdf');
  }, [result, file]);

  const savedPct = file && result
    ? Math.round(((file.size - result.byteLength) / file.size) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <DropZone
        accept={['application/pdf']}
        multiple={false}
        onFiles={handleFiles}
        hint="Single PDF file"
      />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {file && (
        <div className="flex flex-col gap-5">

          {/* Level selector */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
              Compression level
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  onClick={() => setLevel(l.value)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    level === l.value
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50'
                  )}
                >
                  <p className={cn('text-sm font-medium', level === l.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]')}>
                    {l.label}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{l.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Custom options */}
          {level === 'custom' && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <p className="mb-4 text-sm font-medium text-[var(--color-text-primary)]">Custom settings</p>
              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="cp-dpi" className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                    <span>Image DPI</span>
                    <span className="font-medium tabular-nums">{dpi}</span>
                  </label>
                  <input id="cp-dpi" type="range" min={36} max={300} value={dpi}
                    onChange={(e) => setDpi(Number(e.target.value))}
                    className="w-full accent-[var(--color-primary)]" />
                </div>
                <div>
                  <label htmlFor="cp-jpeg-quality" className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                    <span>JPEG Quality</span>
                    <span className="font-medium tabular-nums">{jpegQuality}%</span>
                  </label>
                  <input id="cp-jpeg-quality" type="range" min={1} max={100} value={jpegQuality}
                    onChange={(e) => setJpegQuality(Number(e.target.value))}
                    className="w-full accent-[var(--color-primary)]" />
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={grayscale} onChange={(e) => setGrayscale(e.target.checked)}
                    className="accent-[var(--color-primary)]" />
                  Convert to grayscale
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={stripFonts} onChange={(e) => setStripFonts(e.target.checked)}
                    className="accent-[var(--color-primary)]" />
                  Strip embedded fonts
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Processing */}
      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Compressing PDF…'}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={handleCompress}
            disabled={!file}
            data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 disabled:opacity-50 sm:w-auto"
          >
            Compress PDF
          </button>

          {status === 'done' && result && (
            <DownloadButton onClick={handleDownload} label="Download Compressed PDF" />
          )}
        </div>
      )}

      {/* Result stats */}
      {status === 'done' && result && file && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">
            {savedPct > 0 ? `Reduced by ${savedPct}%` : 'Compression complete'}
          </p>
          <div className="mt-2 flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
            <span>Before: {formatBytes(file.size)}</span>
            <span>→</span>
            <span>After: {formatBytes(result.byteLength)}</span>
          </div>

          {beforePreview && afterPreview && (
            <div className="mt-4" data-testid="compress-preview">
              <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
                Drag to compare page 1 — original vs compressed
              </p>
              <BeforeAfterSlider
                beforeSrc={beforePreview}
                afterSrc={afterPreview}
                beforeLabel="Original"
                afterLabel="Compressed"
                className="aspect-[3/4] w-full max-w-sm border border-[var(--color-border)]"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
