import { useEffect, useId, useRef } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import DownloadButton from '@/components/islands/shared/DownloadButton';
import ProgressBar from '@/components/islands/shared/ProgressBar';
import { cn } from '@/lib/utils';
import { useWorkspace } from './ToolWorkspace';
import type { ToolPhase } from './use-tool-run';

export interface ActionBarProps {
  phase: ToolPhase;
  /** The action, as a verb: "Sign PDF". */
  label: string;
  onRun: () => void;
  /**
   * Why the action cannot be used yet. Setting it disables the button, and the
   * reason is always shown — a disabled button never appears without one.
   */
  disabledReason?: string | null;
  /** Shown above the button when the action is available. */
  hint?: string;
  /** On the button while running. Defaults to "Working…". */
  runningLabel?: string;
  /** 0–100. */
  progress?: number;
  progressLabel?: string;
  onCancel?: () => void;
  /** Required for the `done` phase: the download that replaces the action. */
  download?: {
    label: string;
    onDownload: () => void | Promise<void>;
    ariaLabel?: string;
    /** While `onDownload` is pending. Defaults to "Preparing…". */
    busyLabel?: string;
    /** Briefly after it resolves. Defaults to "Downloaded!"; say less when the click only starts downloads. */
    doneLabel?: string;
  };
  /** One line about the result: "contract-signed.pdf · 677.6 KB · 7 pages". */
  summary?: string;
  /** "Make changes": go back to editing. The caller invalidates the result. */
  onEditAgain?: () => void;
  editAgainLabel?: string;
  /** Shown in the `error` phase. */
  error?: string | null;
}

const PRIMARY =
  'inline-flex h-11 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-[var(--color-text-primary)] px-5 text-sm font-medium text-[var(--color-background)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40';

function Spinner() {
  return (
    <svg className="size-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/**
 * The single action slot. One box of fixed height with four states:
 *
 *   ready    hint (or the reason the button is disabled)   [ action ]
 *   running  progress bar · Cancel                         [ busy action ]
 *   done     result summary · Make changes                 [ download ]
 *   error    the error                                     [ action ]
 *
 * The button is the same size in the same place in every state, and nothing is
 * ever inserted below it, so a click aimed at the action can never land on
 * something that just appeared. Exactly one filled button is on screen at a
 * time. When the download replaces the action, focus moves to it.
 *
 * Test ids: `tool-action`, `action-hint`, `processing-overlay`,
 * `progress-announce`, `download-button`, `result-summary`, `edit-again`,
 * `action-error`, and `options-toggle` on phones.
 */
export default function ActionBar({
  phase,
  label,
  onRun,
  disabledReason,
  hint,
  runningLabel = 'Working…',
  progress = 0,
  progressLabel,
  onCancel,
  download,
  summary,
  onEditAgain,
  editAgainLabel = 'Make changes',
  error,
}: ActionBarProps) {
  const workspace = useWorkspace();
  const barRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const previous = useRef<ToolPhase>(phase);

  // The slot swaps one button for another; without this, focus would be left on
  // a button that no longer exists.
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (before === phase) return;
    const bar = barRef.current;
    if (!bar) return;
    if (phase === 'done') {
      bar.querySelector<HTMLElement>('[data-testid="download-button"]')?.focus({ preventScroll: true });
    } else if (before === 'done' && phase === 'ready') {
      bar.querySelector<HTMLElement>('[data-testid="tool-action"]:not(:disabled)')?.focus({ preventScroll: true });
    }
  }, [phase]);

  const disabled = phase === 'ready' && !!disabledReason;
  const decile = Math.max(0, Math.min(100, Math.floor(progress / 10) * 10));
  const busyLabel = progressLabel || runningLabel;
  const showDownload = phase === 'done' && !!download;

  return (
    <div
      ref={barRef}
      data-testid="action-bar"
      data-phase={phase}
      className="flex h-full flex-col justify-center gap-1.5 px-3 sm:px-4 lg:gap-2.5"
    >
      {/* Line 1: always the same height, whatever it says. */}
      <div className="flex h-5 items-center gap-3 text-xs lg:h-9 lg:text-sm">
        {phase === 'ready' && (
          <p
            id={hintId}
            data-testid="action-hint"
            data-disabled-reason={disabled ? 'true' : undefined}
            className={cn(
              'min-w-0 truncate lg:line-clamp-2 lg:whitespace-normal',
              disabled ? 'font-medium text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]',
            )}
          >
            {disabled ? disabledReason : hint}
          </p>
        )}

        {phase === 'running' && (
          <div
            role="group"
            aria-label={busyLabel}
            data-testid="processing-overlay"
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            {/* The single polite live region: speaks every 10%, not every tick. */}
            <span className="sr-only" role="status" aria-live="polite" data-testid="progress-announce">
              {busyLabel}: {decile}% complete
            </span>
            <ProgressBar progress={progress} size="sm" className="min-w-0 flex-1" label={undefined} />
            <span className="hidden shrink-0 truncate text-[var(--color-text-secondary)] lg:inline">{busyLabel}</span>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                data-testid="action-cancel"
                className="shrink-0 rounded text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {phase === 'done' && (
          <>
            <p
              data-testid="result-summary"
              className="min-w-0 flex-1 truncate font-medium text-[var(--color-success)] lg:line-clamp-2 lg:whitespace-normal lg:text-xs"
            >
              {summary ?? 'Ready to download'}
            </p>
            {onEditAgain && (
              <button
                type="button"
                onClick={onEditAgain}
                data-testid="edit-again"
                className="shrink-0 rounded font-medium text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80"
              >
                {editAgainLabel}
              </button>
            )}
          </>
        )}

        {phase === 'error' && (
          <p role="alert" data-testid="action-error" className="min-w-0 truncate font-medium text-[var(--color-error)] lg:line-clamp-2 lg:whitespace-normal">
            {error || 'Something went wrong. Try again.'}
          </p>
        )}
      </div>

      {/* Line 2: the slot. */}
      <div className="flex items-center gap-2">
        {workspace && (
          <button
            type="button"
            onClick={() => workspace.setOptionsOpen(!workspace.optionsOpen)}
            aria-expanded={workspace.optionsOpen}
            aria-controls={workspace.optionsId}
            data-testid="options-toggle"
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] md:hidden"
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            Options
            {workspace.optionsOpen ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="size-4" aria-hidden="true" />
            )}
          </button>
        )}

        <div className="min-w-0 flex-1" data-testid="action-slot">
          {showDownload ? (
            <DownloadButton
              onClick={download.onDownload}
              label={download.label}
              ariaLabel={download.ariaLabel}
              busyLabel={download.busyLabel}
              doneLabel={download.doneLabel}
              className="h-11 w-full min-w-0 whitespace-nowrap px-3 py-0"
            />
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={disabled || phase === 'running' || phase === 'done'}
              aria-busy={phase === 'running' || undefined}
              aria-describedby={phase === 'ready' ? hintId : undefined}
              data-testid="tool-action"
              className={PRIMARY}
            >
              {phase === 'running' && <Spinner />}
              <span className="truncate">{phase === 'running' ? runningLabel : label}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
