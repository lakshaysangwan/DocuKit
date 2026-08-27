import { useState, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import NextStep from '@/components/islands/shared/NextStep';
import { createZipAndDownload } from '@/lib/download';
import { formatMime } from '@/lib/image-codec';
import { useWorker } from '@/hooks/use-worker';
import { formatBytes, generateId, cn } from '@/lib/utils';

type TargetFormat = 'jpeg' | 'png' | 'webp' | 'avif';
type Status = 'idle' | 'processing' | 'done' | 'error';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];

/**
 * Convert one image through the image worker, so decode + encode stay off the
 * main thread (jSquash/libheif are heavy enough to jank the UI on a big file).
 * Falls back to running inline automatically on browsers without OffscreenCanvas
 * — see worker-pool's CANVAS_OPS.
 */
async function convertSingleImage(
  run: ReturnType<typeof useWorker>['run'],
  file: File,
  targetFormat: TargetFormat,
  quality: number,
): Promise<Blob> {
  const buf = await file.arrayBuffer();
  const { port1, port2 } = new MessageChannel();
  const response = await run(
    'image',
    { op: 'convert-image', buffer: buf, mimeType: file.type, options: { format: targetFormat, quality }, progressPort: port2 },
    [buf, port2],
  );
  port1.close();
  if (!response || response.status !== 'success' || !response.result) {
    throw new Error(response?.status === 'error' ? response.message : 'Conversion failed');
  }
  return new Blob([response.result], { type: formatMime(targetFormat) });
}

export default function ConvertImageTool() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<TargetFormat>('webp');
  const { run } = useWorker();
  const [quality, setQuality] = useState(85);
  const [convProgress, setConvProgress] = useState(0);
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<{ name: string; blob: Blob }[]>([]);

  const handleFiles = useCallback((newFiles: File[]) => {
    const items: FileItem[] = newFiles.map((f) => ({
      id: generateId(),
      file: f,
      thumbnailUrl: URL.createObjectURL(f),
    }));
    setFiles((prev) => [...prev, ...items]);
    setStatus('idle'); setResults([]);
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
    setStatus('processing'); setConvProgress(0); setResults([]);
    const out: { name: string; blob: Blob }[] = [];
    for (let i = 0; i < files.length; i++) {
      setConvProgress(Math.round(((i + 1) / files.length) * 100));
      try {
        const blob = await convertSingleImage(run, files[i].file, targetFormat, quality);
        const base = files[i].file.name.replace(/\.[^.]+$/, '');
        out.push({ name: `${base}.${targetFormat === 'jpeg' ? 'jpg' : targetFormat}`, blob });
      } catch { toast.error(`Failed to convert ${files[i].file.name}`); }
    }
    setResults(out); setStatus('done');
    toast.success(`Converted ${out.length} image${out.length !== 1 ? 's' : ''}`);
  }, [run, files, targetFormat, quality]);

  const handleDownload = useCallback(async () => {
    if (results.length === 0) return;
    if (results.length === 1) {
      const url = URL.createObjectURL(results[0].blob);
      const a = document.createElement('a');
      a.href = url; a.download = results[0].name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const fileList = await Promise.all(results.map(async (r) => ({ name: r.name, buffer: await r.blob.arrayBuffer() })));
      await createZipAndDownload(fileList, 'converted-images.zip');
    }
  }, [results]);

  const totalSize = files.reduce((s, f) => s + f.file.size, 0);

  return (
    <div className="flex flex-col gap-5">
      <DropZone
        accept={ACCEPTED}
        multiple
        onFiles={handleFiles}
        hint="JPEG, PNG, WebP, GIF, BMP · Batch conversion"
        compact={files.length > 0}
      />

      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">
              {files.length} image{files.length !== 1 ? 's' : ''} · {formatBytes(totalSize)}
            </span>
            <button
              onClick={() => { files.forEach(f => f.thumbnailUrl && URL.revokeObjectURL(f.thumbnailUrl)); setFiles([]); setResults([]); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
            >
              Clear all
            </button>
          </div>
          <FileList files={files} onReorder={handleReorder} onRemove={handleRemove} variant="cards" />
        </div>
      )}

      {/* Format + quality */}
      {files.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Convert to</label>
              <div className="flex gap-2">
                {(['jpeg', 'png', 'webp', 'avif'] as TargetFormat[]).map((f) => (
                  <button key={f} onClick={() => setTargetFormat(f)}
                    className={cn('rounded-lg border px-4 py-2 text-sm font-medium uppercase transition-colors',
                      targetFormat === f ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                    )}>
                    {f === 'jpeg' ? 'JPG' : f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {targetFormat !== 'png' && (
              <div>
                <label htmlFor="cv-quality" className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>Quality</span><span className="tabular-nums">{quality}%</span>
                </label>
                <input id="cv-quality" type="range" min={1} max={100} value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-[var(--color-primary)]" />
              </div>
            )}
          </div>
        </div>
      )}

      {status === 'processing' && <ProcessingOverlay progress={convProgress} label="Converting images…" />}

      {status !== 'processing' && files.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleConvert} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 sm:w-auto">
            Convert {files.length} image{files.length !== 1 ? 's' : ''} to {targetFormat === 'jpeg' ? 'JPG' : targetFormat.toUpperCase()}
          </button>
          {status === 'done' && results.length > 0 && (
            <DownloadButton onClick={handleDownload}
              label={results.length === 1 ? 'Download' : `Download ZIP (${results.length} files)`} />
          )}
        </div>
      )}

      {status === 'done' && results.length > 0 && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">{results.length} image{results.length !== 1 ? 's' : ''} converted!</p>
        </div>
      )}
      {status === 'done' && results.length > 0 && (
        <NextStep href="/compress-image" label="Compress Image">Want a smaller file?</NextStep>
      )}
    </div>
  );
}
