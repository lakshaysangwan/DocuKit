import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import BeforeAfterSlider from '@/components/islands/shared/BeforeAfterSlider';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { useWorker } from '@/hooks/use-worker';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { createZipAndDownload } from '@/lib/download';
import { formatBytes, generateId, cn } from '@/lib/utils';
import type { WorkerResponse, CompressImageOptions } from '@/types/worker-messages';

type OutputFormat = 'original' | 'jpeg' | 'webp' | 'png' | 'avif';
type Mode = 'quality' | 'target-size';
type Status = 'idle' | 'processing' | 'done' | 'error';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];

const outMimeFor = (f: OutputFormat) =>
  f === 'jpeg' ? 'image/jpeg' : f === 'png' ? 'image/png' : f === 'avif' ? 'image/avif' : 'image/webp';
const extFor = (mime: string) =>
  mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'image/avif' ? 'avif' : 'jpg';

export default function CompressImageTool() {
  // Single-file state (rich preview + before/after). Used when exactly one file.
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // Batch state (2+ files → ZIP). Kept separate so the single-file UX is unchanged.
  const [batch, setBatch] = useState<FileItem[]>([]);
  const [batchResults, setBatchResults] = useState<{ name: string; blob: Blob }[]>([]);
  const [batchPct, setBatchPct] = useState(0);

  const [outputFormat, setOutputFormat] = useState<OutputFormat>('original');
  const [mode, setMode] = useState<Mode>('quality');
  const [quality, setQuality] = useState(75);
  const [targetKb, setTargetKb] = useState(200);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { isRunning, progress, progressLabel, run, cancel } = useWorker();
  const isBatch = batch.length > 0;

  const resetSingle = () => {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(null); setBuffer(null); setOriginalUrl(null); setResultBlob(null); setResultUrl(null);
  };

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setStatus('idle'); setErrorMsg(null); setBatchResults([]);

    if (files.length > 1) {
      // Batch mode.
      resetSingle();
      setBatch(files.map((f) => ({ id: generateId(), file: f })));
      return;
    }

    // Single-file mode.
    setBatch([]);
    const f = files[0];
    resetSingle();
    setFile(f);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      setOriginalUrl(URL.createObjectURL(new Blob([buf], { type: f.type })));
    } catch { toast.error('Failed to read image'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalUrl, resultUrl]);

  const handleRemoveFile = useCallback(() => {
    resetSingle(); setStatus('idle'); setErrorMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalUrl, resultUrl]);

  const optionsFor = (): CompressImageOptions => ({
    format: outputFormat,
    mode,
    quality,
    targetBytes: mode === 'target-size' ? targetKb * 1024 : undefined,
  });

  /** Compress one buffer through the worker; returns the output blob. */
  const compressOne = useCallback(async (buf: ArrayBuffer): Promise<Blob | null> => {
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buf.slice(0);
    const response: WorkerResponse | null = await run(
      'image',
      { op: 'compress-image', buffer: bufCopy, options: optionsFor(), progressPort: port2 },
      [bufCopy, port2]
    );
    port1.close();
    if (!response || response.status !== 'success' || !response.result) {
      if (response?.status === 'error') throw new Error(response.message);
      return null;
    }
    return new Blob([response.result], { type: outMimeFor(outputFormat) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, outputFormat, mode, quality, targetKb]);

  const handleCompress = useCallback(async () => {
    setErrorMsg(null);
    try {
      if (isBatch) {
        setStatus('processing'); setBatchPct(0);
        const out: { name: string; blob: Blob }[] = [];
        for (let i = 0; i < batch.length; i++) {
          setBatchPct(Math.round(((i + 1) / batch.length) * 100));
          const buf = await fileToArrayBuffer(batch[i].file);
          const blob = await compressOne(buf);
          if (blob) {
            const base = batch[i].file.name.replace(/\.[^.]+$/, '');
            out.push({ name: `${base}-compressed.${extFor(blob.type)}`, blob });
          }
        }
        setBatchResults(out);
        setStatus('done');
        toast.success(`Compressed ${out.length} image${out.length !== 1 ? 's' : ''}`);
        return;
      }

      if (!buffer || !file) { toast.error('Upload an image first'); return; }
      setStatus('processing');
      const blob = await compressOne(buffer);
      if (!blob) { setStatus('idle'); return; }
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      setResultBlob(blob);
      setResultUrl(URL.createObjectURL(blob));
      setStatus('done');
      const savedPct = Math.round(((file.size - blob.size) / file.size) * 100);
      toast[savedPct > 0 ? 'success' : 'info'](savedPct > 0 ? `Compressed! Reduced by ${savedPct}%` : 'Image is already well-optimized. Original returned.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Compression failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [isBatch, batch, buffer, file, resultUrl, compressOne]);

  const handleDownload = useCallback(async () => {
    if (isBatch) {
      if (batchResults.length === 0) return;
      const fileList = await Promise.all(batchResults.map(async (r) => ({ name: r.name, buffer: await r.blob.arrayBuffer() })));
      await createZipAndDownload(fileList, 'compressed-images.zip');
      return;
    }
    if (!resultBlob || !file) return;
    const name = file.name.replace(/\.[^.]+$/, '') + '-compressed.' + extFor(resultBlob.type);
    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [isBatch, batchResults, resultBlob, file]);

  const savedPct = file && resultBlob ? Math.round(((file.size - resultBlob.size) / file.size) * 100) : 0;

  // Shared options panel (format + mode + quality/target).
  const optionsPanel = (
    <div className="flex flex-col gap-5">
      <div>
        <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Output Format</label>
        <div className="flex flex-wrap gap-2">
          {(['original', 'jpeg', 'webp', 'avif', 'png'] as OutputFormat[]).map((f) => (
            <button key={f} onClick={() => {
              setOutputFormat(f);
              if (f === 'png') toast.info('PNG is lossless — file size may increase. Use JPEG/WebP/AVIF for smaller files.');
            }}
              className={cn('rounded-lg border px-4 py-2 text-sm font-medium uppercase transition-colors',
                outputFormat === f ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
              )}>
              {f === 'original' ? 'Best (WebP)' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Compression Mode</label>
        <div className="flex gap-2">
          {([['quality', 'By Quality'], ['target-size', 'Target Size']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setMode(v)}
              className={cn('rounded-lg border px-4 py-2 text-sm transition-colors',
                mode === v ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
              )}>
              {l}
            </button>
          ))}
        </div>
        {mode === 'quality' ? (
          <div className="mt-3">
            <label htmlFor="ci-quality" className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
              <span>Quality</span><span className="tabular-nums">{quality}%</span>
            </label>
            <input id="ci-quality" type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]" />
          </div>
        ) : (
          <div className="mt-3">
            <label htmlFor="ci-target-kb" className="mb-1 block text-xs text-[var(--color-text-secondary)]">Target Size (KB)</label>
            <input id="ci-target-kb" type="number" min={1} value={targetKb} onChange={(e) => setTargetKb(Math.max(1, Number(e.target.value)))}
              className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none" />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={ACCEPTED} multiple onFiles={handleFiles}
        hint="JPEG, PNG, WebP, AVIF, HEIC · single or batch" compact={isBatch || !!file} />

      {/* Batch view */}
      {isBatch && (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">
              {batch.length} images · {formatBytes(batch.reduce((s, f) => s + f.file.size, 0))}
            </span>
            <button onClick={() => { setBatch([]); setBatchResults([]); setStatus('idle'); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]">Clear all</button>
          </div>
          <FileList files={batch}
            onReorder={(fromId, toId) => setBatch((prev) => {
              const fi = prev.findIndex((x) => x.id === fromId); const ti = prev.findIndex((x) => x.id === toId);
              if (fi === -1 || ti === -1) return prev;
              const next = [...prev]; const [m] = next.splice(fi, 1); next.splice(ti, 0, m); return next;
            })}
            onRemove={(id) => setBatch((prev) => prev.filter((x) => x.id !== id))}
            variant="cards" />
          {optionsPanel}
        </>
      )}

      {/* Single-file view */}
      {!isBatch && file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {!isBatch && file && originalUrl && (
        <>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <img src={originalUrl} alt={file.name} className="mx-auto max-h-64 object-contain" />
          </div>
          {optionsPanel}
        </>
      )}

      {isRunning || status === 'processing' ? (
        <ProcessingOverlay
          progress={isBatch ? batchPct : progress}
          label={progressLabel || (isBatch ? 'Compressing images…' : 'Compressing image…')}
          onCancel={() => { cancel(); setStatus('idle'); }}
        />
      ) : null}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {/* Single-file before/after comparison */}
      {!isBatch && status === 'done' && originalUrl && resultUrl && (
        <BeforeAfterSlider
          beforeSrc={originalUrl}
          afterSrc={resultUrl}
          beforeLabel={`Original (${formatBytes(file?.size ?? 0)})`}
          afterLabel={`Compressed (${formatBytes(resultBlob?.size ?? 0)})`}
          className="aspect-video"
        />
      )}

      {status !== 'processing' && !isRunning && (isBatch || file) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleCompress} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 sm:w-auto">
            {isBatch ? `Compress ${batch.length} images` : 'Compress Image'}
          </button>
          {status === 'done' && (isBatch ? batchResults.length > 0 : resultBlob) && (
            <DownloadButton onClick={handleDownload}
              label={isBatch ? `Download ZIP (${batchResults.length} files)` : 'Download'} />
          )}
        </div>
      )}

      {!isBatch && status === 'done' && resultBlob && file && (
        <div className={`rounded-lg border p-4 ${savedPct > 0 ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5' : 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5'}`}>
          <p className={`text-sm font-medium ${savedPct > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`}>
            {savedPct > 0 ? `Reduced by ${savedPct}%!` : 'No size reduction — original returned'}
          </p>
          <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
            <span>{formatBytes(file.size)}</span><span>→</span><span>{formatBytes(resultBlob.size)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
