import { useRef } from 'react';
import type { FitMode, ResizeBackground, ResizeLayout } from '@/lib/resize-image';

/**
 * The output frame: the resized image as it will be, drawn in plain CSS. It
 * fills the stage's box (which has the output's proportions), and the image
 * sits at `layout.draw` as fractions of the frame — the same box the writer
 * draws at. The frame clips what overflows (Cover). Bars and transparent
 * pixels show the background; "transparent" lets the stage's checkerboard
 * through.
 *
 * With `onPan` (Cover, when something is cropped) the image can be dragged —
 * mouse, finger or pen — or moved with the arrow keys while the frame has
 * focus; `onPan` gets the move in output pixels.
 *
 * Test ids: `resize-frame` (`data-frame="w,h"`, `data-draw="x,y,w,h"` in output
 * pixels, `data-mode`, `data-background`, `data-pannable`) and
 * `resize-frame-image`.
 */
interface OutputFrameProps {
  layout: ResizeLayout;
  src: string;
  alt: string;
  mode: FitMode;
  background: ResizeBackground;
  /** CSS colour of the background, or null for transparent. */
  fill: string | null;
  onPan?: (dx: number, dy: number) => void;
}

const round = (v: number) => Math.round(v * 100) / 100;

export default function OutputFrame({ layout, src, alt, mode, background, fill, onPan }: OutputFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const { width: W, height: H, draw } = layout;

  /** Output pixels per CSS pixel at the current zoom. */
  const scale = () => {
    const el = ref.current;
    return el && el.clientWidth > 0 ? W / el.clientWidth : 1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onPan) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!onPan || !d || d.id !== e.pointerId) return;
    const k = scale();
    onPan((e.clientX - d.x) * k, (e.clientY - d.y) * k);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onPan) return;
    // A key moves the image by 1% of the frame (10% with Shift).
    const step = (e.shiftKey ? 0.1 : 0.01) * Math.max(W, H);
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    onPan(m[0], m[1]);
  };

  return (
    <div
      ref={ref}
      data-testid="resize-frame"
      data-frame={`${W},${H}`}
      data-draw={`${round(draw.x)},${round(draw.y)},${round(draw.w)},${round(draw.h)}`}
      data-mode={mode}
      data-background={background}
      data-pannable={onPan ? 'true' : 'false'}
      role={onPan ? 'group' : undefined}
      aria-label={onPan ? 'Crop position: drag the image or use the arrow keys' : undefined}
      tabIndex={onPan ? 0 : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className={
        'absolute inset-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ' +
        (onPan ? 'cursor-grab touch-none active:cursor-grabbing' : '')
      }
      style={fill ? { background: fill } : undefined}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        data-testid="resize-frame-image"
        className="pointer-events-none absolute block select-none"
        style={{
          left: `${(draw.x / W) * 100}%`,
          top: `${(draw.y / H) * 100}%`,
          width: `${(draw.w / W) * 100}%`,
          height: `${(draw.h / H) * 100}%`,
          maxWidth: 'none',
          maxHeight: 'none',
        }}
      />
    </div>
  );
}
