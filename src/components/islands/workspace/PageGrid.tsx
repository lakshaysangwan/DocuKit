import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import PageCard, { type PageMark } from './PageCard';
import PagePreviewDialog from './PagePreviewDialog';

export type PageGridSize = 's' | 'm' | 'l';
export type { PageMark };

/** Where a page is being drawn: in its card, or large in the dialog. */
export type PageGridView = 'card' | 'large';

export interface PageGridProps<T extends { id: string }> {
  /** The pages, in document order. */
  items: T[];
  /** The file a page comes from: names its buttons, its card, the reorder announcements. */
  getName: (item: T) => string;
  /** Width ÷ height of the page. */
  getAspect: (item: T, index: number) => number;
  /** Draw the page. It gets a box of the page's proportions; fill its width. */
  renderPage: (item: T, index: number, view: PageGridView) => ReactNode;
  /**
   * What a page is called on its buttons and in reorder announcements, when the
   * file name alone does not say which page it is: "A · page 2 (a.pdf)".
   * Defaults to `getName`.
   */
  getItemLabel?: (item: T, index: number) => string;
  /** A tag drawn before each card's "Page 2 of 5", saying where the page comes from. */
  renderBadge?: (item: T, index: number) => ReactNode;
  /** The remove button's verb. Defaults to "Remove". */
  removeVerb?: string;
  /** Each card's test id. Defaults to `file-card`. */
  cardTestId?: string;
  /** More controls in the toolbar, left of the size buttons ("Reset order"). */
  toolbarExtra?: ReactNode;
  /** A line under the name on each card, and under the title when enlarged. */
  getDetail?: (item: T, index: number) => string | undefined;
  size: PageGridSize;
  onSizeChange: (size: PageGridSize) => void;
  /** Left of the size buttons: what all the pages have in common, "A4 · 210 × 297 mm". */
  caption?: ReactNode;
  /** Leave out to make the order fixed. Called with the id moved and the id it was dropped on. */
  onReorder?: (fromId: string, toId: string) => void;
  /** Leave out to hide the remove buttons. */
  onRemove?: (id: string) => void;
  /** Freeze reordering and removing (while a job runs). Viewing still works. */
  disabled?: boolean;
  /** Names the list for assistive tech. Defaults to "Pages". */
  label?: string;
  /** What will happen to each page: a tag on its card, and how it is drawn. */
  getMark?: (item: T, index: number) => PageMark | undefined;
  /**
   * Make each page a toggle: clicking it (or Space / Enter on it) selects or
   * deselects it, and "view large" stays on its button. Leave out for pages
   * that are only looked at.
   */
  selection?: {
    isSelected: (item: T, index: number) => boolean;
    /** `shiftKey`: the click was a Shift-click (extend a range). */
    onToggle: (item: T, index: number, modifiers: { shiftKey: boolean }) => void;
    /** The toggle's accessible name. Defaults to "Page 2". */
    getLabel?: (item: T, index: number) => string;
    getTestId?: (item: T, index: number) => string;
  };
  /**
   * A full-width row before a card, to start a new group ("PDF 2 · pages 3–4").
   * Return null where no group starts. It is decoration: say the same on the
   * cards (with `getMark`) for assistive tech.
   */
  renderDivider?: (item: T, index: number) => ReactNode;
  /** Show the file name on every card. Off when all pages come from one file. Defaults to true. */
  showNames?: boolean;
  /** More buttons on each card, in a row under the page (see `PageCard`'s `actions`). */
  renderActions?: (item: T, index: number) => ReactNode;
  /** Every card button at least 44px square on a touch screen. */
  largeTouchTargets?: boolean;
  /**
   * The enlarged page lays itself out in the dialog's whole area: `renderPage`
   * with view `'large'` then draws its own zoom and scrolling. See
   * `PagePreviewDialog`'s `fill`.
   */
  previewFill?: boolean;
}

