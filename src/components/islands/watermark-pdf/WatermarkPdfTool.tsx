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
import type { WorkerResponse, WatermarkOptions } from '@/types/worker-messages';

type WatermarkType = 'text' | 'image';
type ApplyTo = 'all' | 'odd' | 'even';
type Status = 'idle' | 'processing' | 'done' | 'error';

export default function WatermarkPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [watermarkType, setWatermarkType] = useState<WatermarkType>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [fontSize, setFontSize] = useState(60);
  const [color, setColor] = useState('#000000');
  const [opacity, setOpacity] = useState(30);
  const [rotation, setRotation] = useState(-45);
  const [placement, setPlacement] = useState<'center' | 'tiled'>('center');
  const [applyTo, setApplyTo] = useState<ApplyTo>('all');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
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

  const handleImageFiles = useCallback((files: File[]) => {
    const f = files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (e) => setImageDataUrl(e.target?.result as string);
    reader.readAsDataURL(f);
  }, []);

  const handleApply = useCallback(async () => {
    if (!buffer || !file) { toast.error('Upload a PDF first'); return; }
    if (watermarkType === 'text' && !text.trim()) { toast.error('Enter watermark text'); return; }
    if (watermarkType === 'image' && !imageDataUrl) { toast.error('Upload a watermark image'); return; }

    setStatus('processing');
    const opts: WatermarkOptions = {
      type: watermarkType,
      text: watermarkType === 'text' ? text : undefined,
      imageDataUrl: watermarkType === 'image' ? imageDataUrl ?? undefined : undefined,
      fontSize, color, opacity, rotation, placement, applyTo,
      layer: 'front',
    };
    const { port1, port2 } = new MessageChannel();
    const bufCopy = buffer.slice(0);
    const response: WorkerResponse | null = await run(
      'pdf', { op: 'watermark', buffer: bufCopy, options: opts, progressPort: port2 }, [bufCopy, port2]
    );
    port1.close();
    if (!response) { setStatus('idle'); return; }
    if (response.status === 'error') { setStatus('error'); setErrorMsg(response.message); toast.error(response.message); return; }
    if (response.status === 'success') { setResult(response.result); setStatus('done'); toast.success('Watermark applied!'); }
  }, [buffer, file, watermarkType, text, imageDataUrl, fontSize, color, opacity, rotation, placement, applyTo, run]);

  const handleDownload = useCallback(async () => {
    if (!result || !file) return;
    triggerDownload(result, file.name.replace(/\.pdf$/i, '') + '-watermarked.pdf', 'application/pdf');
  }, [result, file]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="PDF to watermark" />

      {file && <FileInfoCard file={file} onRemove={handleRemoveFile} />}

      {file && (
        <>
          {/* Type selector */}
          <div className="flex gap-1 rounded-xl bg-[var(--color-background)] p-1">
            {(['text', 'image'] as WatermarkType[]).map((t) => (
              <button key={t} onClick={() => setWatermarkType(t)}
                className={cn('flex-1 rounded-lg py-2 text-sm font-medium capitalize transition-colors',
                  watermarkType === t
                    ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                    : 'text-[var(--color-text-muted)]'
                )}>
                {t} Watermark
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            {watermarkType === 'text' ? (
              <div className="flex flex-col gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">Watermark Text</label>
                  <input type="text" value={text} onChange={(e) => setText(e.target.value)}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                      <span>Font Size</span><span>{fontSize}pt</span>
                    </label>
                    <input type="range" min={12} max={120} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
                      className="w-full accent-[var(--color-primary)]" />
                  </div>
                  <div>
                    <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                      <span>Opacity</span><span>{opacity}%</span>
                    </label>
                    <input type="range" min={5} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))}
                      className="w-full accent-[var(--color-primary)]" />
                  </div>
                  <div>
                    <label className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                      <span>Rotation</span><span>{rotation}°</span>
                    </label>
                    <input type="range" min={-90} max={90} value={rotation} onChange={(e) => setRotation(Number(e.target.value))}
                      className="w-full accent-[var(--color-primary)]" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Color</label>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                      className="h-9 w-full cursor-pointer rounded-xl border border-[var(--color-border)]" />
                  </div>
                </div>
              </div>
            ) : (
              <DropZone accept={['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']}
                multiple={false} onFiles={handleImageFiles} hint="PNG, JPEG, or SVG logo" />
            )}

            <div className="mt-4 flex flex-wrap gap-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">Placement</label>
                <div className="flex gap-2">
                  {(['center', 'tiled'] as const).map((p) => (
                    <button key={p} onClick={() => setPlacement(p)}
                      className={cn('rounded-lg border px-3 py-1.5 text-xs capitalize transition-colors',
                        placement === p ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                      )}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">Apply to</label>
                <div className="flex gap-2">
                  {(['all', 'odd', 'even'] as ApplyTo[]).map((a) => (
                    <button key={a} onClick={() => setApplyTo(a)}
                      className={cn('rounded-lg border px-3 py-1.5 text-xs capitalize transition-colors',
                        applyTo === a ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                      )}>
                      {a === 'all' ? 'All pages' : `${a} pages`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {isRunning && <ProcessingOverlay progress={progress} label={progressLabel || 'Adding watermark…'} />}
      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {!isRunning && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleApply}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] sm:w-auto">
            Apply Watermark
          </button>
          {status === 'done' && result && <DownloadButton onClick={handleDownload} label="Download PDF" />}
        </div>
      )}

      {status === 'done' && result && file && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">Watermark applied!</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{formatBytes(result.byteLength)}</p>
        </div>
      )}
    </div>
  );
}
