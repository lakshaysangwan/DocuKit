import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Two renders of the same thing, compared: an original and what became of it.
 *
 *   Split         the two stacked, the result clipped (`clip-path`, never a
 *                 width hack) to the right of a divider the visitor drags, or
 *                 moves with the arrow keys;
 *   Side by side  the two next to each other, panned together;
 *   Hold          the result alone, with a button that shows the original for
 *                 as long as it is held.
 *
 * Zoom is Fit, 100% or 200% of the content's natural size (a PDF page: 96 CSS px
 * per inch; an image: one image pixel per CSS pixel), and the images are always
 * `object-contain` in a box of the content's own proportions, so nothing is
 * ever cropped. The caller renders the images; `onDisplayWidth` says how wide
 * they are shown, so they can be rendered sharp enough.
 *
 * With `after` null only `before` is shown (one image, no modes): the caller
 * has nothing to compare yet. `content` then replaces `before`'s image inside
 * the box, for a caller that draws something other than one whole image (Resize
 * Image's output frame); it is sized like the image would be. With `before` null too, a page-shaped placeholder
 * stands in, so the view (and its mode and zoom) survives a page change.
 *
 * Exactly two `img` elements when comparing, in every mode.
 *
 * Test ids: `compare-view` (`data-mode`, `data-zoom`), `compare-before`,
 * `compare-after`, `compare-divider`, `compare-hold`, `compare-mode-split|side|hold`,
 * `compare-zoom-fit|100|200`, `compare-viewport`.
 */

export interface CompareImage {
  src: string;
  alt: string;
}

export type CompareMode = 'split' | 'side' | 'hold';
export type CompareZoom = 'fit' | 1 | 2;

export interface CompareViewProps {
  before: CompareImage | null;
  after: CompareImage | null;
  /** Size of the content at 100%, in CSS pixels. */
  naturalWidth: number;
  naturalHeight: number;
  beforeLabel?: string;
  afterLabel?: string;
  /** The CSS width each image is displayed at, whenever it changes. */
  onDisplayWidth?: (cssWidth: number) => void;
  /** Toolbar content before the view controls (a pager). */
  toolbarStart?: ReactNode;
  /** Shown over the view while the "after" image is being made. */
  busy?: boolean;
  /** Draw a checkerboard behind the images, so transparency shows (images); otherwise white (pages). */
  checkerboard?: boolean;
  /** Shown in the placeholder while `before` is null. Defaults to "Loading page…". */
  placeholder?: string;
  /** With `after` null: drawn in the box instead of `before`'s image. */
  content?: ReactNode;
  className?: string;
}

/** Space kept around the content inside a pane, in CSS pixels. */
const PADDING = 12;
const GAP = 8;
/** Arrow keys move the divider by this share of the width; with Shift, by a fifth of it. */
const KEY_STEP = 0.05;

const toolButton =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40';
const pressed = 'bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]';
const chip =
  'pointer-events-none absolute top-2 z-10 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-white';

/** Grey and white squares, 8 CSS px each: what shows through a transparent pixel. */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'conic-gradient(#d4d4d4 25%, #ffffff 0 50%, #d4d4d4 0 75%, #ffffff 0)',
  backgroundSize: '16px 16px',
};

const ZOOMS: { value: CompareZoom; label: string; id: string }[] = [
  { value: 'fit', label: 'Fit', id: 'fit' },
  { value: 1, label: '100%', id: '100' },
  { value: 2, label: '200%', id: '200' },
];
const MODES: { value: CompareMode; label: string; title: string }[] = [
  { value: 'split', label: 'Split', title: 'Split view with a divider' },
  { value: 'side', label: 'Side by side', title: 'Side by side' },
  { value: 'hold', label: 'Hold', title: 'The result, with a button to see the original' },
];

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

