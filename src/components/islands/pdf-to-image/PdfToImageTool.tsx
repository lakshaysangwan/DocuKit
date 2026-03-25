import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import DropZone from '@/components/islands/shared/DropZone';
import FileInfoCard from '@/components/islands/shared/FileInfoCard';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProcessingOverlay from '@/components/islands/shared/ProcessingOverlay';
import { usePdfThumbnails } from '@/hooks/use-pdf-thumbnails';
import { fileToArrayBuffer } from '@/lib/file-utils';
import { createZipAndDownload } from '@/lib/download';
import { parsePageRange } from '@/lib/pdf-page-range';
import { cn } from '@/lib/utils';

type OutputFormat = 'png' | 'jpeg' | 'webp';
type DpiPreset = 72 | 150 | 300;
type Status = 'idle' | 'processing' | 'done' | 'error';

const DPI_PRESETS: { value: DpiPreset; label: string }[] = [
  { value: 72, label: '72 DPI (screen)' },
  { value: 150, label: '150 DPI (print)' },
  { value: 300, label: '300 DPI (high quality)' },
];

export default function PdfToImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [format, setFormat] = useState<OutputFormat>('png');
  const [dpi, setDpi] = useState<DpiPreset>(150);
  const [quality, setQuality] = useState(85);
  const [pageMode, setPageMode] = useState<'all' | 'range'>('all');
  const [rangeInput, setRangeInput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [results, setResults] = useState<Blob[]>([]);
  const [convertProgress, setConvertProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { pageCount, loadThumbnails } = usePdfThumbnails();

  const handleFiles = useCallback(async (files: File[]) => {
    const f = files[0]; if (!f) return;
    setFile(f); setStatus('idle'); setResults([]); setErrorMsg(null);
    try {
      const buf = await fileToArrayBuffer(f);
      setBuffer(buf);
      await loadThumbnails(buf, 120);
    } catch { setFile(null); setBuffer(null); toast.error('Failed to load PDF. If it is encrypted, please unlock it first.'); }
  }, [loadThumbnails]);

  const handleRemoveFile = useCallback(() => {
    setFile(null); setBuffer(null); setStatus('idle'); setResults([]); setErrorMsg(null);
  }, []);

  const handleConvert = useCallback(async () => {
    if (!buffer || !file || !pageCount) { toast.error('Upload a PDF first'); return; }

    let pageIndices: number[];
    if (pageMode === 'range' && rangeInput.trim()) {
      pageIndices = parsePageRange(rangeInput, pageCount);
      if (pageIndices.length === 0) { toast.error('No valid pages in range'); return; }
    } else {
      pageIndices = Array.from({ length: pageCount }, (_, i) => i);
    }

    setStatus('processing');
    setConvertProgress(0);
    setResults([]);

    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

      const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      const scale = dpi / 72; // 72 is PDF base DPI
      const blobs: Blob[] = [];

      for (let i = 0; i < pageIndices.length; i++) {
        setConvertProgress(Math.round(((i + 1) / pageIndices.length) * 100));
        const page = await doc.getPage(pageIndices[i] + 1);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;

        await page.render({
          canvasContext: ctx,
          canvas: canvas as HTMLCanvasElement,
          viewport,
        }).promise;

        const mimeType = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
        const q = format === 'png' ? undefined : quality / 100;

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('Canvas toBlob failed'));
          }, mimeType, q);
        });

        blobs.push(blob);
        page.cleanup();
      }

      doc.destroy();
      setResults(blobs);
      setStatus('done');
      toast.success(`Converted ${blobs.length} page${blobs.length !== 1 ? 's' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Conversion failed';
      setStatus('error'); setErrorMsg(msg); toast.error(msg);
    }
  }, [buffer, file, pageCount, pageMode, rangeInput, format, dpi, quality]);

  const handleDownload = useCallback(async () => {
    if (results.length === 0 || !file) return;
    const base = file.name.replace(/\.pdf$/i, '');
    const ext = format;

    if (results.length === 1) {
      const url = URL.createObjectURL(results[0]);
      const a = document.createElement('a');
      a.href = url; a.download = `${base}-page1.${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const files = await Promise.all(
        results.map(async (blob, i) => ({
          name: `${base}-page${i + 1}.${ext}`,
          buffer: await blob.arrayBuffer(),
        }))
      );
      await createZipAndDownload(files, `${base}-images.zip`);
    }
  }, [results, file, format]);

  return (
    <div className="flex flex-col gap-6">
      <DropZone accept={['application/pdf']} multiple={false} onFiles={handleFiles} hint="Single PDF file" />

      {file && <FileInfoCard file={file} extra={pageCount ? `${pageCount} pages` : undefined} onRemove={handleRemoveFile} />}

      {file && (
        <div className="flex flex-col gap-5">

          {/* Format */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Output Format</label>
            <div className="flex gap-2">
              {(['png', 'jpeg', 'webp'] as OutputFormat[]).map((f) => (
                <button key={f} onClick={() => setFormat(f)}
                  className={cn('rounded-xl border px-4 py-2 text-sm font-medium uppercase transition-colors',
                    format === f ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* DPI */}
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Resolution</label>
            <div className="flex flex-wrap gap-2">
              {DPI_PRESETS.map((p) => (
                <button key={p.value} onClick={() => setDpi(p.value)}
                  className={cn('rounded-xl border px-4 py-2 text-sm transition-colors',
                    dpi === p.value ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Quality (for JPEG/WebP) */}
          {format !== 'png' && (
            <div>
              <label className="mb-1 flex justify-between text-sm font-medium text-[var(--color-text-primary)]">
                <span>Quality</span><span className="font-normal text-[var(--color-text-muted)] tabular-nums">{quality}%</span>
              </label>
              <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]" />
            </div>
          )}

          {/* Page selection */}
          {pageCount > 1 && (
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">Pages</label>
              <div className="flex gap-2">
                <button onClick={() => setPageMode('all')}
                  className={cn('rounded-xl border px-4 py-2 text-sm transition-colors',
                    pageMode === 'all' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>All {pageCount} pages</button>
                <button onClick={() => setPageMode('range')}
                  className={cn('rounded-xl border px-4 py-2 text-sm transition-colors',
                    pageMode === 'range' ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]' : 'border-[var(--color-border)]'
                  )}>Custom range</button>
              </div>
              {pageMode === 'range' && (
                <input type="text" value={rangeInput} onChange={(e) => setRangeInput(e.target.value)}
                  placeholder="e.g. 1-5, 8, last"
                  className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]" />
              )}
            </div>
          )}
        </div>
      )}

      {/* Processing */}
      {status === 'processing' && (
        <ProcessingOverlay progress={convertProgress} label="Converting pages…" />
      )}

      {status === 'error' && errorMsg && (
        <div className="rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">{errorMsg}</div>
      )}

      {/* Actions */}
      {status !== 'processing' && file && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button onClick={handleConvert} disabled={!pageCount}
            className="w-full rounded-xl bg-[var(--color-primary)] px-6 py-3 font-semibold text-white hover:bg-[var(--color-primary-dark)] disabled:opacity-50 sm:w-auto">
            Convert to {format.toUpperCase()}
          </button>
          {status === 'done' && results.length > 0 && (
            <DownloadButton onClick={handleDownload}
              label={results.length === 1 ? 'Download Image' : `Download ZIP (${results.length} images)`} />
          )}
        </div>
      )}

      {status === 'done' && results.length > 0 && (
        <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
          <p className="text-sm font-medium text-[var(--color-success)]">
            {results.length} image{results.length !== 1 ? 's' : ''} ready!
          </p>
        </div>
      )}

      {status === 'done' && results.length > 0 && (
        <div className="rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/5 p-3 text-sm text-[var(--color-text-secondary)]">
          Exported images may be large at high DPI. Optimize with{' '}
          <a href="/compress-image" className="font-medium text-[var(--color-primary)] underline hover:no-underline">Compress Image</a>.
        </div>
      )}
    </div>
  );
}
