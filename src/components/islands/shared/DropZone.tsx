import { useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useFileDrop, type DropZoneState } from '@/hooks/use-file-drop';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

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
  const prefersReduced = useReducedMotion();
  const { dropState, onDragEnter, onDragLeave, onDragOver, onDrop, onInputChange } = useFileDrop({
    accept,
    maxFiles,
    maxSize,
    multiple,
    onFiles,
  });

  const acceptString = accept.join(',');

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`File upload area. ${hint ?? `Accepts ${accept.join(', ')}`}. Click or drag files here.`}
      animate={prefersReduced ? {} : {
        scale: dropState === 'drag-over' ? 1.01 : 1,
      }}
      transition={{ duration: 0.15 }}
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

      <AnimatePresence mode="wait">
        {dropState === 'idle' && !children && (
          <motion.div
            key="idle"
            initial={prefersReduced ? {} : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReduced ? {} : { opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-center gap-3 text-center"
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
          </motion.div>
        )}

        {dropState === 'drag-over' && (
          <motion.div
            key="drag-over"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 text-[var(--color-primary)]"
          >
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="font-semibold">Release to upload</p>
          </motion.div>
        )}

        {dropState === 'accepted' && (
          <motion.div
            key="accepted"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 text-[var(--color-success)]"
          >
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="font-semibold">Files added</p>
          </motion.div>
        )}

        {dropState === 'rejected' && (
          <motion.div
            key="rejected"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-2 text-[var(--color-error)]"
          >
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="font-semibold">File not supported</p>
          </motion.div>
        )}

        {children && dropState === 'idle' && (
          <motion.div key="custom" className="w-full">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
