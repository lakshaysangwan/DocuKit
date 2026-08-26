import { useEffect, useRef } from 'react';
import ProgressBar from './ProgressBar';
import { cn } from '@/lib/utils';

interface ProcessingOverlayProps {
  progress: number;        // 0–100
  eta?: string;
  label?: string;
  onCancel?: () => void;
  className?: string;
}

/** Simple CSS spinner used when Lottie is unavailable or motion is reduced */
function Spinner() {
  return (
    <svg
      className="h-16 w-16 animate-spin text-[var(--color-primary)]"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/** Lottie player — dynamically loaded to avoid SSR issues */
function LottieAnimation({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animation: { destroy: () => void } | null = null;

    import('lottie-web').then((lottie) => {
      if (!containerRef.current) return;
      animation = lottie.default.loadAnimation({
        container: containerRef.current,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: src,
      });
    });

    return () => {
      animation?.destroy();
    };
  }, [src]);

  return <div ref={containerRef} className="h-24 w-24" aria-hidden="true" />;
}

export default function ProcessingOverlay({
  progress,
  eta,
  label,
  onCancel,
  className,
}: ProcessingOverlayProps) {
  const lottieAvailable = typeof window !== 'undefined';
  const prefersReduced = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Announce progress to screen readers at 10% deciles rather than every tick,
  // so the live region isn't chatty. The DOM text only changes on a decile
  // boundary, so assistive tech announces roughly every 10%.
  const decile = Math.max(0, Math.min(100, Math.floor(progress / 10) * 10));

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-10 animate-fade-in',
        className
      )}
      role="group"
      aria-label={label ?? 'Processing files'}
      data-testid="processing-overlay"
    >
      {/* Screen-reader progress announcer — the single polite live region. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="progress-announce">
        {label ?? 'Processing'}: {decile}% complete
      </span>
      {/* Animation */}
      {prefersReduced || !lottieAvailable ? (
        <Spinner />
      ) : (
        <LottieAnimation src="/lottie/processing.json" />
      )}

      {/* Label */}
      <p className="text-sm font-medium text-[var(--color-text-secondary)]">
        {label ?? 'Processing…'}
      </p>

      {/* Progress bar */}
      <div className="w-full max-w-xs">
        <ProgressBar progress={progress} eta={eta} size="lg" />
      </div>

      {/* Cancel */}
      {onCancel && (
        <button
          onClick={onCancel}
          className="text-sm text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text-secondary)]"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
