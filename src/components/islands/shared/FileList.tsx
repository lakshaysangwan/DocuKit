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
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion, AnimatePresence } from 'motion/react';
import { cn, formatBytes } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

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
  className?: string;
}

interface SortableFileCardProps {
  item: FileItem;
  onRemove: (id: string) => void;
}

function SortableFileCard({ item, onRemove }: SortableFileCardProps) {
  const prefersReduced = useReducedMotion();

  // Disable layout animation while sorting to prevent jitter
  const animateLayoutChanges: AnimateLayoutChanges = (args) =>
    args.isSorting || args.wasDragging ? false : true;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, animateLayoutChanges });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout={!prefersReduced && !isDragging}
      initial={prefersReduced ? {} : { opacity: 0, y: 8 }}
      animate={{ opacity: isDragging ? 0.3 : 1, y: 0, scale: isDragging ? 0.98 : 1 }}
      exit={prefersReduced ? {} : { opacity: 0, x: -20 }}
      transition={{ duration: 0.15 }}
      className={cn(
        'flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3',
        'transition-shadow duration-150',
        isDragging ? 'shadow-lg' : 'shadow-sm hover:shadow-md'
      )}
      aria-label={`${item.file.name}, ${formatBytes(item.file.size)}${item.pageCount ? `, ${item.pageCount} pages` : ''}`}
    >
      {/* Drag handle */}
      <button
        className="cursor-grab touch-none text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        </svg>
      </button>

      {/* Thumbnail */}
      <div className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            aria-hidden="true"
          />
        ) : (
          <svg
            className="h-6 w-6 text-[var(--color-text-muted)]"
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
        )}
      </div>

      {/* File info */}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-[var(--color-text-primary)]"
          title={item.file.name}
        >
          {item.file.name}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <span>{formatBytes(item.file.size)}</span>
          {item.pageCount !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span>{item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'}</span>
            </>
          )}
          {item.error && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-[var(--color-error)]">{item.error}</span>
            </>
          )}
        </div>
      </div>

      {/* Remove button */}
      <button
        onClick={() => onRemove(item.id)}
        className="shrink-0 rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]"
        aria-label={`Remove ${item.file.name}`}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
}

/** Static (non-sortable) card used inside DragOverlay */
function FileCardOverlay({ item }: { item: FileItem }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border-2 border-[var(--color-primary)] bg-[var(--color-surface)] p-3 shadow-xl"
    >
      <div className="text-[var(--color-text-muted)]">
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        </svg>
      </div>
      <div className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <svg className="h-6 w-6 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">{item.file.name}</p>
        <span className="text-xs text-[var(--color-text-muted)]">{formatBytes(item.file.size)}</span>
      </div>
    </div>
  );
}

export default function FileList({ files, onReorder, onRemove, className }: FileListProps) {
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <ul
          className={cn('flex flex-col gap-2', className)}
          role="list"
          aria-label={`${files.length} file${files.length === 1 ? '' : 's'} queued`}
        >
          <AnimatePresence initial={false}>
            {files.map((item) => (
              <li key={item.id}>
                <SortableFileCard item={item} onRemove={onRemove} />
              </li>
            ))}
          </AnimatePresence>
        </ul>
      </SortableContext>

      {/* Drag overlay — renders a floating copy of the dragged card for smooth visuals */}
      <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
        {activeId ? (() => {
          const item = files.find((f) => f.id === activeId);
          return item ? <FileCardOverlay item={item} /> : null;
        })() : null}
      </DragOverlay>
    </DndContext>
  );
}

