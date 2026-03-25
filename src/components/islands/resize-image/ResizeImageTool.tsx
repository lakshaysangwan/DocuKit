import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';

type FitMode = 'fit' | 'fill' | 'stretch';
type Status = 'idle' | 'processing' | 'done' | 'error';

const SOCIAL_PRESETS = [
  { label: 'Instagram Post (1:1)', w: 1080, h: 1080 },
  { label: 'Instagram Story', w: 1080, h: 1920 },
  { label: 'Instagram Landscape', w: 1080, h: 566 },
  { label: 'Twitter/X Post', w: 1200, h: 675 },
  { label: 'Twitter/X Header', w: 1500, h: 500 },
  { label: 'LinkedIn Banner', w: 1584, h: 396 },
  { label: 'LinkedIn Post', w: 1200, h: 627 },
  { label: 'YouTube Thumbnail', w: 1280, h: 720 },
  { label: 'Facebook Cover', w: 851, h: 315 },
];

export default function ResizeImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [origW, setOrigW] = useState(0);
  const [origH, setOrigH] = useState(0);
  const [targetW, setTargetW] = useState(0);
  const [targetH, setTargetH] = useState(0);
  const [lockAspect, setLockAspect] = useState(true);
  const [mode, setMode] = useState<FitMode>('fit');
  const [status, setStatus] = useState<Status>('idle');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResultBlob(null);
    const buf = await fileToArrayBuffer(f).catch(() => null);
    if (!buf) { toast.error('Failed to read image'); return; }
    setBuffer(buf);
    // Load to get dimensions
    const img = new Image();
    const url = URL.createObjectURL(new Blob([buf], { type: f.type }));
    img.onload = () => {
      setOrigW(img.naturalWidth); setOrigH(img.naturalHeight);
      setTargetW(img.naturalWidth); setTargetH(img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, []);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setOrigW(0); setOrigH(0); setTargetW(0); setTargetH(0);
    setStatus('idle'); setResultBlob(null); setErrorMsg(null);
  }, []);

  const updateW = (w: number) => {
    setTargetW(w);
    if (lockAspect && origW && origH) setTargetH(Math.round((w / origW) * origH));
  };
  const updateH = (h: number) => {
    setTargetH(h);
    if (lockAspect && origW && origH) setTargetW(Math.round((h / origH) * origW));
  };

  const applyPreset = (w: number, h: number) => { setTargetW(w); setTargetH(h); setLockAspect(false); };

  const handleResize = useCallback(async () => {
    if (!buffer || !file || !targetW || !targetH) { toast.error('Set target dimensions first'); return; }
    setStatus('processing');

    try {
      const blob = new Blob([buffer], { type: file.type });
      const url = URL.createObjectURL(blob);
      const img = new Image();

      const result = await new Promise<Blob>((resolve, reject) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = targetW; canvas.height = targetH;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, targetW, targetH);

          if (mode === 'stretch') {
            ctx.drawImage(img, 0, 0, targetW, targetH);
          } else if (mode === 'fit') {
            const scale = Math.min(targetW / img.naturalWidth, targetH / img.naturalHeight);
            const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
            ctx.drawImage(img, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
          } else { // fill/cover
            const scale = Math.max(targetW / img.naturalWidth, targetH / img.naturalHeight);
            const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
            ctx.drawImage(img, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
          }

          URL.revokeObjectURL(url);
          const outMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          canvas.toBlob((b) => { if (b) resolve(b); else reject(new Error('Canvas export failed')); }, outMime, 0.92);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src = url;
      });

      setResultBlob(result);
      setStatus('done');
      toast.success('Image resized!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resize failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [buffer, file, targetW, targetH, mode]);

  const handleDownload = useCallback(async () => {
    if (!resultBlob || !file) return;
    const ext = file.type === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + `-${targetW}x${targetH}.${ext}`;
    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [resultBlob, file, targetW, targetH]);

  const isUpscale = targetW > origW || targetH > origH;

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']}
        multiple={false} onFiles={handleFiles} hint="Any common image format" />

      {file && <FileInfoCard file={file} extra={origW ? `${origW} × ${origH}px` : undefined} onRemove={handleRemoveFile} />}

      {file && origW > 0 && (
        <div className="flex flex-col gap-5">

          {/* Dimensions */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Width (px)</label>
                  <input type="number" min={1} value={targetW} onChange={(e) => updateW(Number(e.target.value))}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                </div>
                <button onClick={() => setLockAspect((v) => !v)}
                  className={cn('mb-0.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                    lockAspect ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}
                  title={lockAspect ? 'Aspect locked' : 'Aspect unlocked'}>
                  {lockAspect ? '🔒' : '🔓'}
                </button>
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Height (px)</label>
                  <input type="number" min={1} value={targetH} onChange={(e) => updateH(Number(e.target.value))}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                </div>
              </div>

              {isUpscale && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
                  ⚠️ Upscaling may reduce image quality
                </div>
              )}

              {/* Fit mode */}
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--color-text-secondary)]">Fit Mode</label>
                <div className="flex gap-2">
                  {([['fit', 'Fit (letterbox)'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch']] as const).map(([v, l]) => (
                    <button key={v} onClick={() => setMode(v)}
                      className={cn('rounded-xl border px-3 py-1.5 text-xs transition-colors',
                        mode === v ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                      )}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Social presets */}
          <details className="rounded-xl border border-[var(--color-border)]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-text-primary)]">
              Social media presets
            </summary>
            <div className="grid grid-cols-1 gap-1 p-3 sm:grid-cols-2">
              {SOCIAL_PRESETS.map((p) => (
                <button key={p.label} onClick={() => applyPreset(p.w, p.h)}
                  className="rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--color-background)]">
                  <span className="font-medium text-[var(--color-text-primary)]">{p.label}</span>
                  <span className="ml-2 text-[var(--color-text-muted)]">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          </details>
        </div>
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {file && origW > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleResize} disabled={status === 'processing'}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] disabled:opacity-50 sm:w-auto">
            {status === 'processing' ? 'Resizing…' : `Resize to ${targetW}×${targetH}`}
          </button>
          {status === 'done' && resultBlob && <DownloadButton onClick={handleDownload} label="Download" />}
        </div>
      )}

      {status === 'done' && resultBlob && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Resized to {targetW}×{targetH}px!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(resultBlob.size)}</p>
        </div>
      )}

      {status === 'done' && resultBlob && resultBlob.size > 500 * 1024 && (
        <div className="rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-3 text-sm text-[var(--color-text-secondary)]">
          File still large? Optimize it further with{' '}
          <a href="/compress-image" className="font-medium text-[var(--color-primary)] underline hover:no-underline">Compress Image</a>.
        </div>
      )}
    </div>
  );
}
