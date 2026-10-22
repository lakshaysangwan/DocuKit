import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ImageFormat } from '@/lib/image-codec';
import { cn, formatBytes } from '@/lib/utils';
import {
  estimateBytes,
  exportPixelSize,
  previewDpi,
  previewPixelBudget,
  renderAsExported,
  type PageSizePt,
} from './export-render';

/** Wait this long after a setting stops changing (the quality slider) before rendering again. */
const SETTLE_MS = 250;

interface Shown {
  url: string;
  pageIndex: number;
  format: ImageFormat;
  dpi: number;
  quality: number;
  /** The DPI the preview was drawn at: `dpi`, or lower when capped. */
  drawnDpi: number;
  width: number;
  height: number;
  bytes: number;
}

export interface ExportPreviewProps {
  /** The document the images are exported from (opened on first use). */
  getDoc: () => Promise<PDFDocumentProxy>;
  pageIndex: number;
  size: PageSizePt;
  format: ImageFormat;
  dpi: number;
  quality: number;
  /** The image's file name, or null when the page is not exported. */
  name: string | null;
}

const zoomButton =
  'inline-flex h-8 items-center rounded-lg border px-2.5 text-xs font-semibold transition-colors';

/**
 * One page, enlarged, as the image it will be saved as: rendered by the same
 * function as the export, at the chosen DPI, encoded in the chosen format and
 * quality, so what is on screen is the file's own pixels. Rendered only while
 * open. Above the preview pixel budget (600 DPI on a large page) it is drawn
 * at the highest DPI that fits, and says so; the pixel size and file size it
 * reports are then for the full image, the file size estimated.
 *
 * Test ids: `p2i-preview`, `p2i-preview-image` (with `data-format`, `data-dpi`,
 * `data-quality`, `data-drawn-dpi`, `data-page`), `p2i-preview-size`,
 * `p2i-preview-bytes`, `p2i-preview-capped`, `p2i-preview-status`,
 * `p2i-zoom-fit`, `p2i-zoom-actual`.
 */
export default function ExportPreview({ getDoc, pageIndex, size, format, dpi, quality, name }: ExportPreviewProps) {
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Shown | null>(null);
  const budget = useMemo(() => previewPixelBudget(), []);
  const drawnDpi = previewDpi(size, dpi, budget);
  const full = exportPixelSize(size, dpi);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const doc = await getDoc();
            const out = await renderAsExported(doc, pageIndex, size, drawnDpi, format, quality, controller.signal);
            if (controller.signal.aborted) return;
            const next: Shown = {
              url: URL.createObjectURL(out.blob),
              pageIndex,
              format,
              dpi,
              quality,
              drawnDpi,
              width: out.width,
              height: out.height,
              bytes: out.blob.size,
            };
            const old = current.current;
            current.current = next;
            setShown(next);
            if (old) URL.revokeObjectURL(old.url);
          } catch (err) {
            if (controller.signal.aborted) return;
            setError(err instanceof Error ? err.message : 'The preview could not be drawn.');
          }
        })();
      },
      current.current ? SETTLE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `size` is derived from the page; its numbers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getDoc, pageIndex, size.widthPt, size.heightPt, format, dpi, quality, drawnDpi]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current.url);
      current.current = null;
    },
    [],
  );

  const upToDate =
    !!shown &&
    shown.pageIndex === pageIndex &&
    shown.format === format &&
    shown.dpi === dpi &&
    shown.quality === quality;
  const ofThisPage = !!shown && shown.pageIndex === pageIndex;
  const capped = drawnDpi < dpi;
  const formatName = format.toUpperCase();
  const qualityText = format === 'png' ? 'lossless' : `quality ${quality}%`;
  const bytesText = shown
    ? capped
      ? `about ${formatBytes(estimateBytes(shown.bytes, shown.width * shown.height, full.width * full.height))} (estimated)`
      : formatBytes(shown.bytes)
    : '…';

  return (
    <div data-testid="p2i-preview" className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 sm:px-4">
        <p className="min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]">
          <span className="font-semibold text-[var(--color-text-primary)]">
            {name ? `As saved: ${name}` : 'Not exported with the pages chosen. As it would be saved:'}
          </span>{' '}
          <span className="tabular-nums">
            {formatName} · {qualityText} · {dpi} DPI ·{' '}
            <span data-testid="p2i-preview-size">
              {full.width} × {full.height} px
            </span>{' '}
            · <span data-testid="p2i-preview-bytes">{upToDate ? bytesText : '…'}</span>
          </span>
        </p>
        <div role="group" aria-label="Preview zoom" className="flex shrink-0 gap-1">
          <button
            type="button"
            aria-pressed={zoom === 'fit'}
            onClick={() => setZoom('fit')}
            data-testid="p2i-zoom-fit"
            className={cn(
              zoomButton,
              zoom === 'fit'
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background)]',
            )}
          >
            Fit
          </button>
          <button
            type="button"
            aria-pressed={zoom === 'actual'}
            onClick={() => setZoom('actual')}
            data-testid="p2i-zoom-actual"
            title="One image pixel to one screen pixel"
            className={cn(
              zoomButton,
              zoom === 'actual'
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background)]',
            )}
          >
            100%
          </button>
        </div>
        {capped && (
          <p data-testid="p2i-preview-capped" className="w-full text-xs text-[var(--color-text-secondary)]">
            Shown at {drawnDpi} DPI to stay within this device&rsquo;s memory. The saved image is {full.width} ×{' '}
            {full.height} px.
          </p>
        )}
      </div>

      <div
        className="relative flex min-h-0 flex-1 overflow-auto p-2 sm:p-3"
        tabIndex={zoom === 'actual' ? 0 : undefined}
        aria-label={zoom === 'actual' ? 'Image at 100%, scrollable' : undefined}
        role={zoom === 'actual' ? 'region' : undefined}
      >
        {ofThisPage && shown ? (
          <img
            src={shown.url}
            alt={`Page ${pageIndex + 1} as a ${formatName} image, ${shown.width} × ${shown.height} px`}
            data-testid="p2i-preview-image"
            data-page={shown.pageIndex}
            data-format={shown.format}
            data-dpi={shown.dpi}
            data-quality={shown.quality}
            data-drawn-dpi={shown.drawnDpi}
            draggable={false}
            className={cn('m-auto block bg-white', zoom === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
            style={zoom === 'actual' ? { width: shown.width, height: shown.height } : undefined}
          />
        ) : (
          <p className="m-auto text-sm text-[var(--color-text-secondary)]">{error ? '' : 'Drawing the image…'}</p>
        )}
        <p
          role="status"
          data-testid="p2i-preview-status"
          className={cn(
            'pointer-events-none absolute left-3 top-3 rounded-md bg-[var(--color-surface)]/90 px-2 py-1 text-xs font-medium text-[var(--color-text-primary)] shadow',
            !error && upToDate && 'sr-only',
            error && 'text-[var(--color-error)]',
          )}
        >
          {error ? `The preview could not be drawn: ${error}` : upToDate ? 'Preview up to date.' : 'Updating the preview…'}
        </p>
      </div>
    </div>
  );
}
