import { useRef } from 'react';
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
}

const stateClasses: Record<DropZoneState, string> = {
  idle: 'border-[var(--color-border)] bg-[var(--color-background)]',
  'drag-over': 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 scale-[1.01]',
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
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
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
      className={cn(
        'relative flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-all duration-150',
        'focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
        stateClasses[dropState],
        dropState === 'idle' && 'animate-pulse-border',
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

      {dropState === 'idle' && !children && (
        <div
          key="idle"
          className="flex flex-col items-center gap-3 text-center animate-fade-in-up"
        >
          {/* Upload icon */}
          <div className="rounded-xl bg-[var(--color-primary)]/10 p-4 text-[var(--color-primary)]">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <div>
            <p className="font-medium text-[var(--color-text-primary)]">
              Drop your file{multiple ? 's' : ''} here, or{' '}
              <span className="text-[var(--color-primary)]">click to browse</span>
            </p>
            {hint && (
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{hint}</p>
            )}
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Or press <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs">Ctrl+V</kbd> to paste
            </p>
          </div>
        </div>
      )}

      {dropState === 'drag-over' && (
        <div
          key="drag-over"
          className="flex flex-col items-center gap-2 text-[var(--color-primary)] animate-fade-in-scale"
        >
          <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="font-semibold">Release to upload</p>
        </div>
      )}

      {dropState === 'accepted' && (
        <div
          key="accepted"
          className="flex flex-col items-center gap-2 text-[var(--color-success)] animate-fade-in-scale"
        >
          <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="font-semibold">Files added</p>
        </div>
      )}

      {dropState === 'rejected' && (
        <div
          key="rejected"
          className="flex flex-col items-center gap-2 text-[var(--color-error)] animate-fade-in-scale"
        >
          <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="font-semibold">File not supported</p>
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
