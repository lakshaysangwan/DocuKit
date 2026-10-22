import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import type { PageGeometry } from '@/lib/pdf/page-geometry';
import { cn } from '@/lib/utils';

/** What an overlay needs to know about the page it is drawn over. */
export interface PageFrame {
  pageIndex: number;
  /** Size of the displayed page in CSS pixels. */
  widthPx: number;
  heightPx: number;
  geometry: PageGeometry;
}

export interface PageViewerProps {
  /** The open document, or null while it is loading (a page-shaped skeleton is shown). */
  doc: PdfDocHandle | null;
  /** Zero-based. */
  pageIndex: number;
  onPageChange: (pageIndex: number) => void;
  /**
   * Drawn over the page, in a layer exactly the size of the page: position
   * children with percentages (a `RectNorm` × 100). Omit to show the page only.
   */
  overlay?: (frame: PageFrame) => ReactNode;
  /** Extra toolbar buttons at the end (Undo / Redo). */
  toolbarEnd?: ReactNode;
  /** A fixed-height row under the page (the selection bar, a Before/After toggle). */
  footer?: ReactNode;
  /** Names the page for assistive tech and for the image alt: "Signed page". Defaults to "Page". */
  pageLabel?: string;
  /** Space kept around the page inside the pane, in CSS pixels (default 16). Raise it for handles that sit on the page edge. */
  padding?: number;
}

type Fit = { mode: 'page' } | { mode: 'width' } | { mode: 'zoom'; scale: number };

/** CSS pixels per PDF point at "100%". */
const ACTUAL_SIZE = 96 / 72;
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.25 * ACTUAL_SIZE;
const MAX_SCALE = 4 * ACTUAL_SIZE;
/** Space kept around the page inside the pane, in CSS pixels. */
const PADDING = 16;
/** Wait this long after the size stops changing before re-rendering at the new size. */
const RERENDER_DELAY_MS = 140;
/** Shape of the skeleton shown before the first page's size is known (A4). */
const SKELETON_ASPECT = 210 / 297;

interface Rendered {
  doc: PdfDocHandle;
  pageIndex: number;
  url: string;
}

const toolButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

/**
 * One page, large.
 *
 * Renders the current page through the document handle as a `blob:` image at
 * the size it is shown (times the device pixel ratio, under the handle's pixel
 * budget), re-renders when the size settles, and releases every render it
 * replaces. "Fit page" is the default; "Fit width" and the zoom buttons scroll
 * inside the pane. The pane never changes size because of what it shows.
 *
 * Test ids: `page-viewer` (the scrolling pane), `page-canvas` (the page, with
 * `data-page`, `data-rendered`), `page-image`, `page-prev`, `page-next`,
 * `page-indicator`, `zoom-out`, `zoom-in`, `zoom-level`, `zoom-fit`, `zoom-width`.
 */