export default function CompareView({
  before,
  after,
  naturalWidth,
  naturalHeight,
  beforeLabel = 'Original',
  afterLabel = 'Result',
  onDisplayWidth,
  toolbarStart,
  busy = false,
  checkerboard = false,
  placeholder = 'Loading page…',
  content,
  className,
}: CompareViewProps) {
  const [mode, setMode] = useState<CompareMode>('split');
  const [zoom, setZoom] = useState<CompareZoom>('fit');
  const [divider, setDivider] = useState(0.5);
  const [holding, setHolding] = useState(false);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const comparing = !!before && !!after;
  const side = comparing && mode === 'side';

  // Size of the content box in CSS pixels.
  const paneWidth = side ? (area.width - GAP) / 2 : area.width;
  const availW = Math.max(paneWidth - PADDING * 2, 40);
  const availH = Math.max(area.height - PADDING * 2, 40);
  const fitScale = naturalWidth > 0 && naturalHeight > 0 ? Math.min(availW / naturalWidth, availH / naturalHeight) : 0;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const ready = area.width > 0 && area.height > 0 && fitScale > 0;

  useEffect(() => {
    if (ready) onDisplayWidth?.(width);
  }, [ready, width, onDisplayWidth]);

  /* ── Split: the clip follows the divider, which stays put while the page pans ── */

  const splitViewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [clipPx, setClipPx] = useState(0);

  const updateClip = useCallback(() => {
    const viewport = splitViewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const v = viewport.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const x = v.left + divider * v.width - c.left;
    setClipPx(Math.max(0, Math.min(c.width, x)));
  }, [divider]);

  useLayoutEffect(() => {
    updateClip();
  }, [updateClip, width, height, mode, area.width, area.height]);

  const moveDividerTo = (clientX: number) => {
    const viewport = splitViewportRef.current;
    if (!viewport) return;
    const v = viewport.getBoundingClientRect();
    setDivider(Math.max(0, Math.min(1, (clientX - v.left) / v.width)));
  };

  const dragging = useRef(false);
  const onDividerPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) moveDividerTo(e.clientX);
  };
  const onDividerPointerUp = () => {
    dragging.current = false;
  };

  const onDividerKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP / 5 : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = divider - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = divider + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    if (next === null) return;
    e.preventDefault();
    setDivider(Math.max(0, Math.min(1, next)));
  };

  /* ── Side by side: pan both panes together ── */

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  // A new zoom starts centred, in every pane.
  useLayoutEffect(() => {
    for (const el of [splitViewportRef.current, leftRef.current, rightRef.current]) {
      if (!el) continue;
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    }
    updateClip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, mode]);

  /* ── Hold: the original for as long as the button is held ── */

  useEffect(() => {
    if (!holding) return;
    const stop = () => setHolding(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, [holding]);

  const box = (children: ReactNode, ref?: React.Ref<HTMLDivElement>) => (
    <div
      ref={ref}
      className="relative m-auto shrink-0 select-none bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2),0_8px_24px_-8px_rgba(0,0,0,0.25)]"
      data-backdrop={checkerboard ? 'checkerboard' : 'white'}
      style={checkerboard ? { width, height, ...CHECKERBOARD } : { width, height }}
    >
      {children}
    </div>
  );

  const img = (image: CompareImage, testId: string, style?: React.CSSProperties) => (
    <img
      src={image.src}
      alt={image.alt}
      data-testid={testId}
      draggable={false}
      className="pointer-events-none absolute inset-0 block size-full object-contain"
      style={style}
    />
  );

  const viewport = (ref: React.Ref<HTMLDivElement>, label: string, children: ReactNode, onScroll?: () => void) => (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      tabIndex={zoom === 'fit' ? -1 : 0}
      data-testid="compare-viewport"
      onScroll={onScroll}
      className="grid size-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      style={{ padding: PADDING }}
    >
      {children}
    </div>
  );

  let body: ReactNode = null;
  if (ready && !before) {
    body = viewport(
      splitViewportRef,
      beforeLabel,
      box(
        <span data-testid="compare-loading" className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
          {placeholder}
        </span>,
      ),
    );
  } else if (ready && before && !after) {
    body = viewport(splitViewportRef, beforeLabel, box(content ?? img(before, 'compare-before')));
  } else if (ready && before && after && mode === 'side') {
    body = (
      <div className="grid size-full grid-cols-2" style={{ gap: GAP }}>
        <div className="relative min-w-0 overflow-hidden rounded-md">
          <span className={cn(chip, 'left-2')}>{beforeLabel}</span>
          {viewport(leftRef, beforeLabel, box(img(before, 'compare-before')), () => sync(leftRef.current, rightRef.current))}
        </div>
        <div className="relative min-w-0 overflow-hidden rounded-md">
          <span className={cn(chip, 'left-2')}>{afterLabel}</span>
          {viewport(rightRef, afterLabel, box(img(after, 'compare-after')), () => sync(rightRef.current, leftRef.current))}
        </div>
      </div>
    );
  } else if (ready && before && after) {
    const clip =
      mode === 'hold' ? (holding ? 'inset(0 0 0 100%)' : 'inset(0 0 0 0)') : `inset(0 0 0 ${Math.round(clipPx * 100) / 100}px)`;
    body = (
      <>
        {mode === 'split' ? (
          <>
            <span className={cn(chip, 'left-2')}>{beforeLabel}</span>
            <span className={cn(chip, 'right-2')}>{afterLabel}</span>
          </>
        ) : (
          <span className={cn(chip, 'left-2')} data-testid="compare-showing">
            {holding ? beforeLabel : afterLabel}
          </span>
        )}
        {viewport(
          splitViewportRef,
          `${beforeLabel} and ${afterLabel}`,
          box(
            <>
              {img(before, 'compare-before')}
              {img(after, 'compare-after', { clipPath: clip, WebkitClipPath: clip })}
            </>,
            contentRef,
          ),
          () => requestAnimationFrame(updateClip),
        )}
        {mode === 'split' && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Divider: ${beforeLabel} on the left, ${afterLabel} on the right`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(divider * 100)}
            tabIndex={0}
            data-testid="compare-divider"
            onKeyDown={onDividerKey}
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerUp}
            className="group absolute inset-y-0 z-10 flex w-11 -translate-x-1/2 cursor-ew-resize touch-none justify-center outline-none"
            style={{ left: `${divider * 100}%` }}
          >
            <span className="h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" aria-hidden="true" />
            <span
              className="absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-black/20 bg-white text-xs text-neutral-700 shadow group-focus-visible:ring-2 group-focus-visible:ring-[var(--color-primary)]"
              aria-hidden="true"
            >
              ⇔
            </span>
          </div>
        )}
        {mode === 'hold' && (
          <button
            type="button"
            data-testid="compare-hold"
            aria-pressed={holding}
            onPointerDown={(e) => {
              e.preventDefault();
              setHolding(true);
            }}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault();
                setHolding(true);
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') setHolding(false);
            }}
            onBlur={() => setHolding(false)}
            className="absolute bottom-3 left-1/2 z-10 h-9 -translate-x-1/2 touch-none select-none rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-xs font-medium text-[var(--color-text-primary)] shadow"
          >
            {holding ? `Showing the ${beforeLabel.toLowerCase()}` : `Hold to see the ${beforeLabel.toLowerCase()}`}
          </button>
        )}
      </>
    );
  }

  return (
    <div
      className={cn('flex size-full flex-col', className)}
      data-testid="compare-view"
      data-mode={comparing ? mode : 'single'}
      data-zoom={zoom}
    >
      <div
        role="toolbar"
        aria-label="Compare view"
        className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 sm:px-3"
      >
        {toolbarStart}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {comparing && (
            <div role="group" aria-label="How to compare" className="flex rounded-lg border border-[var(--color-border)] p-0.5">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  title={m.title}
                  aria-pressed={mode === m.value}
                  data-testid={`compare-mode-${m.value}`}
                  onClick={() => setMode(m.value)}
                  className={cn(toolButton, mode === m.value && pressed)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          <div role="group" aria-label="Zoom" className="flex rounded-lg border border-[var(--color-border)] p-0.5">
            {ZOOMS.map((z) => (
              <button
                key={z.id}
                type="button"
                aria-pressed={zoom === z.value}
                data-testid={`compare-zoom-${z.id}`}
                onClick={() => setZoom(z.value)}
                className={cn(toolButton, zoom === z.value && pressed)}
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={areaRef} className="relative min-h-0 flex-1 bg-[var(--color-background)]">
        {body}
        {busy && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center" aria-hidden="true">
            <span className="rounded-full bg-black/65 px-3 py-1 text-xs font-medium text-white">Updating…</span>
          </div>
        )}
      </div>
    </div>
  );
}
