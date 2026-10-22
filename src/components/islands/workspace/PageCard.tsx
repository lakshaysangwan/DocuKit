import type { PointerEventHandler, ReactNode } from 'react';
import { useSortable, type AnimateLayoutChanges } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, ZoomIn } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * What will happen to a page, shown on its card: a tag ("PDF 2", "Removed") and
 * how the page is drawn. Colour is never the only signal — a colour always
 * comes with its label.
 */
export interface PageMark {
  /** The tag at the top of the card. */
  label?: string;
  /** A CSS colour for the tag and the card's top edge: the page's group. */
  colour?: string;
  /**
   * `selected`  outlined in the primary colour.
   * `dimmed`    faded: the page goes nowhere.
   * `removed`   faded and edged in red: the page is taken out.
   */
  state?: 'selected' | 'dimmed' | 'removed';
}

/** Makes the page itself a toggle (pick pages), instead of "view large". */
export interface PageSelect {
  selected: boolean;
  /** Called with the click's modifier keys, so Shift-click can pick a range. */
  onToggle: (modifiers: { shiftKey: boolean }) => void;
  /** The toggle's accessible name: "Page 2". Its state is `aria-pressed`. */
  label: string;
  /** The toggle's test id. */
  testId?: string;
}

export interface PageCardProps {
  id: string;
  /** The file this page comes from. Names the card's buttons and its `data-filename`. */
  name: string;
  /** What the buttons call this page, when the file name alone is not enough: "A · page 2 (a.pdf)". */
  itemLabel?: string;
  /** Drawn before "Page 2 of 5": a tag saying where the page is from. */
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
  /** What will happen to this page. */
  mark?: PageMark;
  /** Clicking the page selects it; "view large" stays on its button. */
  select?: PageSelect;
  /** Show the file name line. Off when every page comes from the same file. Defaults to true. */
  showName?: boolean;
  /**
   * More buttons for this page, in a row of their own under it ("Rotate left",
   * "Duplicate"). Always visible, like the rest. Style them with
   * `pageCardButtonClass`.
   */
  actions?: ReactNode;
  /** Make every button on the card at least 44px square on a touch screen. */
  largeTouchTargets?: boolean;
}

/**
 * Every card's picture area has this shape, whatever page is in it, so the grid
 * stays a grid when portrait and landscape pages are mixed.
 */
export const CARD_FRAME_ASPECT = 1 / 1.3;