const SIZES: { value: PageGridSize; text: string; name: string }[] = [
  { value: 's', text: 'S', name: 'Small pages' },
  { value: 'm', text: 'M', name: 'Medium pages' },
  { value: 'l', text: 'L', name: 'Large pages' },
];

/** The narrowest a card gets at each size; the grid fits as many columns as it can. */
const CARD_MIN: Record<PageGridSize, string> = {
  s: '[--page-card:96px] sm:[--page-card:120px]',
  m: '[--page-card:150px] sm:[--page-card:190px]',
  l: '[--page-card:280px] sm:[--page-card:300px]',
};

/**
 * The document pane for tools that build or arrange a document: every page, in
 * order, at its true proportions.
 *
 *   • S / M / L changes how many fit across.
 *   • Each card says "Page 2 of 5" and which file it is.
 *   • Reorder by dragging a page, or with the handle and the keyboard; every
 *     move is announced by file name and position.
 *   • Click a page to see it large, with Previous / Next — or, with
 *     `selection`, click it to pick it (its button still shows it large).
 *   • Optionally, each page says what will happen to it (`getMark`) and groups
 *     can be set apart by a full-width divider (`renderDivider`).
 *
 * It fills its container (give it a positioned parent, as `ToolWorkspace`'s
 * stage is) and scrolls inside itself.
 *
 * Test ids: `page-grid-toolbar`, `page-grid-caption`, `grid-size-s|m|l`,
 * `page-grid`, and the ids of `PageCard` and `PagePreviewDialog`.
 */
