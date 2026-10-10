import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import BeforeAfterSlider from '@/components/islands/shared/BeforeAfterSlider';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { notifyPdfLoadError } from '@/lib/notify';
import { renderPdfPageToDataUrl } from '@/lib/pdf-preview';
import { triggerDownload } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import type { WorkerResponse, CompressPdfOptions } from '@/types/worker-messages';

type Level = 'low' | 'medium' | 'high' | 'custom' | 'target';
type Status = 'idle' | 'processing' | 'done' | 'error';
type SizeUnit = 'KB' | 'MB';

const UNIT_BYTES: Record<SizeUnit, number> = { KB: 1024, MB: 1024 * 1024 };
/** Size limits people are commonly asked to meet by upload forms and email. */
const TARGET_PRESETS_KB = [100, 200, 500, 1024, 2048];
const formatTargetKb = (kb: number) => (kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`);

const LEVELS: { value: Level; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Lossless — no quality loss' },
  { value: 'medium', label: 'Medium', description: 'Good balance' },
  { value: 'high', label: 'High', description: 'Maximum compression' },
  { value: 'custom', label: 'Custom', description: 'Fine-tune settings' },
  { value: 'target', label: 'Target size', description: 'Fit under a size limit' },
];

interface CompressPdfToolProps {
  /** Start in Target size mode at this many KB — set by the size-specific landing pages. */
  initialTargetKb?: number;
}

export default function CompressPdfTool({ initialTargetKb }: CompressPdfToolProps) {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [level, setLevel] = useState<Level>(initialTargetKb ? 'target' : 'medium');
  // The target is held as the number and unit the user sees, not as bytes, so
  // "2 MB" round-trips through the field instead of becoming "2048 KB".
  const [targetValue, setTargetValue] = useState(
    initialTargetKb && initialTargetKb >= 1024 ? initialTargetKb / 1024 : initialTargetKb ?? 200,
  );
  const [targetUnit, setTargetUnit] = useState<SizeUnit>(initialTargetKb && initialTargetKb >= 1024 ? 'MB' : 'KB');
  const targetBytes = Math.round(targetValue * UNIT_BYTES[targetUnit]);
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(75);
  const [grayscale, setGrayscale] = useState(false);
  const [stripFonts, setStripFonts] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<ArrayBuffer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // The target the current result was compressed for (null in the other modes),
  // kept with the result so editing the field afterwards cannot re-judge it.
  const [resultTargetBytes, setResultTargetBytes] = useState<number | null>(null);
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
      setFile(null); setBuffer(null); notifyPdfLoadError();
    }
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResult(null); setErrorMsg(null); setResultTargetBytes(null);
  }, []);

  const handleCompress = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }

    setStatus('processing');
    setErrorMsg(null);
    setResult(null);

    if (level === 'target' && !(targetBytes > 0)) { toast.error('Enter a target size'); return; }

    const options: CompressPdfOptions = level === 'target'
      ? { level: 'custom', targetBytes }
      : {
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
        setResultTargetBytes(level === 'target' ? targetBytes : null);
        setStatus('done');
        if (level === 'target' && response.result.byteLength > targetBytes) {
          toast.warning('Could not reach the target size — this is the smallest result');
        } else {
          toast.success('PDF compressed successfully!');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Compression failed';
      setStatus('error');
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, [buffer, file, level, dpi, jpegQuality, grayscale, stripFonts, targetBytes, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    const baseName = file.name.replace(/\.pdf$/i, '');
    triggerDownload(result, `${baseName}-compressed.pdf`, 'application/pdf');
  }, [result, file]);

  const missedTarget = !!result && resultTargetBytes !== null && result.byteLength > resultTargetBytes;

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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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

          {/* Target size */}
          {level === 'target' && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <label htmlFor="cp-target-size" className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
                Make the PDF no larger than
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input id="cp-target-size" type="number" min={1} step="any" value={targetValue}
                  onChange={(e) => setTargetValue(Math.max(0, Number(e.target.value)))}
                  className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
                <select aria-label="Size unit" value={targetUnit} onChange={(e) => setTargetUnit(e.target.value as SizeUnit)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none">
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                </select>
                <div className="flex flex-wrap gap-1.5">
                  {TARGET_PRESETS_KB.map((kb) => (
                    <button key={kb} type="button"
                      onClick={() => { setTargetValue(kb >= 1024 ? kb / 1024 : kb); setTargetUnit(kb >= 1024 ? 'MB' : 'KB'); }}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs transition-colors',
                        targetBytes === kb * 1024
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/50'
                      )}>
                      {formatTargetKb(kb)}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Images are compressed only as much as needed to fit. Text stays sharp — it is never converted to an image.
              </p>
            </div>
          )}

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

      {/* Target missed: say so plainly rather than report success */}
      {status === 'done' && result && missedTarget && resultTargetBytes !== null && (
        <div role="status" data-testid="target-missed"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-primary)]">
          <p className="font-medium">
            This PDF could not be brought under {formatBytes(resultTargetBytes)} — the smallest it gets is {formatBytes(result.byteLength)}.
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Only images can be compressed further. What remains is mostly text, fonts or vector graphics, which are already compact.
            Splitting the document into parts is the reliable way under a strict limit.
          </p>
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
