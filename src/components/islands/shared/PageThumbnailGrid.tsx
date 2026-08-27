import { Fragment, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import type { ThumbnailResult } from '@/hooks/use-pdf-thumbnails';

export interface PageItem {
  id: string;
  // 0-based index in the source document, or BLANK_PAGE for an inserted blank.
  originalIndex: number;
  rotation: number;      // 0 | 90 | 180 | 270
  deleted?: boolean;
}

/** Sentinel `originalIndex` marking a page that isn't in the source document. */
export const BLANK_PAGE = -1;

interface PageThumbnailGridProps {
  pages: PageItem[];
  thumbnails: ThumbnailResult[];
  selectedIds: Set<string>;
  onSelect: (id: string, mode: 'single' | 'toggle' | 'range') => void;
  onReorder: (fromId: string, toId: string) => void;
  onRotate: (id: string, direction: 'cw' | 'ccw') => void;
  onDelete: (id: string) => void;
  /** Omit to hide the per-page duplicate control. */
  onDuplicate?: (id: string) => void;
  /** Called with the position to insert at. Omit to hide the "+" affordances. */
  onInsertBlank?: (position: number) => void;
  thumbnailSize?: number;
  className?: string;
}

interface ThumbnailCardProps {
  page: PageItem;
  thumbnail?: ThumbnailResult;
  isSelected: boolean;
  onSelect: (mode: 'single' | 'toggle' | 'range') => void;
  onRotate: (direction: 'cw' | 'ccw') => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  size: number;
}

function ThumbnailCard({
  page,
  thumbnail,
  isSelected,
  onSelect,
  onRotate,
  onDelete,
  onDuplicate,
  size,
}: ThumbnailCardProps) {
  const isBlank = page.originalIndex === BLANK_PAGE;
  const label = isBlank ? 'Blank page' : `Page ${page.originalIndex + 1}`;

  // Disable layout animation while actively dragging to prevent jitter
  const animateLayoutChanges: AnimateLayoutChanges = (args) =>
    args.isSorting || args.wasDragging ? false : true;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
    animateLayoutChanges,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    width: size,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="page-thumb"
      data-page-index={page.originalIndex}
      data-blank={isBlank ? 'true' : undefined}
      className={cn(
        'group relative flex cursor-pointer flex-col items-center gap-1.5 rounded-lg p-2',
        'border-2 transition-colors duration-100',
        isSelected
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
          : 'border-transparent hover:border-[var(--color-border)]'
      )}
      onClick={(e) => {
        if (e.shiftKey) onSelect('range');
        else if (e.ctrlKey || e.metaKey) onSelect('toggle');
        else onSelect('single');
      }}
      onContextMenu={(e) => { e.preventDefault(); }}
      role="checkbox"
      aria-checked={isSelected}
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect('toggle'); }
      }}
    >
      {/* Drag handle overlay.
          It covers the whole card, so it must NOT swallow clicks: doing that
          silently disabled click-to-select (including Ctrl/Shift multi-select),
          since every click landed here instead of the card. dnd-kit's pointer
          sensor has a 5px activation distance, so a click without movement never
          starts a drag and can safely fall through to the card's handler. */}
      <div
        className="absolute inset-0 z-10 cursor-grab touch-none rounded-lg opacity-0 group-hover:opacity-100 active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      />

      {/* Thumbnail */}
      <div
        className="relative overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]"
        style={{ width: size - 20, height: Math.round((size - 20) * 1.4) }}
      >
        {isBlank ? (
          <div className="flex h-full w-full items-center justify-center bg-white text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            Blank
          </div>
        ) : thumbnail ? (
          <img
            src={thumbnail.dataUrl}
            alt={label}
            className="h-full w-full object-contain"
            style={{ transform: `rotate(${page.rotation}deg)`, transition: 'transform 0.2s' }}
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
        )}

        {/* Hover controls */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
          {!isBlank && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onRotate('ccw'); }}
                className="rounded-full bg-white/20 p-1 text-white hover:bg-white/40"
                title="Rotate counter-clockwise"
                aria-label="Rotate counter-clockwise"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRotate('cw'); }}
                className="rounded-full bg-white/20 p-1 text-white hover:bg-white/40"
                title="Rotate clockwise"
                aria-label="Rotate clockwise"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </button>
            </>
          )}
          {onDuplicate && (
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              data-testid="duplicate-page"
              className="rounded-full bg-white/20 p-1 text-white hover:bg-white/40"
              title={`Duplicate ${label.toLowerCase()}`}
              aria-label={`Duplicate ${label.toLowerCase()}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h9a2 2 0 012 2v9a2 2 0 01-2 2h-2M5 9h9a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="rounded-full bg-red-500/80 p-1 text-white hover:bg-red-500"
            title="Delete page"
            aria-label="Delete page"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Selection checkbox */}
        {isSelected && (
          <div className="absolute left-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary)] text-white">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
        )}
      </div>

      {/* Page number */}
      <span className="text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
        {isBlank ? '—' : page.originalIndex + 1}
      </span>
    </div>
  );
}

/** Thin "+" affordance sitting between two thumbnails. */
function InsertBlankButton({ position, height, onInsert }: {
  position: number;
  height: number;
  onInsert: (position: number) => void;
}) {
  return (
    <button
      type="button"
      data-testid="insert-blank"
      data-position={position}
      onClick={() => onInsert(position)}
      style={{ height }}
      className={cn(
        'flex w-5 shrink-0 items-center justify-center self-center rounded',
        'opacity-25 transition-opacity hover:opacity-100 focus-visible:opacity-100'
      )}
      title="Insert a blank page here"
      aria-label={`Insert a blank page at position ${position + 1}`}
    >
      <span className="flex h-6 w-4 items-center justify-center rounded bg-[var(--color-primary)] text-sm leading-none text-white">
        +
      </span>
    </button>
  );
}

export default function PageThumbnailGrid({
  pages,
  thumbnails,
  selectedIds,
  onSelect,
  onReorder,
  onRotate,
  onDelete,
  onDuplicate,
  onInsertBlank,
  thumbnailSize = 120,
  className,
}: PageThumbnailGridProps) {
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Match the thumbnail box so the "+" columns line up with the cards.
  const cardHeight = Math.round((thumbnailSize - 20) * 1.4);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (over && active.id !== over.id) {
        onReorder(String(active.id), String(over.id));
      }
    },
    [onReorder]
  );

  const handleSelect = useCallback(
    (id: string, mode: 'single' | 'toggle' | 'range') => {
      if (mode === 'range' && lastSelectedId) {
        const fromIdx = pages.findIndex((p) => p.id === lastSelectedId);
        const toIdx = pages.findIndex((p) => p.id === id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
          // 'range' adds; toggling here would *deselect* any page in the swept
          // range that was already selected, which is not what Shift+click means.
          pages.slice(start, end + 1).forEach((p) => onSelect(p.id, 'range'));
          return;
        }
      }
      setLastSelectedId(id);
      onSelect(id, mode);
    },
    [pages, lastSelectedId, onSelect]
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
        <div
          className={cn('flex flex-wrap gap-2', className)}
          role="group"
          aria-label={`${pages.length} pages, ${selectedIds.size} selected`}
        >
          {pages.map((page, i) => {
            const thumbnail = thumbnails.find((t) => t.pageIndex === page.originalIndex);
            return (
              <Fragment key={page.id}>
                {onInsertBlank && (
                  <InsertBlankButton position={i} height={cardHeight} onInsert={onInsertBlank} />
                )}
                <ThumbnailCard
                  page={page}
                  thumbnail={thumbnail}
                  isSelected={selectedIds.has(page.id)}
                  onSelect={(mode) => handleSelect(page.id, mode)}
                  onRotate={(dir) => onRotate(page.id, dir)}
                  onDelete={() => onDelete(page.id)}
                  onDuplicate={onDuplicate ? () => onDuplicate(page.id) : undefined}
                  size={thumbnailSize}
                />
              </Fragment>
            );
          })}
          {onInsertBlank && pages.length > 0 && (
            <InsertBlankButton position={pages.length} height={cardHeight} onInsert={onInsertBlank} />
          )}
        </div>
      </SortableContext>

      {/* Drag overlay — renders a floating copy of the dragged card for smooth visuals */}
      <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
        {activeId ? (() => {
          const page = pages.find((p) => p.id === activeId);
          if (!page) return null;
          const thumbnail = thumbnails.find((t) => t.pageIndex === page.originalIndex);
          return (
            <div
              style={{ width: thumbnailSize }}
              className="rounded-lg border-2 border-[var(--color-primary)] bg-[var(--color-surface)] p-2 shadow-xl"
            >
              <div
                className="overflow-hidden rounded-md border border-[var(--color-border)]"
                style={{ width: thumbnailSize - 20, height: Math.round((thumbnailSize - 20) * 1.4) }}
              >
                {thumbnail ? (
                  <img
                    src={thumbnail.dataUrl}
                    alt={`Page ${page.originalIndex + 1}`}
                    className="h-full w-full object-contain"
                    style={{ transform: `rotate(${page.rotation}deg)` }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                    <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="mt-1.5 text-center text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
                {page.originalIndex + 1}
              </div>
            </div>
          );
        })() : null}
      </DragOverlay>
    </DndContext>
  );
}
