import { useId, useLayoutEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Lock, X } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';

/** Dark enough for white letters at AA contrast, distinct from each other. */
export const FILE_COLOURS = ['#1d4ed8', '#b91c1c', '#047857', '#7e22ce', '#b45309', '#0e7490', '#be185d', '#4d7c0f'];

export function FileBadge({ letter, colour, className }: { letter: string; colour: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="file-badge"
      className={cn(
        'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-bold leading-none text-white',
        className,
      )}
      style={{ backgroundColor: FILE_COLOURS[colour % FILE_COLOURS.length] }}
    >
      {letter}
    </span>
  );
}

export interface MergeFileRowProps {
  id: string;
  name: string;
  size: number;
  letter: string;
  colour: number;
  status: 'opening' | 'ready' | 'locked' | 'error';
  /** Pages in the file, once known. */
  pageCount: number | null;
  /** How many of its pages are in the merged PDF. */
  chosen: number;
  rangeText: string;
  rangeError: string | null;
  onRangeChange: (text: string) => void;
  password: string;
  passwordState: 'idle' | 'checking' | 'wrong';
  onPasswordChange: (password: string) => void;
  onUnlock: () => void;
  /**
   * The visitor is reaching for Unlock (pointer down on it, or focus): hold the
   * automatic try, so the button is not swapped for the page field under the click.
   */
  onUnlockIntent?: () => void;
  onRemove: () => void;
  sortable: boolean;
  disabled: boolean;
}

const field =
  'w-full rounded-lg border bg-[var(--color-background)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)] disabled:opacity-60';
const smallButton =
  'flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * One input file in Merge's controls: its badge, name and page count, the
 * pages it contributes as a range, a password field if it is locked, and the
 * ways to move or remove it. Dragged by the handle (or picked up with Space and
 * moved with the arrow keys).
 *
 * Test ids: `file-row` (with `data-filename`), `file-reorder`, `file-remove`,
 * `page-range-input`, `page-range-error`, `merge-passwords`,
 * `merge-password-input`, `merge-unlock`.
 */
export default function MergeFileRow({
  id,
  name,
  size,
  letter,
  colour,
  status,
  pageCount,
  chosen,
  rangeText,
  rangeError,
  onRangeChange,
  password,
  passwordState,
  onPasswordChange,
  onUnlock,
  onUnlockIntent,
  onRemove,
  sortable,
  disabled,
}: MergeFileRowProps) {
  const uid = useId();
  // Whether focus is in the password field or its button. When the file opens
  // they are replaced by the page field, and focus goes there instead of being
  // dropped on the page.
  const focusInPassword = useRef(false);
  const rangeRef = useRef<HTMLInputElement>(null);
  const wasLocked = useRef(status === 'locked');
  useLayoutEffect(() => {
    const unlocked = wasLocked.current && status === 'ready';
    wasLocked.current = status === 'locked';
    if (!unlocked || !focusInPassword.current) return;
    focusInPassword.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) rangeRef.current?.focus({ preventScroll: true });
  }, [status]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !sortable || disabled,
  });

  const facts =
    status === 'opening'
      ? 'Reading…'
      : status === 'locked'
        ? 'Password-protected'
        : status === 'error'
          ? 'Could not be read as a PDF'
          : `${chosen === pageCount ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : `${chosen} of ${pageCount} pages`}`;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="file-row"
      data-filename={name}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'relative flex flex-col gap-2 rounded-lg border bg-[var(--color-surface)] p-2',
        isDragging ? 'z-10 border-[var(--color-primary)] shadow-xl' : 'border-[var(--color-border)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {sortable ? (
          <button
            type="button"
            data-testid="file-reorder"
            aria-label={`Move ${letter}: ${name}`}
            className={cn(smallButton, 'cursor-grab touch-none active:cursor-grabbing')}
            {...attributes}
            {...listeners}
            disabled={disabled}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        <FileBadge letter={letter} colour={colour} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--color-text-primary)]" title={name}>
            {name}
          </p>
          <p
            data-testid="file-row-facts"
            className={cn('truncate text-xs', status === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]')}
          >
            {facts} · {formatBytes(size)}
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          data-testid="file-remove"
          aria-label={`Remove ${name}`}
          className={cn(smallButton, 'hover:text-[var(--color-error)]')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {status === 'locked' ? (
        <div
          data-testid="merge-passwords"
          className="flex flex-col gap-1"
          onFocus={() => {
            focusInPassword.current = true;
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInPassword.current = false;
          }}
        >
          <label htmlFor={`${uid}-pw`} className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
            <Lock className="size-3" aria-hidden="true" />
            Password to open it
          </label>
          <div className="flex gap-1.5">
            <input
              id={`${uid}-pw`}
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onUnlock();
                }
              }}
              placeholder="Password"
              aria-label={`Password for ${name}`}
              aria-invalid={passwordState === 'wrong' || undefined}
              aria-describedby={`${uid}-pw-state`}
              autoComplete="off"
              disabled={disabled}
              data-testid="merge-password-input"
              className={cn(field, passwordState === 'wrong' ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]')}
            />
            <button
              type="button"
              onClick={onUnlock}
              onPointerDown={onUnlockIntent}
              onFocus={onUnlockIntent}
              disabled={disabled || !password.trim()}
              data-testid="merge-unlock"
              className="h-9 shrink-0 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Unlock
            </button>
          </div>
          <p id={`${uid}-pw-state`} aria-live="polite" className={cn('text-xs', passwordState === 'wrong' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]')}>
            {passwordState === 'checking'
              ? 'Checking the password…'
              : passwordState === 'wrong'
                ? 'That password does not open this file.'
                : 'Its pages appear once it is unlocked.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor={`${uid}-range`} className="shrink-0 text-xs text-[var(--color-text-secondary)]">
              Pages
            </label>
            <input
              ref={rangeRef}
              id={`${uid}-range`}
              type="text"
              inputMode="text"
              value={rangeText}
              onChange={(e) => onRangeChange(e.target.value)}
              placeholder={pageCount ? `All pages (e.g. 1-${Math.min(3, pageCount)}${pageCount > 3 ? `, ${pageCount}` : ''})` : 'All pages'}
              aria-label={`Pages to include from ${name}`}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={`${uid}-range-error`}
              disabled={disabled || status !== 'ready'}
              data-testid="page-range-input"
              className={cn(field, rangeError ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]')}
            />
          </div>
          <p
            id={`${uid}-range-error`}
            data-testid="page-range-error"
            aria-live="polite"
            className="text-xs text-[var(--color-error)]"
          >
            {rangeError ? `${rangeError} The pages shown have not changed.` : ''}
          </p>
        </div>
      )}
    </li>
  );
}
