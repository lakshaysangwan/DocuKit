import { useState } from 'react';
import { cn } from '@/lib/utils';

interface DownloadButtonProps {
  onClick: () => void | Promise<void>;
  label?: string;
  fileName?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'gap-1.5 px-4 py-2 text-sm',
  md: 'gap-2 px-5 py-2.5 text-sm',
  lg: 'gap-2.5 px-8 py-3 text-base',
};

const iconSizeClasses = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

export default function DownloadButton({
  onClick,
  label,
  fileName,
  disabled = false,
  className,
  size = 'md',
}: DownloadButtonProps) {
  const [state, setState] = useState<'idle' | 'downloading' | 'done'>('idle');

  const handleClick = async () => {
    if (disabled || state !== 'idle') return;
    setState('downloading');
    try {
      await onClick();
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('idle');
    }
  };

  const displayLabel =
    state === 'downloading'
      ? 'Preparing…'
      : state === 'done'
        ? 'Downloaded!'
        : (label ?? (fileName ? `Download ${fileName}` : 'Download'));

  return (
    <button
      onClick={handleClick}
      disabled={disabled || state === 'downloading'}
      data-testid="download-button"
      data-state={state}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-all duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
        sizeClasses[size],
        state === 'done'
          ? 'bg-[var(--color-success)] text-white'
          : 'bg-[var(--color-text-primary)] text-[var(--color-background)] hover:opacity-80',
        (disabled || state === 'downloading') && 'cursor-not-allowed opacity-40',
        className
      )}
      aria-label={displayLabel}
    >
      {state === 'downloading' ? (
        <svg
          className={cn(iconSizeClasses[size], 'animate-spin')}
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : state === 'done' ? (
        <svg
          className={iconSizeClasses[size]}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg
          className={iconSizeClasses[size]}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      )}
      <span>{displayLabel}</span>
    </button>
  );
}
