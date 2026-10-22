import { useRef, useState } from 'react';
import type { PageFrame } from '@/components/islands/workspace/PageViewer';
import {
  POINTS_PER,
  moveMargins,
  resizeMargins,
  snapMargins,
  hasCrop,
  type CropMargins,
  type CropSide,
  type CropUnit,
} from '@/lib/crop-layout';

interface Props {
  /** The page shown in the viewer, as `PageViewer` hands it to its overlay. */
  frame: PageFrame;
  /** Current crop margins in displayed points (visual top/right/bottom/left). */
  margins: CropMargins;
  onChange: (next: CropMargins) => void;
  /** Unit of the margin fields: dragged values snap to it and the keyboard step follows it. */
  unit: CropUnit;
}

interface Handle {
  id: string;
  label: string;
  sides: CropSide[];
  /** Where the handle sits on the crop box. */
  position: string;
  cursor: string;
}

/** Corners and edge midpoints, clockwise from the top-left — also the tab order. */
const HANDLES: Handle[] = [
  { id: 'top-left', label: 'Top-left corner', sides: ['top', 'left'], position: 'left-0 top-0', cursor: 'cursor-nwse-resize' },
  { id: 'top', label: 'Top edge', sides: ['top'], position: 'left-1/2 top-0', cursor: 'cursor-ns-resize' },
  { id: 'top-right', label: 'Top-right corner', sides: ['top', 'right'], position: 'left-full top-0', cursor: 'cursor-nesw-resize' },
  { id: 'right', label: 'Right edge', sides: ['right'], position: 'left-full top-1/2', cursor: 'cursor-ew-resize' },
  { id: 'bottom-right', label: 'Bottom-right corner', sides: ['bottom', 'right'], position: 'left-full top-full', cursor: 'cursor-nwse-resize' },
  { id: 'bottom', label: 'Bottom edge', sides: ['bottom'], position: 'left-1/2 top-full', cursor: 'cursor-ns-resize' },
  { id: 'bottom-left', label: 'Bottom-left corner', sides: ['bottom', 'left'], position: 'left-0 top-full', cursor: 'cursor-nesw-resize' },
  { id: 'left', label: 'Left edge', sides: ['left'], position: 'left-0 top-1/2', cursor: 'cursor-ew-resize' },
];

/** The whole edge between the handles is a grab zone too (16px; 24px on touch). */
const EDGES: { side: CropSide; strip: string; line: string }[] = [
  {
    side: 'top',
    strip: 'inset-x-0 top-0 h-4 -translate-y-1/2 cursor-ns-resize pointer-coarse:h-6',
    line: 'inset-x-0 top-1/2 h-1 -translate-y-1/2',
  },
  {
    side: 'bottom',
    strip: 'inset-x-0 bottom-0 h-4 translate-y-1/2 cursor-ns-resize pointer-coarse:h-6',
    line: 'inset-x-0 top-1/2 h-1 -translate-y-1/2',
  },
  {
    side: 'left',
    strip: 'inset-y-0 left-0 w-4 -translate-x-1/2 cursor-ew-resize pointer-coarse:w-6',
    line: 'inset-y-0 left-1/2 w-1 -translate-x-1/2',
  },
  {
    side: 'right',
    strip: 'inset-y-0 right-0 w-4 translate-x-1/2 cursor-ew-resize pointer-coarse:w-6',
    line: 'inset-y-0 left-1/2 w-1 -translate-x-1/2',
  },
];

/** Shift + arrow moves a handle this many units instead of one. */
const LARGE_STEP = 10;

const percent = (part: number, whole: number) => `${Math.max(0, Math.min((part / whole) * 100, 100))}%`;

interface Drag {
  pointerId: number;
  target: CropSide[] | 'move';
  startX: number;
  startY: number;
  start: CropMargins;
  /** Points per CSS pixel of the displayed page. */
  scaleX: number;
  scaleY: number;
}

/**
 * The crop box over the page shown in the viewer: the area being cropped away
 * is dimmed, and the box, its edges and its eight handles are real elements, so
 * the pointer only changes where something can be dragged and every handle can
 * be reached from the keyboard.
 *
 * Margins are in displayed points — the page as the visitor sees it, after
 * `/Rotate` — so the box is placed with plain percentages of the page.
 *
 * Inside the box (once something is cropped off) the whole box slides, by
 * mouse, pen or finger; only there and on the handles does a touch belong to
 * the box — anywhere else the page scrolls as usual.
 *
 * Test ids: `crop-preview` (the page layer with the dimming), `overlay-item`
 * (the box), `crop-move`, `crop-edge-{side}`, `overlay-handle-{id}`.
 */
