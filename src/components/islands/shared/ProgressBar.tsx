import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

interface ProgressBarProps {
  progress: number; // 0–100
  eta?: string;     // e.g. "~3s remaining"
  label?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-4',
};

export default function ProgressBar({
  progress,
  eta,
  label,
  className,
  size = 'md',
}: ProgressBarProps) {
  const prefersReduced = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <div className={cn('w-full', className)} role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Processing progress'}>
      {(label || eta !== undefined) && (
        <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
          {label && <span>{label}</span>}
          <div className="ml-auto flex items-center gap-3">
            {eta && <span className="text-[var(--color-text-muted)]">{eta}</span>}
            <span className="font-medium tabular-nums">{clamped}%</span>
          </div>
        </div>
      )}

      {/* Track */}
      <div className={cn('overflow-hidden rounded-full bg-[var(--color-border)]', sizeClasses[size])}>
        {/* Fill */}
        <div
          className={cn(
            'h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300 ease-out',
            !prefersReduced && clamped < 100 && 'relative overflow-hidden'
          )}
          style={{ width: `${clamped}%` }}
        >
          {/* Animated stripe overlay */}
          {!prefersReduced && clamped > 0 && clamped < 100 && (
            <div
              className="absolute inset-0 animate-stripe-slide"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(255,255,255,0.15) 6px, rgba(255,255,255,0.15) 12px)',
                backgroundSize: '16px 16px',
              }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </div>
  );
}