export default function PageViewer({
  doc,
  pageIndex,
  onPageChange,
  overlay,
  toolbarEnd,
  footer,
  pageLabel = 'Page',
  padding = PADDING,
}: PageViewerProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState<Fit>({ mode: 'page' });
  const [geometry, setGeometry] = useState<{ doc: PdfDocHandle; pageIndex: number; geom: PageGeometry } | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const current = useRef<Rendered | null>(null);

  const pageCount = doc?.pageCount ?? 0;
  const index = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));

  // The pane's inner size, which is what the page is fitted to.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPane({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || doc.destroyed || index >= doc.pageCount) return;
    let live = true;
    doc.geometry(index).then(
      (geom) => {
        if (live) setGeometry({ doc, pageIndex: index, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, index]);

  const geom = geometry && geometry.doc === doc && geometry.pageIndex === index ? geometry.geom : null;

  // Displayed size of the page in CSS pixels.
  const availWidth = Math.max(pane.width - padding * 2, 40);
  const availHeight = Math.max(pane.height - padding * 2, 40);
  let scale = 0;
  if (geom) {
    const pageFit = Math.min(availWidth / geom.widthPt, availHeight / geom.heightPt);
    if (fit.mode === 'page') scale = pageFit;
    else if (fit.mode === 'width') scale = availWidth / geom.widthPt;
    else scale = fit.scale;
  }
  const widthPx = geom ? Math.max(1, Math.round(geom.widthPt * scale)) : 0;
  const heightPx = geom ? Math.max(1, Math.round(geom.heightPt * scale)) : 0;
  const ready = !!geom && pane.width > 0 && pane.height > 0;

  const release = useCallback((r: Rendered | null) => {
    if (r) r.doc.releasePage(r.url);
  }, []);

  // Render the page at the size it is shown. A render that is replaced — by a
  // sharper one, another page, or another document — is released straight away.
  const hasCurrent = !!rendered && rendered.doc === doc && rendered.pageIndex === index;
  useEffect(() => {
    if (!doc || doc.destroyed || !ready || widthPx <= 0) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        doc.renderPage(index, { cssWidth: widthPx, signal: controller.signal }).then(
          (result) => {
            const next: Rendered = { doc, pageIndex: index, url: result.url };
            if (controller.signal.aborted) {
              release(next);
              return;
            }
            const old = current.current;
            current.current = next;
            setFailed(false);
            setRendered(next);
            release(old);
          },
          (err: unknown) => {
            if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
            if ((err as Error)?.name === 'PdfClosedError') return;
            setFailed(true);
          },
        );
      },
      hasCurrent ? RERENDER_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `hasCurrent` only chooses the delay; it must not restart the render it describes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, ready, widthPx, release]);

  // Leaving: give the last render back.
  useEffect(
    () => () => {
      release(current.current);
      current.current = null;
    },
    [release],
  );

  const shown = hasCurrent ? rendered : null;
  // Until this page's own render arrives, its thumbnail (if the rail made one) stands in.
  const placeholder = !shown && doc && !doc.destroyed && index < doc.pageCount ? doc.getThumb(index) : undefined;
  const isRendered = !!shown && loaded === shown.url;

  const go = (next: number) => {
    if (next < 0 || next >= pageCount || next === index) return;
    onPageChange(next);
  };

  const zoomBy = (factor: number) => {
    if (!geom) return;
    setFit({ mode: 'zoom', scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor)) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'PageDown') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      go(index - 1);
    }
  };

  const percent = geom ? Math.round((scale / ACTUAL_SIZE) * 100) : null;
  const skeletonHeight = Math.max(availHeight, 80);

  return (
    <div className="absolute inset-0 flex flex-col" onKeyDown={onKeyDown}>
      {/* Toolbar: pager, zoom, the tool's own buttons. */}
      <div
        role="toolbar"
        aria-label="Page view"
        className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 sm:px-3"
      >
        <button
          type="button"
          onClick={() => go(index - 1)}
          disabled={index <= 0}
          aria-label="Previous page"
          data-testid="page-prev"
          className={toolButton}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span
          data-testid="page-indicator"
          aria-live="polite"
          className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-[var(--color-text-primary)]"
        >
          {pageCount > 0 ? `Page ${index + 1} of ${pageCount}` : 'Page'}
        </span>
        <button
          type="button"
          onClick={() => go(index + 1)}
          disabled={index >= pageCount - 1}
          aria-label="Next page"
          data-testid="page-next"
          className={toolButton}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>

        <span className="mx-1 hidden h-5 w-px bg-[var(--color-border)] sm:block" aria-hidden="true" />

        <button
          type="button"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={!geom || scale <= MIN_SCALE}
          aria-label="Zoom out"
          data-testid="zoom-out"
          className={cn(toolButton, 'max-sm:hidden')}
        >
          <Minus className="size-4" aria-hidden="true" />
        </button>
        <span
          data-testid="zoom-level"
          className="hidden w-11 text-center text-xs tabular-nums text-[var(--color-text-secondary)] sm:block"
        >
          {percent !== null ? `${percent}%` : ''}
        </span>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={!geom || scale >= MAX_SCALE}
          aria-label="Zoom in"
          data-testid="zoom-in"
          className={cn(toolButton, 'max-sm:hidden')}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setFit({ mode: 'page' })}
          aria-pressed={fit.mode === 'page'}
          data-testid="zoom-fit"
          className={cn(toolButton, 'max-sm:hidden', fit.mode === 'page' && 'border-[var(--color-primary)] bg-[var(--color-primary)]/10')}
        >
          Fit page
        </button>
        <button
          type="button"
          onClick={() => setFit({ mode: 'width' })}
          aria-pressed={fit.mode === 'width'}
          data-testid="zoom-width"
          className={cn(toolButton, 'max-sm:hidden', fit.mode === 'width' && 'border-[var(--color-primary)] bg-[var(--color-primary)]/10')}
        >
          Fit width
        </button>

        {toolbarEnd && <div className="ml-auto flex items-center gap-1.5">{toolbarEnd}</div>}
      </div>

      {/* The page. `grid` + `m-auto` centres it and still lets it scroll when zoomed. */}
      <div
        ref={paneRef}
        data-testid="page-viewer"
        className="grid min-h-0 flex-1 overflow-auto"
        style={{ padding }}
      >
        {ready ? (
          <div
            data-testid="page-canvas"
            data-page={index + 1}
            data-rendered={isRendered ? 'true' : 'false'}
            className="relative m-auto shrink-0 select-none bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2),0_8px_24px_-8px_rgba(0,0,0,0.25)]"
            style={{ width: widthPx, height: heightPx }}
          >
            {shown ? (
              <img
                key="page"
                src={shown.url}
                alt={`${pageLabel} ${index + 1}`}
                data-testid="page-image"
                draggable={false}
                onLoad={() => setLoaded(shown.url)}
                className="pointer-events-none absolute inset-0 block size-full"
              />
            ) : placeholder ? (
              <img
                key="placeholder"
                src={placeholder}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 block size-full opacity-60"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
                {failed ? 'This page could not be shown.' : 'Loading page…'}
              </div>
            )}
            {overlay && geom && overlay({ pageIndex: index, widthPx, heightPx, geometry: geom })}
          </div>
        ) : (
          // Page-shaped while the file opens, so nothing moves when the page arrives.
          <div
            data-testid="page-skeleton"
            className="m-auto flex items-center justify-center bg-white text-xs text-neutral-500 shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
            style={{ height: skeletonHeight, width: Math.round(skeletonHeight * SKELETON_ASPECT), maxWidth: '100%' }}
          >
            Opening your PDF…
          </div>
        )}
      </div>

      {footer && (
        <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]">{footer}</div>
      )}
    </div>
  );
}
