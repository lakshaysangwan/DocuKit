import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

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
  md: 'gap-2 px-6 py-3 text-base',
  lg: 'gap-2.5 px-8 py-4 text-lg',
};

const iconSizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
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
  const prefersReduced = useReducedMotion();

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
    <motion.button
      onClick={handleClick}
      disabled={disabled || state === 'downloading'}
      animate={
        prefersReduced
          ? {}
          : state === 'idle' && !disabled
            ? { scale: [1, 1.02, 1] }
            : {}
      }
      transition={
        state === 'idle' && !disabled
          ? { duration: 2, repeat: Infinity, repeatDelay: 3, ease: 'easeInOut' }
          : {}
      }
      className={cn(
        'inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
        sizeClasses[size],
        state === 'done'
          ? 'bg-[var(--color-success)] text-white hover:bg-[var(--color-success)]/90'
          : 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)]',
        (disabled || state === 'downloading') && 'cursor-not-allowed opacity-60',
        className
      )}
      aria-label={displayLabel}
    >
      <AnimatePresence mode="wait" initial={false}>
        {state === 'downloading' ? (
          <motion.svg
            key="spinner"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.1 }}
            className={cn(iconSizeClasses[size], 'animate-spin')}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </motion.svg>
        ) : state === 'done' ? (
          <motion.svg
            key="check"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            className={iconSizeClasses[size]}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </motion.svg>
        ) : (
          <motion.svg
            key="download"
            initial={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReduced ? {} : { opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.1 }}
            className={iconSizeClasses[size]}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </motion.svg>
        )}
      </AnimatePresence>
      <span>{displayLabel}</span>
    </motion.button>
  );
}
