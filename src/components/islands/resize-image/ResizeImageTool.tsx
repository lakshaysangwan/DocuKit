import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import FileList, { type FileItem } from '@/components/islands/shared/FileList';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import NextStep from '@/components/islands/shared/NextStep';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { createZipAndDownload } from '@/lib/download';
import { encodeImageData, formatMime, type ImageFormat } from '@/lib/image-codec';
import { formatBytes, generateId } from '@/lib/utils';
import { cn } from '@/lib/utils';

type FitMode = 'fit' | 'cover' | 'stretch';
type Status = 'idle' | 'processing' | 'done' | 'error';

/** Resize one image file to targetW×targetH under the given fit mode. */
async function resizeOneImage(file: File, targetW: number, targetH: number, mode: FitMode): Promise<Blob> {
  const buf = await file.arrayBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: file.type }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`Failed to load ${file.name}`));
      im.src = url;
    });
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
    } else { // cover
      const scale = Math.max(targetW / img.naturalWidth, targetH / img.naturalHeight);
      const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
      ctx.drawImage(img, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);
    }
    const outFormat: ImageFormat = file.type === 'image/png' ? 'png' : 'jpeg';
    const data = ctx.getImageData(0, 0, targetW, targetH);
    const out = await encodeImageData(data, outFormat, 92);
    return new Blob([out], { type: formatMime(outFormat) });
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Preset { label: string; w: number; h: number }
const PRESETS_KEY = 'docukit:resize-presets';

