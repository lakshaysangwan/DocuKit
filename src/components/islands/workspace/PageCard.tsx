import type { PointerEventHandler, ReactNode } from 'react';
import { useSortable, type AnimateLayoutChanges } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, ZoomIn } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PageCardProps {
  id: string;
  /** The file this page comes from. Names the card's buttons and its `data-filename`. */
  name: string;
  /** What the buttons call this page, when the file name alone is not enough: "A · page 2 (a.pdf)". */
  itemLabel?: string;
  /** Drawn in the button row, between the handle and the buttons: a tag saying where the page is from. */
  badge?: ReactNode;
  /** The remove button's verb: "Remove" (the default), "Leave out". */
  removeVerb?: string;
  /** The card's test id. Defaults to `file-card`. */
  testId?: string;
  /** Zero-based position, and how many pages there are: "Page 2 of 5". */
  index: number;
  total: number;
  /** Width ÷ height of the page, so it can be fitted into the card. */
  aspect: number;
  /** A third line under the name: "210 × 297 mm". An empty string keeps the line, blank. */
  detail?: string;
  /** The page itself. It is given a box of the page's proportions; fill its width. */
  children: ReactNode;
  /** Show the reorder handle and let the card be dragged. */
  sortable?: boolean;
  onRemove?: () => void;
  /** Show the page large. */
  onOpen?: () => void;
  /** Smaller buttons, for the smallest grid size. */
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Every card's picture area has this shape, whatever page is in it, so the grid
 * stays a grid when portrait and landscape pages are mixed.
 */
export const CARD_FRAME_ASPECT = 1 / 1.3;

const cardButton =
  'flex shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50';

const animateLayoutChanges: AnimateLayoutChanges = (args) => !(args.isSorting || args.wasDragging);

/**
 * One page in a `PageGrid`: its buttons in a row on top — reorder, view large,
 * remove — then the page at its true proportions with nothing drawn over it,
 * then "Page 2 of 5" and the file it comes from. The buttons are always
 * visible; nothing waits for a hover.
 *
 * With a mouse the page itself can also be clicked (view large) and dragged
 * (reorder). The handle reorders with a mouse, a finger, or the keyboard: Space
 * to pick up, arrows to move, Space to drop, Esc to cancel.
 *
 * Test ids: `file-card` (with `data-filename`), `page-thumb`, `page-label`,
 * `page-detail`, `page-reorder`, `page-open`, `file-remove`.
 */
export default function PageCard({
  id,
  name,
  itemLabel = name,
  badge,
  removeVerb = 'Remove',
  testId = 'file-card',
  index,
  total,
  aspect,
  detail,
  children,
  sortable = false,
  onRemove,
  onOpen,
  compact = false,
  disabled = false,
}: PageCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges,
    disabled: !sortable || disabled,
  });

  // The largest box of the page's proportions that fits the picture area.
  const width = Math.min(1, aspect / CARD_FRAME_ASPECT) * 100;
  const dragByPage =
    sortable && !disabled ? (listeners?.onPointerDown as PointerEventHandler<HTMLDivElement> | undefined) : undefined;
  const buttonSize = compact ? 'size-7' : 'size-8';

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={testId}
      data-filename={name}
      data-page-id={id}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'relative flex flex-col rounded-xl border bg-[var(--color-surface)]',
        isDragging
          ? 'z-10 border-[var(--color-primary)] shadow-2xl'
          : 'border-[var(--color-border)] shadow-[var(--shadow-card)]',
      )}
    >
      <div className={cn('flex items-center justify-between', compact ? 'gap-0.5 p-1' : 'gap-1 p-1.5')}>
        {sortable ? (
          <button
            type="button"
            data-testid="page-reorder"
            aria-label={`Reorder ${itemLabel}`}
            className={cn(cardButton, buttonSize, 'cursor-grab touch-none active:cursor-grabbing')}
            {...attributes}
            {...listeners}
            disabled={disabled}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        {badge}
        <div className={cn('flex', compact ? 'gap-0.5' : 'gap-1')}>
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              data-testid="page-open"
              aria-label={`View page ${index + 1} larger: ${itemLabel}`}
              className={cn(cardButton, buttonSize)}
            >
              <ZoomIn className="size-4" aria-hidden="true" />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              data-testid="file-remove"
              aria-label={`${removeVerb} ${itemLabel}`}
              className={cn(cardButton, buttonSize, 'hover:text-[var(--color-error)]')}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* The page. For a mouse it is also a shortcut: click to view large, drag
          to reorder. Both have a button above, so it is not a control itself. */}
      <div
        data-testid="page-thumb"
        onClick={onOpen}
        onPointerDown={dragByPage}
        className={cn('bg-[var(--color-background)]', compact ? 'p-1.5' : 'p-2.5', onOpen && 'cursor-zoom-in')}
      >
        <div className="flex w-full items-center justify-center" style={{ aspectRatio: String(CARD_FRAME_ASPECT) }}>
          <div style={{ width: `${width}%` }}>{children}</div>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-0.5 border-t border-[var(--color-border)] px-2.5 py-2">
        <p data-testid="page-label" className="truncate text-xs font-semibold text-[var(--color-text-primary)]">
          Page {index + 1} of {total}
        </p>
        <p className="truncate text-xs text-[var(--color-text-secondary)]" title={name}>
          {name}
        </p>
        {detail !== undefined && (
          <p data-testid="page-detail" className="min-h-4 truncate text-[11px] leading-4 text-[var(--color-text-secondary)]">
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
