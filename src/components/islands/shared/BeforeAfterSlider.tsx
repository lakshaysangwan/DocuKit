import { useRef, useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
  beforeAlt?: string;
  afterAlt?: string;
  className?: string;
}

export default function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeLabel = 'Before',
  afterLabel = 'After',
  beforeAlt = 'Before image',
  afterAlt = 'After image',
  className,
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50); // percent
  const [isDragging, setIsDragging] = useState(false);

  const updatePosition = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setPosition(pct);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      updatePosition(e.clientX);
    },
    [updatePosition]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      updatePosition(e.clientX);
    },
    [isDragging, updatePosition]
  );

  const onPointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Keyboard support on the track
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setPosition((p) => Math.max(0, p - 5));
    else if (e.key === 'ArrowRight') setPosition((p) => Math.min(100, p + 5));
    else if (e.key === 'Home') setPosition(0);
    else if (e.key === 'End') setPosition(100);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn('relative select-none overflow-hidden rounded-xl', className)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      aria-label={`${beforeLabel} vs ${afterLabel} comparison slider`}
    >
      {/* After (full width, base layer) */}
      <img src={afterSrc} alt={afterAlt} className="block h-full w-full object-cover" draggable={false} />

      {/* Before (clipped to left of divider) */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${position}%` }}
        aria-hidden="true"
      >
        <img
          src={beforeSrc}
          alt={beforeAlt}
          className="block h-full w-full object-cover"
          style={{ width: containerRef.current?.offsetWidth ?? '100%' }}
          draggable={false}
        />
      </div>

      {/* Divider line */}
      <div
        className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_4px_rgba(0,0,0,0.5)]"
        style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
        aria-hidden="true"
      />

      {/* Drag handle */}
      <div
        role="slider"
        tabIndex={0}
        aria-valuenow={Math.round(position)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Comparison divider"
        className={cn(
          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2',
          'flex h-9 w-9 cursor-grab items-center justify-center rounded-full',
          'border-2 border-white bg-white shadow-lg',
          'focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
          isDragging && 'cursor-grabbing'
        )}
        style={{ left: `${position}%` }}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <svg className="h-5 w-5 text-[var(--color-text-secondary)]" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 5a1 1 0 100 2h1V5H8zm3 0h1a1 1 0 010 2h-1V5zm-3 8h1v-2H8v2zm3 0h1a1 1 0 000-2h-1v2zM7 9a1 1 0 000 2h6a1 1 0 000-2H7z" />
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L8 8.586l1.293-1.293a1 1 0 111.414 1.414L9.414 10l1.293 1.293a1 1 0 01-1.414 1.414L8 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L6.586 10 5.293 8.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </div>

      {/* Labels */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-between">
        <span className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
          {beforeLabel}
        </span>
        <span className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
          {afterLabel}
        </span>
      </div>
    </div>
  );
}
