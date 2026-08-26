import { useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn, formatBytes } from '@/lib/utils';

export interface FileItem {
  id: string;
  file: File;
  pageCount?: number;
  thumbnailUrl?: string;
  error?: string;
}

interface FileListProps {
  files: FileItem[];
  onReorder: (fromId: string, toId: string) => void;
  onRemove: (id: string) => void;
  /** 'cards' — large portrait preview cards (default, for primary layout)
   *  'rows'  — compact horizontal rows (for sidebar / secondary layout) */
  variant?: 'cards' | 'rows';
  className?: string;
}

// ── Grip icon ────────────────────────────────────────────────────────────────
function GripIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </svg>
  );
}

// ── X icon ────────────────────────────────────────────────────────────────────
function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

// ── Document placeholder ──────────────────────────────────────────────────────
function DocPlaceholder({ pulse = false }: { pulse?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--color-background)]">
      <svg
        className={cn('h-7 w-7 text-[var(--color-text-muted)]', pulse && 'animate-pulse')}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
      {pulse && <span className="text-[10px] text-[var(--color-text-muted)]">Loading…</span>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CARD variant — large portrait document cards
// ────────────────────────────────────────────────────────────────────────────

function SortableCardItem({
  item,
  onRemove,
}: {
  item: FileItem;
  onRemove: (id: string) => void;
}) {
  const animateLayoutChanges: AnimateLayoutChanges = (args) =>
    args.isSorting || args.wasDragging ? false : true;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    animateLayoutChanges,
  });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      aria-label={`${item.file.name}, ${formatBytes(item.file.size)}`}
      data-testid="file-card"
      data-filename={item.file.name}
      className={cn(
        'group relative flex w-[180px] shrink-0 flex-col overflow-hidden rounded-xl',
        'border border-[var(--color-border)] bg-[var(--color-surface)]',
        'transition-all duration-150',
        isDragging
          ? 'opacity-25'
          : 'shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]'
      )}
    >
      {/* Page preview */}
      <div className="relative w-full bg-white" style={{ aspectRatio: '1 / 1.414' }}>
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt={`First page of ${item.file.name}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <DocPlaceholder pulse />
        )}

        {/* Controls float over preview on hover */}
        <div className="absolute inset-0 flex items-start justify-between p-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <button
            className="flex h-6 w-6 cursor-grab touch-none items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm active:cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onRemove(item.id)}
            data-testid="file-remove"
            className="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-red-500/80"
            aria-label={`Remove ${item.file.name}`}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {item.pageCount !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white backdrop-blur-sm">
            {item.pageCount}p
          </span>
        )}
        {item.error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-error)]/10">
            <span className="rounded bg-[var(--color-error)] px-1.5 py-0.5 text-[10px] text-white">Error</span>
          </div>
        )}
      </div>

      {/* Info strip */}
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <p className="truncate text-[12px] font-medium leading-tight text-[var(--color-text-primary)]" title={item.file.name}>
          {item.file.name}
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)]">{formatBytes(item.file.size)}</p>
      </div>
    </div>
  );
}

function CardOverlay({ item }: { item: FileItem }) {
  return (
    <div className="flex w-[180px] shrink-0 flex-col overflow-hidden rounded-xl border-2 border-[var(--color-primary)] bg-[var(--color-surface)] shadow-2xl ring-4 ring-[var(--color-primary)]/20">
      <div className="relative w-full bg-white" style={{ aspectRatio: '1 / 1.414' }}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          <DocPlaceholder />
        )}
        {item.pageCount !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {item.pageCount}p
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <p className="truncate text-[12px] font-medium leading-tight text-[var(--color-text-primary)]">{item.file.name}</p>
        <p className="text-[11px] text-[var(--color-text-muted)]">{formatBytes(item.file.size)}</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ROWS variant — compact horizontal rows for sidebars
// ────────────────────────────────────────────────────────────────────────────

function SortableRowItem({
  item,
  onRemove,
}: {
  item: FileItem;
  onRemove: (id: string) => void;
}) {
  const animateLayoutChanges: AnimateLayoutChanges = (args) =>
    args.isSorting || args.wasDragging ? false : true;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    animateLayoutChanges,
  });

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };

  return (
    <div
      ref={setNodeRef}
      style={style}
      aria-label={`${item.file.name}, ${formatBytes(item.file.size)}`}
      data-testid="file-row"
      data-filename={item.file.name}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2',
        'transition-shadow duration-150',
        isDragging ? 'shadow-lg' : 'hover:shadow-[var(--shadow-card-hover)]'
      )}
    >
      {/* Drag handle */}
      <button
        className="shrink-0 cursor-grab touch-none text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripIcon className="h-3.5 w-3.5" />
      </button>

      {/* Thumbnail */}
      <div className="relative h-[52px] w-9 shrink-0 overflow-hidden rounded border border-[var(--color-border)] bg-white">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          <DocPlaceholder pulse />
        )}
        {item.pageCount !== undefined && (
          <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-0.5 text-[8px] font-medium leading-tight text-white">
            {item.pageCount}
          </span>
        )}
      </div>

      {/* File info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-[var(--color-text-primary)]" title={item.file.name}>
          {item.file.name}
        </p>
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {formatBytes(item.file.size)}
          {item.error && <span className="ml-1 text-[var(--color-error)]">· {item.error}</span>}
        </p>
      </div>

      {/* Remove */}
      <button
        onClick={() => onRemove(item.id)}
        data-testid="file-remove"
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]"
        aria-label={`Remove ${item.file.name}`}
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function RowOverlay({ item }: { item: FileItem }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border-2 border-[var(--color-primary)] bg-[var(--color-surface)] p-2 shadow-xl">
      <GripIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
      <div className="relative h-[52px] w-9 shrink-0 overflow-hidden rounded border border-[var(--color-border)] bg-white">
        {item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-[var(--color-text-primary)]">{item.file.name}</p>
        <p className="text-[10px] text-[var(--color-text-muted)]">{formatBytes(item.file.size)}</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main export
// ────────────────────────────────────────────────────────────────────────────

export default function FileList({
  files,
  onReorder,
  onRemove,
  variant = 'cards',
  className,
}: FileListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

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

  if (files.length === 0) return null;

  const activeItem = activeId ? files.find((f) => f.id === activeId) ?? null : null;
  const isRows = variant === 'rows';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={files.map((f) => f.id)}
        strategy={isRows ? verticalListSortingStrategy : rectSortingStrategy}
      >
        <ul
          className={cn(isRows ? 'flex flex-col gap-2' : 'flex flex-wrap gap-3', className)}
          role="list"
          aria-label={`${files.length} file${files.length === 1 ? '' : 's'} queued`}
        >
          {files.map((item) => (
            <li key={item.id}>
              {isRows ? (
                <SortableRowItem item={item} onRemove={onRemove} />
              ) : (
                <SortableCardItem item={item} onRemove={onRemove} />
              )}
            </li>
          ))}
        </ul>
      </SortableContext>

      <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
        {activeItem
          ? isRows
            ? <RowOverlay item={activeItem} />
            : <CardOverlay item={activeItem} />
          : null}
      </DragOverlay>
    </DndContext>
  );
}
