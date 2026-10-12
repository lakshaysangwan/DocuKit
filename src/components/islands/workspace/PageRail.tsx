import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import { PRIORITY_VISIBLE } from '@/lib/pdf/render-scheduler';
import { usePageThumb } from '@/hooks/use-page-thumb';
import { cn } from '@/lib/utils';

export interface PageRailProps {
  doc: PdfDocHandle | null;
  /** Zero-based index of the page shown in the viewer. */
  current: number;
  onSelect: (pageIndex: number) => void;
  /** A marker for a page — a tick, a count. Rendered in the thumbnail's corner. */
  renderBadge?: (pageIndex: number) => ReactNode;
  /** Names the list for assistive tech. Defaults to "Pages". */
  label?: string;
}

/** Every item is this tall, which is what lets only the visible ones be mounted. */
const ITEM_HEIGHT = 132;
const THUMB_WIDTH = 80;
const THUMB_HEIGHT = 104;
/** Items mounted beyond each edge of the visible window. */
const OVERSCAN = 3;
/** Thumbnails are asked for at twice their CSS size, for sharp high-density screens. */
const THUMB_LONG_EDGE = THUMB_HEIGHT * 2;

interface ItemProps {
  doc: PdfDocHandle;
  pageIndex: number;
  selected: boolean;
  onSelect: (pageIndex: number) => void;
  badge?: ReactNode;
}

function RailItem({ doc, pageIndex, selected, onSelect, badge }: ItemProps) {
  const src = usePageThumb(doc, pageIndex, THUMB_LONG_EDGE, { priority: PRIORITY_VISIBLE });
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={`Page ${pageIndex + 1}`}
      tabIndex={selected ? 0 : -1}
      data-testid={`rail-page-${pageIndex + 1}`}
      data-selected={selected ? 'true' : 'false'}
      onClick={() => onSelect(pageIndex)}
      className="absolute left-0 flex w-full flex-col items-center gap-1 pt-2"
      style={{ top: pageIndex * ITEM_HEIGHT, height: ITEM_HEIGHT }}
    >
      <span
        className={cn(
          'relative flex items-center justify-center rounded-md border-2 bg-white',
          selected
            ? 'border-[var(--color-primary)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary)_25%,transparent)]'
            : 'border-[var(--color-border)]',
        )}
        style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
      >
        {src ? (
          <img src={src} alt="" draggable={false} className="block max-h-full max-w-full object-contain" />
        ) : (
          <span className="size-full animate-pulse rounded bg-neutral-200" aria-hidden="true" />
        )}
        {badge && <span className="absolute -right-1.5 -top-1.5">{badge}</span>}
      </span>
      <span
        className={cn(
          'text-xs tabular-nums',
          selected ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]',
        )}
        aria-hidden="true"
      >
        {pageIndex + 1}
      </span>
    </button>
  );
}

/**
 * The page thumbnails beside the viewer.
 *
 * Only the items in (and just around) the visible part of the list are mounted,
 * and each asks the document handle for its own thumbnail, so a 200-page file
 * costs a dozen small renders, not two hundred. A listbox: Up / Down, Home and
 * End move between pages.
 *
 * Test ids: `page-rail`, `rail-page-<n>` (one-based).
 */
export default function PageRail({ doc, current, onSelect, renderBadge, label = 'Pages' }: PageRailProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const pageCount = doc && !doc.destroyed ? doc.pageCount : 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, []);

  // Keep the current page's thumbnail in view when the page changes elsewhere.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || pageCount === 0) return;
    const top = current * ITEM_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ITEM_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ITEM_HEIGHT - el.clientHeight;
  }, [current, pageCount]);

  const first = Math.max(0, Math.floor(view.top / ITEM_HEIGHT) - OVERSCAN);
  const last = Math.min(pageCount - 1, Math.ceil((view.top + view.height) / ITEM_HEIGHT) + OVERSCAN);
  const indexes: number[] = [];
  for (let i = first; i <= last; i++) indexes.push(i);
  // The selected page is always mounted, so it can always take focus.
  if (pageCount > 0 && current >= 0 && current < pageCount && !indexes.includes(current)) indexes.push(current);

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next = current;
    if (e.key === 'ArrowDown') next = current + 1;
    else if (e.key === 'ArrowUp') next = current - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = pageCount - 1;
    else return;
    e.preventDefault();
    next = Math.min(Math.max(next, 0), pageCount - 1);
    if (next === current) return;
    onSelect(next);
    // Focus follows the selection once the new item is mounted.
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-testid="rail-page-${next + 1}"]`)?.focus();
    });
  };

  return (
    <div ref={scrollRef} data-testid="page-rail" className="h-full overflow-y-auto overscroll-contain">
      <div
        role="listbox"
        aria-label={label}
        aria-orientation="vertical"
        aria-busy={pageCount === 0}
        onKeyDown={onKeyDown}
        className="relative"
        style={{ height: pageCount * ITEM_HEIGHT + 8 }}
      >
        {doc &&
          indexes.map((i) => (
            <RailItem
              key={i}
              doc={doc}
              pageIndex={i}
              selected={i === current}
              onSelect={onSelect}
              badge={renderBadge?.(i)}
            />
          ))}
      </div>
    </div>
  );
}