/** The look of a card's buttons, for callers adding their own with `actions`. */
export const pageCardButtonClass =
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
 * With `mark` the card carries a tag ("PDF 2") and is drawn as selected, faded
 * or removed. With `select` the page itself is a toggle button (pick pages), so
 * a click selects rather than enlarges. A card has a tag or a reorder handle,
 * not both.
 *
 * Test ids: `file-card` (with `data-filename`, and `data-mark` /
 * `data-mark-state` when marked), `page-thumb`, `page-mark`, `page-label`,
 * `page-detail`, `page-reorder`, `page-open`, `file-remove`, `page-actions`.
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
  mark,
  select,
  showName = true,
  actions,
  largeTouchTargets = false,
}: PageCardProps) {
  const cardButton = pageCardButtonClass;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges,
    disabled: !sortable || disabled,
  });

  // The largest box of the page's proportions that fits the picture area.
  const width = Math.min(1, aspect / CARD_FRAME_ASPECT) * 100;
  const dragByPage =
    sortable && !disabled ? (listeners?.onPointerDown as PointerEventHandler<HTMLDivElement> | undefined) : undefined;
  const buttonSize = cn(compact ? 'size-7' : 'size-8', largeTouchTargets && 'pointer-coarse:size-11');

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(mark?.colour ? { borderTopColor: mark.colour, borderTopWidth: 4 } : {}),
      }}
      data-testid={testId}
      data-filename={name}
      data-page-id={id}
      data-dragging={isDragging ? 'true' : undefined}
      data-mark={mark?.label}
      data-mark-state={mark?.state}
      className={cn(
        'relative flex flex-col rounded-xl border bg-[var(--color-surface)]',
        isDragging
          ? 'z-10 border-[var(--color-primary)] shadow-2xl'
          : mark?.state === 'selected'
            ? 'border-[var(--color-primary)] shadow-[var(--shadow-card)] ring-2 ring-[var(--color-primary)]'
            : mark?.state === 'removed'
              ? 'border-dashed border-[var(--color-error)] shadow-[var(--shadow-card)]'
              : 'border-[var(--color-border)] shadow-[var(--shadow-card)]',
      )}
    >
      <div
        className={cn(
          'flex min-h-0 items-center justify-between',
          // Big touch targets may not fit one row on a narrow card: wrap rather than overflow.
          largeTouchTargets && 'flex-wrap',
          compact ? 'gap-0.5 p-1' : 'gap-1 p-1.5',
        )}
      >
        {mark?.label && !sortable ? (
          <span
            data-testid="page-mark"
            className={cn(
              'inline-flex min-w-0 items-center truncate rounded-md px-1.5 font-semibold leading-none',
              compact ? 'h-7 px-1 text-[10px]' : 'h-8 text-xs',
              mark.colour
                ? 'text-white'
                : mark.state === 'selected'
                  ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                  : mark.state === 'removed'
                    ? 'bg-[var(--color-error)]/10 text-[var(--color-error)]'
                    : 'bg-[var(--color-background)] text-[var(--color-text-secondary)]',
            )}
            style={mark.colour ? { backgroundColor: mark.colour } : undefined}
          >
            <span className="truncate">{mark.label}</span>
          </span>
        ) : sortable ? (
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
        <div className={cn('flex', largeTouchTargets && 'flex-wrap', compact ? 'gap-0.5' : 'gap-1')}>
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
      {(() => {
        const faded = mark?.state === 'dimmed' || mark?.state === 'removed';
        const picture = (
          <div
            data-testid="page-thumb"
            onClick={select ? undefined : onOpen}
            onPointerDown={dragByPage}
            className={cn(
              'bg-[var(--color-background)]',
              compact ? 'p-1.5' : 'p-2.5',
              select ? 'cursor-pointer' : onOpen && 'cursor-zoom-in',
            )}
          >
            <div className="flex w-full items-center justify-center" style={{ aspectRatio: String(CARD_FRAME_ASPECT) }}>
              <div style={{ width: `${width}%` }} className={cn(faded && 'opacity-40 grayscale')}>
                {children}
              </div>
            </div>
          </div>
        );
        // Picking pages: the page is the toggle. Its state is aria-pressed, and
        // "view large" stays on the button above.
        return select ? (
          <button
            type="button"
            onClick={(event) => select.onToggle({ shiftKey: event.shiftKey })}
            disabled={disabled}
            aria-pressed={select.selected}
            aria-label={select.label}
            data-testid={select.testId}
            className="block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed"
          >
            {picture}
          </button>
        ) : (
          picture
        );
      })()}

      {actions && (
        <div
          data-testid="page-actions"
          className={cn(
            'flex flex-wrap items-center justify-center border-t border-[var(--color-border)]',
            compact ? 'gap-0.5 p-1' : 'gap-1 p-1.5',
          )}
        >
          {actions}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-0.5 border-t border-[var(--color-border)] px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {badge}
          <p data-testid="page-label" className="truncate text-xs font-semibold text-[var(--color-text-primary)]">
            Page {index + 1} of {total}
          </p>
        </div>
        {showName && (
          <p className="truncate text-xs text-[var(--color-text-secondary)]" title={name}>
            {name}
          </p>
        )}
        {detail !== undefined && (
          <p data-testid="page-detail" className="min-h-4 truncate text-[11px] leading-4 text-[var(--color-text-secondary)]">
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
