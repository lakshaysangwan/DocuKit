import { useState, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { createZipAndDownload } from '@/lib/download';
import { generateId, cn } from '@/lib/utils';

type TargetFormat = 'jpeg' | 'png' | 'webp';
type Status = 'idle' | 'processing' | 'done' | 'error';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
const MIME: Record<TargetFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

async function convertSingleImage(file: File, targetFormat: TargetFormat, quality: number): Promise<Blob> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      if (targetFormat !== 'png') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const mime = MIME[targetFormat];
      const q = mime === 'image/png' ? undefined : quality / 100;
      canvas.toBlob((b) => { if (b) resolve(b); else reject(new Error('Export failed')); }, mime, q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Failed to load ${file.name}`)); };
    img.src = url;
  });
}

export default function ConvertImageTool() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<TargetFormat>('webp');
  const [quality, setQuality] = useState(85);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<{ name: string; blob: Blob }[]>([]);
  const [errorMsg] = useState<string | null>(null);

  const handleFiles = useCallback((newFiles: File[]) => {
    const items: FileItem[] = newFiles.map((f) => ({ id: generateId(), file: f }));
    setFiles((prev) => [...prev, ...items]);
    setStatus('idle'); setResults([]);
  }, []);

  const handleConvert = useCallback(async () => {
    if (files.length === 0) { toast.error('Add at least one image'); return; }
    setStatus('processing'); setProgress(0); setResults([]);

    const out: { name: string; blob: Blob }[] = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(Math.round(((i + 1) / files.length) * 100));
      try {
        const blob = await convertSingleImage(files[i].file, targetFormat, quality);
        const base = files[i].file.name.replace(/\.[^.]+$/, '');
        out.push({ name: `${base}.${targetFormat === 'jpeg' ? 'jpg' : targetFormat}`, blob });
      } catch {
        toast.error(`Failed to convert ${files[i].file.name}`);
      }
    }

    setResults(out);
    setStatus('done');
    toast.success(`Converted ${out.length} image${out.length !== 1 ? 's' : ''}`);
  }, [files, targetFormat, quality]);

  const handleDownload = useCallback(async () => {
    if (results.length === 0) return;
    if (results.length === 1) {
      const url = URL.createObjectURL(results[0].blob);
      const a = document.createElement('a');
      a.href = url; a.download = results[0].name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const fileList = await Promise.all(results.map(async (r) => ({
        name: r.name,
        buffer: await r.blob.arrayBuffer(),
      })));
      await createZipAndDownload(fileList, 'converted-images.zip');
    }
  }, [results]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={ACCEPTED} multiple onFiles={handleFiles}
        hint="JPEG, PNG, WebP, GIF, BMP · Batch conversion" />

      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-[var(--color-text-secondary)]">
            <span>{files.length} image{files.length !== 1 ? 's' : ''}</span>
            <button onClick={() => { setFiles([]); setResults([]); }}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)]">Clear</button>
          </div>
          <FileList files={files}
            onReorder={(fid, tid) => setFiles((p) => { const fi = p.findIndex(f => f.id === fid); const ti = p.findIndex(f => f.id === tid); return fi !== -1 && ti !== -1 ? arrayMove(p, fi, ti) : p; })}
            onRemove={(id) => setFiles((p) => p.filter((f) => f.id !== id))} />
        </div>
      )}

      {files.length > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Convert to</label>
              <div className="flex gap-2">
                {(['jpeg', 'png', 'webp'] as TargetFormat[]).map((f) => (
                  <button key={f} onClick={() => setTargetFormat(f)}
                    className={cn('rounded-xl border px-4 py-2 text-sm font-medium uppercase transition-colors',
                      targetFormat === f ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                    )}>
                    {f === 'jpeg' ? 'JPG' : f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {targetFormat !== 'png' && (
              <div>
                <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>Quality</span><span className="tabular-nums">{quality}%</span>
                </label>
                <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-[var(--color-primary)]" />
              </div>
            )}
          </div>
        </div>
      )}

      {status === 'processing' && <ProcessingOverlay progress={progress} label="Converting images…" />}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {status !== 'processing' && files.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleConvert}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Convert {files.length} image{files.length !== 1 ? 's' : ''} to {targetFormat.toUpperCase()}
          </button>
          {status === 'done' && results.length > 0 && (
            <DownloadButton onClick={handleDownload}
              label={results.length === 1 ? 'Download' : `Download ZIP (${results.length} files)`} />
          )}
        </div>
      )}

      {status === 'done' && results.length > 0 && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">{results.length} image{results.length !== 1 ? 's' : ''} converted!</p>
        </div>
      )}

      {status === 'done' && results.length > 0 && (
        <div className="rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-3 text-sm text-[var(--color-text-secondary)]">
          Want a smaller file? Try{' '}
          <a href="/compress-image" className="font-medium text-[var(--color-primary)] underline hover:no-underline">Compress Image</a>.
        </div>
      )}
    </div>
  );
}
