import { cn } from '@/lib/utils';
import type { ThumbnailResult } from '@/hooks/use-pdf-thumbnails';

interface Props {
  thumbnails: ThumbnailResult[];
  /** 0-indexed pages currently selected. */
  selected: Set<number>;
  /** Omit to render a read-only preview strip instead of a selector. */
  onToggle?: (pageIndex: number) => void;
  isLoading?: boolean;
  label?: string;
  /** Rendered under the grid, e.g. "3 of 10 pages selected". */
  hint?: string;
}

/**
 * Thumbnail grid for picking pages.
 *
 * split-pdf and pdf-to-image both already paid to rasterise every page — they
 * called `usePdfThumbnails` and then used only its page count, so the images
 * were rendered and thrown away. This is where they go.
 */
export default function PageSelectorGrid({
  thumbnails, selected, onToggle, isLoading, label, hint,
}: Props) {
  if (!isLoading && thumbnails.length === 0) return null;

  const interactive = typeof onToggle === 'function';

  return (
    <div data-testid="page-selector">
      {label && (
        <p className="mb-1.5 text-sm font-medium text-[var(--color-text-primary)]">{label}</p>
      )}

      {isLoading && thumbnails.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">Rendering pages…</p>
      ) : (
        <div
          className="flex flex-wrap gap-2"
          role={interactive ? 'group' : undefined}
          aria-label={interactive ? 'Select pages' : undefined}
        >
          {thumbnails.map((thumb) => {
            const isSelected = selected.has(thumb.pageIndex);
            const pageLabel = `Page ${thumb.pageIndex + 1}`;
            const inner = (
              <>
                <img
                  src={thumb.dataUrl}
                  // A button announces its state through aria-pressed; the
                  // read-only strip has only the border colour, so say it here.
                  alt={!interactive && isSelected ? `${pageLabel} (selected)` : pageLabel}
                  data-testid="page-thumb"
                  className="block h-24 w-auto max-w-[5rem] object-contain"
                />
                <span
                  className={cn(
                    'absolute bottom-0 left-0 right-0 py-0.5 text-center text-[10px] font-medium',
                    isSelected
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-black/50 text-white',
                  )}
                >
                  {thumb.pageIndex + 1}
                </span>
              </>
            );

            const shell = cn(
              'relative overflow-hidden rounded-lg border-2 bg-white transition-colors',
              isSelected ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]',
            );

            return interactive ? (
              <button
                key={thumb.pageIndex}
                type="button"
                onClick={() => onToggle!(thumb.pageIndex)}
                aria-pressed={isSelected}
                aria-label={pageLabel}
                data-testid={`page-select-${thumb.pageIndex}`}
                className={cn(shell, 'hover:border-[var(--color-primary)]')}
              >
                {inner}
              </button>
            ) : (
              <div key={thumb.pageIndex} className={shell}>
                {inner}
              </div>
            );
          })}
        </div>
      )}

      {hint && <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}