export default function CropPreview({ frame, margins, onChange, unit }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const marginsRef = useRef(margins);
  marginsRef.current = margins;

  const page = { width: frame.geometry.widthPt, height: frame.geometry.heightPt };

  const startDrag = (e: React.PointerEvent<HTMLElement>, target: CropSide[] | 'move', id: string) => {
    if (e.button !== 0) return;
    // Capture, so the drag keeps following a finger, pen or mouse that leaves the handle.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      target,
      startX: e.clientX,
      startY: e.clientY,
      start: { ...marginsRef.current },
      scaleX: page.width / frame.widthPx,
      scaleY: page.height / frame.heightPx,
    };
    setActive(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = (e.clientX - drag.startX) * drag.scaleX;
    const dy = (e.clientY - drag.startY) * drag.scaleY;
    const next = drag.target === 'move' ? moveMargins(drag.start, dx, dy) : resizeMargins(drag.start, drag.target, dx, dy, page);
    // Snapped to what the fields can show, so the file gets exactly the numbers on screen.
    onChange(snapMargins(next, unit));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setActive(null);
  };

  // Arrow keys nudge a focused handle by one unit of the margin fields.
  const onHandleKey = (e: React.KeyboardEvent, sides: CropSide[]) => {
    const step = POINTS_PER[unit] * (unit === 'in' ? 0.1 : 1) * (e.shiftKey ? LARGE_STEP : 1);
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    const movesAcross = sides.includes('left') || sides.includes('right');
    const movesDown = sides.includes('top') || sides.includes('bottom');
    if ((dx !== 0 && !movesAcross) || (dy !== 0 && !movesDown)) return;
    e.preventDefault();
    onChange(snapMargins(resizeMargins(marginsRef.current, sides, dx, dy, page), unit));
  };

  // The box can only be slid around once something has been cropped off.
  const movable = hasCrop(margins);
  const box = {
    top: percent(margins.top, page.height),
    right: percent(margins.right, page.width),
    bottom: percent(margins.bottom, page.height),
    left: percent(margins.left, page.width),
  };

  return (
    <>
      {/* The dimming: a shadow around the box, clipped to the page. */}
      <div data-testid="crop-preview" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute shadow-[0_0_0_200vmax_rgba(0,0,0,0.45)]" style={box} />
      </div>
      <div
        role="group"
        aria-label={`Crop area on page ${frame.pageIndex + 1}`}
        data-testid="overlay-item"
        className="absolute border-2 border-[var(--color-primary)] outline outline-1 outline-white/80"
        style={box}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {/* Inside the box: slide the whole crop area, with any pointer. Until
            something is cropped off there is nothing to slide, and a finger
            on the page scrolls it. */}
        <div
          data-testid="crop-move"
          className={`absolute inset-0 ${movable ? 'cursor-move touch-none' : ''}`}
          onPointerDown={(e) => {
            if (movable) startDrag(e, 'move', 'move');
          }}
        />
        {EDGES.map(({ side, strip, line }) => (
          <div
            key={side}
            data-testid={`crop-edge-${side}`}
            className={`group absolute touch-none ${strip}`}
            onPointerDown={(e) => startDrag(e, [side], side)}
          >
            <span
              aria-hidden="true"
              className={`absolute rounded-full bg-[var(--color-primary)] transition-opacity group-hover:opacity-100 ${line} ${active === side ? 'opacity-100' : 'opacity-0'}`}
            />
          </div>
        ))}
        {HANDLES.map((h) => (
          <button
            key={h.id}
            type="button"
            aria-label={h.label}
            data-testid={`overlay-handle-${h.id}`}
            data-active={active === h.id || undefined}
            className={`group absolute flex size-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center pointer-coarse:size-11 ${h.position} ${h.cursor}`}
            onPointerDown={(e) => startDrag(e, h.sides, h.id)}
            onKeyDown={(e) => onHandleKey(e, h.sides)}
          >
            <span
              aria-hidden="true"
              className={`block size-3.5 border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] transition-transform group-hover:scale-125 group-focus-visible:scale-125 ${h.sides.length === 2 ? 'rounded-[3px]' : 'rounded-full'} ${active === h.id ? 'scale-125 border-[var(--color-primary)] bg-white' : 'border-white bg-[var(--color-primary)]'}`}
            />
          </button>
        ))}
      </div>
    </>
  );
}
