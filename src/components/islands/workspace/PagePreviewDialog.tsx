import { useRef, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface PagePreviewDialogProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog: "Page 2 of 5 · photo.jpg". */
  title: string;
  /** A second line under the title: "A4 · 210 × 297 mm". */
  detail?: string;
  /** Width ÷ height of the page shown, so it can be fitted to the dialog. */
  aspect: number;
  /** The page itself. It is given a box of the right proportions to fill. */
  children: ReactNode;
  /** Go to the previous / next page. Leave out at the ends: the button is then disabled. */
  onPrevious?: () => void;
  onNext?: () => void;
  /**
   * Where focus goes when the dialog closes. Defaults to whatever had focus
   * when it opened; pass this when paging can leave that element stale.
   */
  returnFocus?: () => HTMLElement | null;
  /**
   * Give the content the whole area under the bar instead of a box of the
   * page's proportions, for content that lays itself out (its own zoom and
   * scrolling). The content then fills a positioned box.
   */
  fill?: boolean;
}

const pagerButton =
  'inline-flex h-10 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40';

/**
 * One page, large. A modal dialog: Esc, the close button and a click outside
 * all close it, focus stays inside while it is open and goes back to where it
 * came from afterwards. Left and Right arrow keys page through.
 *
 * It takes whatever page content the caller renders, so a tool that shows
 * output pages and a tool that shows PDF pages use the same dialog.
 *
 * Test ids: `page-preview-dialog`, `page-preview-backdrop`, `page-preview-title`,
 * `page-preview-close`, `page-preview-prev`, `page-preview-next`.
 */
export default function PagePreviewDialog({
  open,
  onClose,
  title,
  detail,
  aspect,
  children,
  onPrevious,
  onNext,
  returnFocus,
  fill = false,
}: PagePreviewDialogProps) {
  const opener = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay data-testid="page-preview-backdrop" className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content
          data-testid="page-preview-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            // Radix would send focus to a trigger element; this dialog is opened
            // from code, so put focus back by hand.
            event.preventDefault();
            const target = returnFocus?.() ?? opener.current;
            if (target?.isConnected) target.focus();
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' && onPrevious) {
              event.preventDefault();
              onPrevious();
            } else if (event.key === 'ArrowRight' && onNext) {
              event.preventDefault();
              onNext();
            }
          }}
          className="fixed left-1/2 top-1/2 z-[101] flex h-[calc(100dvh-1.5rem)] w-[min(90rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl outline-none"
        >
          {/* One slim bar, so the page gets the height. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 sm:px-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title
                data-testid="page-preview-title"
                className="truncate text-sm font-semibold text-[var(--color-text-primary)]"
              >
                {title}
              </Dialog.Title>
              {detail && <p className="truncate text-xs text-[var(--color-text-secondary)]">{detail}</p>}
            </div>
            <button
              type="button"
              onClick={onPrevious}
              // Not the disabled attribute: a focused button that becomes disabled
              // swallows the arrow keys that page through.
              aria-disabled={!onPrevious}
              data-testid="page-preview-prev"
              className={pagerButton}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              <span className="max-sm:sr-only">Previous</span>
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-disabled={!onNext}
              data-testid="page-preview-next"
              className={pagerButton}
            >
              <span className="max-sm:sr-only">Next</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
            <Dialog.Close
              data-testid="page-preview-close"
              aria-label="Close"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-primary)]"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>

          {/* The page, as large as fits: a size container, so the page can be
              the largest box of its own proportions inside it with CSS alone. */}
          {fill ? (
            <div className="relative min-h-0 flex-1 bg-[var(--color-background)]">{children}</div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-background)] p-2 sm:p-3">
              <div className="flex size-full items-center justify-center [container-type:size]">
                <div style={{ width: `min(100cqw, calc(100cqh * ${aspect}))`, aspectRatio: String(aspect) }}>
                  {children}
                </div>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
