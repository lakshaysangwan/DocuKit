import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import BeforeAfterSlider from '@/components/islands/shared/BeforeAfterSlider';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { WorkerResponse, CompressImageOptions } from '@/types/worker-messages';

type OutputFormat = 'original' | 'jpeg' | 'webp' | 'png';
type Mode = 'quality' | 'target-size';
type Status = 'idle' | 'processing' | 'done' | 'error';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];

export default function CompressImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('original');
  const [mode, setMode] = useState<Mode>('quality');
  const [quality, setQuality] = useState(75);
  const [targetKb, setTargetKb] = useState(200);
  const [status, setStatus] = useState<Status>('idle');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResultBlob(null);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      setOriginalUrl(URL.createObjectURL(new Blob([buf], { type: f.type })));
    } catch { toast.error('Failed to read image'); }
  }, [originalUrl, resultUrl]);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResultBlob(null); setErrorMsg(null);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setOriginalUrl(null); setResultUrl(null);
  }, [originalUrl, resultUrl]);

  const handleCompress = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload an image first'); return; }
    setStatus('processing');
    setErrorMsg(null);

    try {
      const { port1, port2 } = new MessageChannel();
      const bufCopy = buffer.slice(0);

      const options: CompressImageOptions = {
        format: outputFormat,
        mode: mode,
        quality: quality,
        targetBytes: mode === 'target-size' ? targetKb * 1024 : undefined,
      };

      const response: WorkerResponse | null = await run(
        'image',
        { op: 'compress-image', buffer: bufCopy, options, progressPort: port2 },
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

      if (response.status === 'success' && response.result) {
        // Determine output MIME type for the blob
        const outMime = outputFormat === 'jpeg' ? 'image/jpeg'
          : outputFormat === 'png' ? 'image/png'
          : 'image/webp'; // 'original' and 'webp' both use WebP via WASM

        const blob = new Blob([response.result], { type: outMime });

        if (resultUrl) URL.revokeObjectURL(resultUrl);
        const url = URL.createObjectURL(blob);
        setResultBlob(blob);
        setResultUrl(url);
        setStatus('done');

        const savedPct = Math.round(((file.size - blob.size) / file.size) * 100);
        if (savedPct > 0) {
          toast.success(`Compressed! Reduced by ${savedPct}%`);
        } else {
          toast.info('Image is already well-optimized. Original returned.');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Compression failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [buffer, file, outputFormat, mode, quality, targetKb, resultUrl, run]);

  const handleDownload = useCallback(async () => {
    if (!resultBlob || !file) return;
    const ext = resultBlob.type === 'image/webp' ? 'webp'
      : resultBlob.type === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + '-compressed.' + ext;
    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [resultBlob, file]);

  const savedPct = file && resultBlob
    ? Math.round(((file.size - resultBlob.size) / file.size) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={ACCEPTED} multiple={false} onFiles={handleFiles} hint="JPEG, PNG, WebP, GIF, BMP" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {file && originalUrl && (
        <div className="flex flex-col gap-5">
          {/* Image preview */}
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
            <img src={originalUrl} alt={file.name} className="mx-auto max-h-64 object-contain" />
          </div>
          {/* Format */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Output Format</label>
            <div className="flex flex-wrap gap-2">
              {(['original', 'jpeg', 'webp', 'png'] as OutputFormat[]).map((f) => (
                <button key={f} onClick={() => {
                  setOutputFormat(f);
                  if (f === 'png') toast.info('PNG is lossless — file size may increase. Use JPEG or WebP for smaller files.');
                }}
                  className={cn('rounded-xl border px-4 py-2 text-sm font-medium uppercase transition-colors',
                    outputFormat === f ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>
                  {f === 'original' ? 'Best (WebP)' : f.toUpperCase()}
                </button>
              ))}
            </div>
            {outputFormat === 'png' && (
              <p className="mt-1.5 text-xs text-[var(--color-warning)]">PNG is lossless — quality slider has no effect. File size may be larger than the original.</p>
            )}
            {outputFormat === 'original' && (
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">Uses WebP encoding (mozjpeg-level quality) for best compression ratio.</p>
            )}
          </div>

          {/* Mode */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Compression Mode</label>
            <div className="flex gap-2">
              {([['quality', 'By Quality'], ['target-size', 'Target Size']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setMode(v)}
                  className={cn('rounded-xl border px-4 py-2 text-sm transition-colors',
                    mode === v ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>
                  {l}
                </button>
              ))}
            </div>

            {mode === 'quality' ? (
              <div className="mt-3">
                <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>Quality</span><span className="tabular-nums">{quality}%</span>
                </label>
                <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-[var(--color-primary)]" />
              </div>
            ) : (
              <div className="mt-3">
                <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Target Size (KB)</label>
                <input type="number" min={1} value={targetKb} onChange={(e) => setTargetKb(Math.max(1, Number(e.target.value)))}
                  className="w-32 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
              </div>
            )}
          </div>
        </div>
      )}

      {isRunning && (
        <ProcessingOverlay
          progress={progress}
          label={progressLabel || 'Compressing image…'}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      )}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {/* Before/After comparison */}
      {status === 'done' && originalUrl && resultUrl && (
        <BeforeAfterSlider
          beforeSrc={originalUrl}
          afterSrc={resultUrl}
          beforeLabel={`Original (${formatBytes(file?.size ?? 0)})`}
          afterLabel={`Compressed (${formatBytes(resultBlob?.size ?? 0)})`}
          className="aspect-video"
        />
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleCompress}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Compress Image
          </button>
          {status === 'done' && resultBlob && <DownloadButton onClick={handleDownload} label="Download" />}
        </div>
      )}

      {status === 'done' && resultBlob && file && (
        <div className={`rounded-xl border p-4 ${savedPct > 0 ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5' : 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5'}`}>
          <p className={`text-sm font-medium ${savedPct > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`}>
            {savedPct > 0 ? `Reduced by ${savedPct}%!` : 'No size reduction — original returned'}
          </p>
          <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
            <span>{formatBytes(file.size)}</span>
            <span>→</span>
            <span>{formatBytes(resultBlob.size)}</span>
          </div>
        </div>
      )}

      {status === 'done' && resultBlob && (savedPct <= 0 || (mode === 'target-size' && resultBlob.size > targetKb * 1024)) && (
        <div className="rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-3 text-sm text-[var(--color-text-secondary)]">
          Still too large? Reducing dimensions with{' '}
          <a href="/resize-image" className="font-medium text-[var(--color-primary)] underline hover:no-underline">Resize Image</a>
          {' '}can cut file size significantly.
        </div>
      )}
    </div>
  );
}
