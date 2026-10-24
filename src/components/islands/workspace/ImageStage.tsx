import type { ReactNode } from 'react';
import CompareView from './CompareView';
import { cn } from '@/lib/utils';

/**
 * The document pane of an image tool: the image large, on a checkerboard so
 * transparency shows, at Fit, 100% (one image pixel per CSS pixel) or 200%.
 * Given a result it becomes a `CompareView` of the two — split, side by side or
 * hold — never cropped. With several images a strip of them sits above, and the
 * one chosen there is the one shown.
 *
 *     <ImageStage
 *       src={originalUrl} alt="Your photo" naturalWidth={1200} naturalHeight={800}
 *       resultSrc={outputUrl} afterLabel="Compressed"
 *       items={files.map(…)} selected={i} onSelect={setI}
 *       footer={<p>Facts about what is shown</p>}
 *     />
 *
 * The caller owns the object URLs (and revokes them).
 *
 * Test ids: `image-stage` (`data-comparing`, `data-selected`), `image-strip`,
 * `image-strip-item` (`data-index`, `aria-pressed`), `image-stage-footer`, and
 * `CompareView`'s own.
 */

export interface ImageStageItem {
  /** Stable key. */
  id: string;
  /** File name, for the button's accessible name and its tooltip. */
  name: string;
  /** Thumbnail URL; the name is shown while it is missing. */
  thumbSrc?: string | null;
  /** Something small over the thumbnail, such as a warning mark. */
  badge?: ReactNode;
}

export interface ImageStageProps {
  /** The image (the original). Null while it is being read. */
  src: string | null;
  alt: string;
  /** Its size in pixels: 100% shows it at this many CSS pixels. */
  naturalWidth: number;
  naturalHeight: number;
  /** The result to compare with, or null for the image alone. */
  resultSrc?: string | null;
  resultAlt?: string;
  beforeLabel?: string;
  afterLabel?: string;
  /** Shows "Updating…" over the view while a result is being made. */
  busy?: boolean;
  /** Several images: the strip. Leave out (or pass one) for a single image. */
  items?: ImageStageItem[];
  selected?: number;
  onSelect?: (index: number) => void;
  /** Toolbar content before the view controls. */
  toolbarStart?: ReactNode;
  /** A line under the view: what is shown, a button. */
  footer?: ReactNode;
  /** Placeholder text while `src` is null. */
  placeholder?: string;
  /**
   * Without a result: drawn in place of the image, in a box of
   * `naturalWidth × naturalHeight` at the chosen zoom (Resize Image draws its
   * output frame here).
   */
  content?: ReactNode;
}

export default function ImageStage({
  src,
  alt,
  naturalWidth,
  naturalHeight,
  resultSrc = null,
  resultAlt = 'Result',
  beforeLabel = 'Original',
  afterLabel = 'Result',
  busy = false,
  items,
  selected = 0,
  onSelect,
  toolbarStart,
  footer,
  placeholder = 'Reading the image…',
  content,
}: ImageStageProps) {
  const strip = items && items.length > 1;
  return (
    <div
      className="absolute inset-0 flex flex-col"
      data-testid="image-stage"
      data-comparing={src && resultSrc ? 'true' : 'false'}
      data-selected={selected}
    >
      {strip && (
        <div
          role="group"
          aria-label="Images"
          data-testid="image-strip"
          className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 sm:px-3"
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={i === selected}
              aria-label={`Show ${item.name} (${i + 1} of ${items.length})`}
              title={item.name}
              data-testid="image-strip-item"
              data-index={i}
              onClick={() => onSelect?.(i)}
              className={cn(
                'relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 bg-[var(--color-background)] text-[10px] text-[var(--color-text-secondary)]',
                i === selected ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]',
              )}
            >
              {item.thumbSrc ? (
                <img src={item.thumbSrc} alt="" draggable={false} className="size-full object-contain" />
              ) : (
                <span className="line-clamp-2 break-all px-0.5">{item.name}</span>
              )}
              {item.badge && <span className="absolute right-0.5 top-0.5">{item.badge}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <CompareView
          before={src ? { src, alt } : null}
          after={src && resultSrc ? { src: resultSrc, alt: resultAlt } : null}
          naturalWidth={naturalWidth || 4}
          naturalHeight={naturalHeight || 3}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          toolbarStart={toolbarStart}
          busy={busy}
          checkerboard
          placeholder={placeholder}
          content={content}
        />
      </div>
      {footer && (
        <div
          data-testid="image-stage-footer"
          className="flex min-h-12 shrink-0 flex-col justify-center gap-0.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5"
        >
          {footer}
        </div>
      )}
    </div>
  );
}
