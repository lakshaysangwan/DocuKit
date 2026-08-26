import { useEffect, useRef, useState } from 'react';
import { useFileDrop, type DropZoneState } from '@/hooks/use-file-drop';
import { cn } from '@/lib/utils';

interface DropZoneProps {
  accept: string[];
  maxFiles?: number;
  maxSize?: number;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  hint?: string;
  className?: string;
  children?: React.ReactNode;
  /** Render a slim "add more" bar instead of the full drop target.
   *  Use once files are already queued so the big empty box isn't wasted space. */
  compact?: boolean;
}

const stateClasses: Record<DropZoneState, string> = {
  idle: 'border-[var(--color-border)] bg-[var(--color-background)]',
  'drag-over': 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 scale-[1.005]',
  accepted: 'border-[var(--color-success)] bg-[var(--color-success)]/5',
  rejected: 'border-[var(--color-error)] bg-[var(--color-error)]/5',
};

export default function DropZone({
  accept,
  maxFiles,
  maxSize,
  multiple = true,
  onFiles,
  hint,
  className,
  children,
  compact = false,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Marks the island as interactive once React has mounted and wired up the
  // change/drop handlers. Automated tests wait for this before uploading so
  // they don't fire a change event the (not-yet-hydrated) handler would drop.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { dropState, onDragEnter, onDragLeave, onDragOver, onDrop, onInputChange } = useFileDrop({
    accept,
    maxFiles,
    maxSize,
    multiple,
    onFiles,
  });

  const acceptString = accept.join(',');

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`File upload area. ${hint ?? `Accepts ${accept.join(', ')}`}. Click or drag files here.`}
      data-testid="dropzone"
      data-state={dropState}
      data-compact={compact ? 'true' : 'false'}
      data-hydrated={hydrated ? 'true' : 'false'}
      className={cn(
        'relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-all duration-150',
        compact ? 'min-h-0 py-3' : 'min-h-40',
        'focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
        stateClasses[dropState],
        className
      )}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={acceptString}
        multiple={multiple}
        className="sr-only"
        onChange={onInputChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      {dropState === 'idle' && !children && compact && (
        <div key="idle-compact" className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <svg className="h-4 w-4 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
          </svg>
          <span>
            Add {multiple ? 'more files' : 'a different file'}, or{' '}
            <span className="font-medium text-[var(--color-primary)]">browse</span>
          </span>
        </div>
      )}

      {dropState === 'idle' && !children && !compact && (
        <div key="idle" className="flex flex-col items-center gap-4 text-center px-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--color-border)] text-[var(--color-text-muted)]">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <div>
            <p className="text-sm text-[var(--color-text-primary)]">
              Drop your file{multiple ? 's' : ''} here, or{' '}
              <span className="font-medium text-[var(--color-primary)]">browse</span>
            </p>
            {hint && (
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{hint}</p>
            )}
          </div>
        </div>
      )}

      {dropState === 'drag-over' && (
        <div key="drag-over" className="flex flex-col items-center gap-2 text-[var(--color-primary)]">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-sm font-medium">Release to upload</p>
        </div>
      )}

      {dropState === 'accepted' && (
        <div key="accepted" className="flex flex-col items-center gap-2 text-[var(--color-success)]">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium">Files added</p>
        </div>
      )}

      {dropState === 'rejected' && (
        <div key="rejected" className="flex flex-col items-center gap-2 text-[var(--color-error)]">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium">File not supported</p>
        </div>
      )}

      {children && dropState === 'idle' && (
        <div key="custom" className="w-full">
          {children}
        </div>
      )}
    </div>
  );
}