export default function PageGrid<T extends { id: string }>({
  items,
  getName,
  getAspect,
  renderPage,
  getDetail,
  getItemLabel,
  renderBadge,
  removeVerb,
  cardTestId,
  toolbarExtra,
  size,
  onSizeChange,
  caption,
  onReorder,
  onRemove,
  disabled = false,
  label = 'Pages',
  getMark,
  selection,
  renderDivider,
  showNames = true,
  renderActions,
  largeTouchTargets = false,
  previewFill = false,
}: PageGridProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // The page last shown large: where focus goes back to when the dialog closes.
  const lastOpenId = useRef<string | null>(null);
  const show = useCallback((id: string) => {
    lastOpenId.current = id;
    setOpenId(id);
  }, []);
  const openIndex = openId === null ? -1 : items.findIndex((item) => item.id === openId);
  const openItem = openIndex === -1 ? null : items[openIndex];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (over && active.id !== over.id) onReorder?.(String(active.id), String(over.id));
    },
    [onReorder],
  );

  // Announcements name the real file and its 1-based position, so reordering
  // with the keyboard is narrated in the visitor's terms.
  const nameOf = (id: string | number) => {
    const index = items.findIndex((i) => i.id === String(id));
    if (index === -1) return 'page';
    return getItemLabel ? getItemLabel(items[index], index) : getName(items[index]);
  };
  const positionOf = (id: string | number) => items.findIndex((i) => i.id === String(id)) + 1;
  type Ids = { active: { id: string | number }; over: { id: string | number } | null };
  const announcements = {
    onDragStart: ({ active }: Pick<Ids, 'active'>) =>
      `Picked up ${nameOf(active.id)}. Position ${positionOf(active.id)} of ${items.length}.`,
    onDragOver: ({ active, over }: Ids) =>
      over ? `${nameOf(active.id)} moved to position ${positionOf(over.id)} of ${items.length}.` : undefined,
    onDragEnd: ({ active, over }: Ids) =>
      over
        ? `${nameOf(active.id)} dropped at position ${positionOf(over.id)} of ${items.length}.`
        : `${nameOf(active.id)} dropped.`,
    onDragCancel: ({ active }: Pick<Ids, 'active'>) =>
      `Reordering cancelled. ${nameOf(active.id)} returned to its original position.`,
  };
  const screenReaderInstructions = {
    draggable:
      'To reorder this page, press Space or Enter to pick it up, use the arrow keys to move it, ' +
      'and press Space or Enter again to drop it. Press Escape to cancel.',
  };

  const sortable = !!onReorder && items.length > 1;

  return (
    <div ref={rootRef} className="absolute inset-0 flex flex-col">
      <div
        data-testid="page-grid-toolbar"
        className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4"
      >
        <p data-testid="page-grid-caption" className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">
          {caption}
        </p>
        {toolbarExtra}
        <div role="group" aria-label="Size of the pages on screen" className="flex shrink-0 gap-1">
          {SIZES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSizeChange(option.value)}
              aria-pressed={size === option.value}
              aria-label={option.name}
              title={option.name}
              data-testid={`grid-size-${option.value}`}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg border text-xs font-semibold transition-colors',
                size === option.value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background)]',
              )}
            >
              {option.text}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-2 sm:p-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions }}
        >
          <SortableContext items={items.map((item) => item.id)} strategy={rectSortingStrategy}>
            <ul
              role="list"
              aria-label={label}
              data-testid="page-grid"
              data-size={size}
              className={cn(
                'grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--page-card)),1fr))] gap-2 sm:gap-3',
                CARD_MIN[size],
              )}
            >
              {items.map((item, index) => {
                const divider = renderDivider?.(item, index);
                return (
                  <Fragment key={item.id}>
                    {divider ? (
                      <li aria-hidden="true" data-testid="page-grid-divider" className="col-span-full">
                        {divider}
                      </li>
                    ) : null}
                    <li className="min-w-0">
                      <PageCard
                        id={item.id}
                        name={getName(item)}
                        itemLabel={getItemLabel?.(item, index)}
                        badge={renderBadge?.(item, index)}
                        removeVerb={removeVerb}
                        testId={cardTestId}
                        index={index}
                        total={items.length}
                        aspect={getAspect(item, index)}
                        // With details on, every card keeps the line, so a row stays level.
                        detail={getDetail ? (getDetail(item, index) ?? '') : undefined}
                        sortable={sortable}
                        compact={size === 's'}
                        onRemove={onRemove ? () => onRemove(item.id) : undefined}
                        onOpen={() => show(item.id)}
                        disabled={disabled}
                        mark={getMark?.(item, index)}
                        select={
                          selection
                            ? {
                                selected: selection.isSelected(item, index),
                                onToggle: (modifiers) => selection.onToggle(item, index, modifiers),
                                label: selection.getLabel?.(item, index) ?? `Page ${index + 1}`,
                                testId: selection.getTestId?.(item, index),
                              }
                            : undefined
                        }
                        showName={showNames}
                        actions={renderActions?.(item, index)}
                        largeTouchTargets={largeTouchTargets}
                      >
                        {renderPage(item, index, 'card')}
                      </PageCard>
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      </div>

      <PagePreviewDialog
        open={openItem !== null}
        onClose={() => setOpenId(null)}
        title={openItem ? `Page ${openIndex + 1} of ${items.length} · ${getName(openItem)}` : ''}
        detail={openItem ? getDetail?.(openItem, openIndex) : undefined}
        aspect={openItem ? getAspect(openItem, openIndex) : 1}
        fill={previewFill}
        onPrevious={openIndex > 0 ? () => show(items[openIndex - 1].id) : undefined}
        onNext={openIndex !== -1 && openIndex < items.length - 1 ? () => show(items[openIndex + 1].id) : undefined}
        // Back to the card of the page that was on show, which paging may have changed.
        returnFocus={() =>
          lastOpenId.current === null
            ? null
            : (rootRef.current?.querySelector<HTMLElement>(
                `[data-page-id="${CSS.escape(lastOpenId.current)}"] [data-testid="page-open"]`,
              ) ?? null)
        }
      >
        {openItem ? renderPage(openItem, openIndex, 'large') : null}
      </PagePreviewDialog>
    </div>
  );
}