function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

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
  const [customPresets, setCustomPresets] = useState<Preset[]>([]);
  const [batch, setBatch] = useState<FileItem[]>([]);
  const [batchResults, setBatchResults] = useState<{ name: string; blob: Blob }[]>([]);
  const [batchPct, setBatchPct] = useState(0);
  const isBatch = batch.length > 0;

  // Load saved presets from localStorage on mount.
  useEffect(() => { setCustomPresets(loadPresets()); }, []);

  const persistPresets = useCallback((next: Preset[]) => {
    setCustomPresets(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
  }, []);

  const saveCurrentPreset = useCallback(() => {
    if (!targetW || !targetH) return;
    const label = `${targetW}×${targetH}`;
    if (customPresets.some((p) => p.label === label)) { toast.info('Preset already saved'); return; }
    persistPresets([...customPresets, { label, w: targetW, h: targetH }]);
    toast.success(`Saved preset ${label}`);
  }, [targetW, targetH, customPresets, persistPresets]);

  const deletePreset = useCallback((label: string) => {
    persistPresets(customPresets.filter((p) => p.label !== label));
  }, [customPresets, persistPresets]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setStatus('idle'); setResultBlob(null); setBatchResults([]);

    if (files.length > 1) {
      // Batch: derive target dims from the first image, apply to all.
      setFile(null); setBuffer(null);
      setBatch(files.map((f) => ({ id: generateId(), file: f })));
      const first = files[0];
      const img = new Image();
      const url = URL.createObjectURL(first);
      img.onload = () => {
        setOrigW(img.naturalWidth); setOrigH(img.naturalHeight);
        setTargetW(img.naturalWidth); setTargetH(img.naturalHeight);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
      return;
    }

    setBatch([]);
    const f = files[0];
    setFile(f);
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
    if (!targetW || !targetH) { toast.error('Set target dimensions first'); return; }
    setStatus('processing'); setErrorMsg(null);

    try {
      if (isBatch) {
        setBatchPct(0);
        const out: { name: string; blob: Blob }[] = [];
        for (let i = 0; i < batch.length; i++) {
          setBatchPct(Math.round(((i + 1) / batch.length) * 100));
          const blob = await resizeOneImage(batch[i].file, targetW, targetH, mode);
          const ext = blob.type === 'image/png' ? 'png' : 'jpg';
          const base = batch[i].file.name.replace(/\.[^.]+$/, '');
          out.push({ name: `${base}-${targetW}x${targetH}.${ext}`, blob });
        }
        setBatchResults(out);
        setStatus('done');
        toast.success(`Resized ${out.length} images`);
        return;
      }

      if (!file) { toast.error('Upload an image first'); return; }
      const result = await resizeOneImage(file, targetW, targetH, mode);
      setResultBlob(result);
      setStatus('done');
      toast.success('Image resized!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resize failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [isBatch, batch, file, targetW, targetH, mode]);

  const handleDownload = useCallback(async () => {
    if (isBatch) {
      if (batchResults.length === 0) return;
      const fileList = await Promise.all(batchResults.map(async (r) => ({ name: r.name, buffer: await r.blob.arrayBuffer() })));
      await createZipAndDownload(fileList, 'resized-images.zip');
      return;
    }
    if (!resultBlob || !file) return;
    const ext = file.type === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + `-${targetW}x${targetH}.${ext}`;
    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [isBatch, batchResults, resultBlob, file, targetW, targetH]);

  const isUpscale = targetW > origW || targetH > origH;

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']}
        multiple onFiles={handleFiles} hint="Any common image format · single or batch" compact={isBatch || !!file} />

      {!isBatch && file && <FileInfoCard file={file} extra={origW ? `${origW} × ${origH}px` : undefined} onRemove={handleRemoveFile} />}

      {isBatch && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-secondary)]">
              {batch.length} images · resized to {targetW}×{targetH} ({mode})
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
        </div>
      )}

      {(file || isBatch) && origW > 0 && (
        <div className="flex flex-col gap-5">

          {/* Dimensions */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label htmlFor="ri-width" className="mb-1 block text-xs text-[var(--color-text-secondary)]">Width (px)</label>
                  <input id="ri-width" type="number" min={1} value={targetW} onChange={(e) => updateW(Number(e.target.value))}
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                </div>
                <button onClick={() => setLockAspect((v) => !v)}
                  className={cn('mb-0.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                    lockAspect ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}
                  title={lockAspect ? 'Aspect locked' : 'Aspect unlocked'}>
                  {lockAspect ? '🔒' : '🔓'}
                </button>
                <div className="flex-1">
                  <label htmlFor="ri-height" className="mb-1 block text-xs text-[var(--color-text-secondary)]">Height (px)</label>
                  <input id="ri-height" type="number" min={1} value={targetH} onChange={(e) => updateH(Number(e.target.value))}
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
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
                  {([['fit', 'Fit (letterbox)'], ['cover', 'Cover (crop)'], ['stretch', 'Stretch']] as const).map(([v, l]) => (
                    <button key={v} onClick={() => setMode(v)}
                      className={cn('rounded-lg border px-3 py-1.5 text-xs transition-colors',
                        mode === v ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                      )}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Your saved presets */}
          <div className="rounded-lg border border-[var(--color-border)] p-3" data-testid="custom-presets">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--color-text-primary)]">Your presets</span>
              <button onClick={saveCurrentPreset} data-testid="save-preset"
                className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[var(--color-primary)]">
                Save {targetW}×{targetH}
              </button>
            </div>
            {customPresets.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">No saved presets yet. Save a size to reuse it later.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {customPresets.map((p) => (
                  <span key={p.label} data-testid="custom-preset"
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] pl-3 text-xs">
                    <button onClick={() => applyPreset(p.w, p.h)} className="py-1.5 font-medium text-[var(--color-text-primary)]">
                      {p.label}
                    </button>
                    <button onClick={() => deletePreset(p.label)} aria-label={`Delete preset ${p.label}`}
                      className="px-2 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-error)]">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Social presets */}
          <details className="rounded-lg border border-[var(--color-border)]">
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

      {status === 'processing' && isBatch && (
        <ProcessingOverlay progress={batchPct} label="Resizing images…" />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {(file || isBatch) && origW > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleResize} disabled={status === 'processing'} data-testid="tool-action"
            className="w-full rounded-lg bg-[var(--color-text-primary)] px-6 py-2.5 text-sm font-medium text-[var(--color-background)] hover:opacity-80 disabled:opacity-50 sm:w-auto">
            {status === 'processing' ? 'Resizing…' : isBatch ? `Resize ${batch.length} images to ${targetW}×${targetH}` : `Resize to ${targetW}×${targetH}`}
          </button>
          {status === 'done' && (isBatch ? batchResults.length > 0 : resultBlob) && (
            <DownloadButton onClick={handleDownload} label={isBatch ? `Download ZIP (${batchResults.length} files)` : 'Download'} />
          )}
        </div>
      )}

      {status === 'done' && isBatch && batchResults.length > 0 && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Resized {batchResults.length} images to {targetW}×{targetH}px!</p>
        </div>
      )}

      {!isBatch && status === 'done' && resultBlob && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Resized to {targetW}×{targetH}px!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(resultBlob.size)}</p>
        </div>
      )}

      {status === 'done' && resultBlob && resultBlob.size > 500 * 1024 && (
        <NextStep href="/compress-image" label="Compress Image">File still large? Optimize it further with</NextStep>
      )}
    </div>
  );
}
