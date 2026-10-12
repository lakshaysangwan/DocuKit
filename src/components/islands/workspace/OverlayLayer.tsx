import { createContext, useContext, useId, useRef, type ReactNode } from 'react';
import type { RectNorm } from '@/lib/pdf/page-geometry';
import {
  CORNERS,
  MIN_BOX_WIDTH,
  moveRect,
  resizeFromCorner,
  sameRect,
  scaleRect,
  type Corner,
} from '@/lib/workspace/overlay-math';
import { cn } from '@/lib/utils';

/**
 * Things the visitor places on a page: a layer the size of the page, and boxes
 * in it that can be dragged, resized from the corners, and driven entirely from
 * the keyboard.
 *
 *     <PageViewer overlay={() => (
 *       <OverlayLayer onBackgroundClick={(point) => …}>
 *         {stamps.map((s) => (
 *           <OverlayBox key={s.id} rect={s.rect} label="Signature, page 1"
 *             selected={s.id === selectedId} onSelect={() => select(s.id)}
 *             onChange={(rect, phase) => …} onRemove={() => remove(s.id)}>
 *             <img src={…} className="size-full" />
 *           </OverlayBox>
 *         ))}
 *       </OverlayLayer>
 *     )} />
 *
 * Coordinates are `RectNorm`s — fractions of the displayed page — so the same
 * rectangle goes straight to `viewRectToPdfDraw` when the file is written.
 *
 * Conventions (shared with the Crop preview, which the owner approved):
 * handles are 14px squares with a 28px hit area (44px for a finger), placed
 * just outside the corners so they never cover what is in the box; the resize
 * cursors appear only over handles and `move` only over the box; pointer events
 * with capture, so a drag survives leaving the element; `touch-action: none` on
 * the box and its handles only, so a finger anywhere else still scrolls.
 */

interface LayerContextValue {
  /** The layer element, whose box is the page's box. */
  layer: React.RefObject<HTMLDivElement | null>;
  /** id of the keyboard instructions, for `aria-describedby`. */
  helpId: string;
}

const LayerContext = createContext<LayerContextValue | null>(null);

export interface OverlayLayerProps {
  children?: ReactNode;
  /**
   * A click (or tap) on the page itself, not on a box. `point` is where, as
   * fractions of the page. Use it to deselect, or to move something there.
   */
  onBackgroundClick?: (point: { x: number; y: number }) => void;
  /** Stops all interaction (while the file is being written). */
  disabled?: boolean;
}

export function OverlayLayer({ children, onBackgroundClick, disabled = false }: OverlayLayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const helpId = useId();

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || e.target !== e.currentTarget || !onBackgroundClick) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    onBackgroundClick({
      x: (e.clientX - box.left) / box.width,
      y: (e.clientY - box.top) / box.height,
    });
  };

  return (
    <LayerContext.Provider value={{ layer, helpId }}>
      <div
        ref={layer}
        data-testid="overlay-layer"
        className={cn('absolute inset-0', disabled && 'pointer-events-none')}
        onClick={onClick}
      >
        <span id={helpId} className="sr-only">
          Arrow keys move it, Shift with an arrow moves it further, plus and minus resize it, Delete removes it,
          Escape deselects.
        </span>
        {children}
      </div>
    </LayerContext.Provider>
  );
}

/** `preview` while dragging, `commit` when a change is final, `cancel` if a drag was abandoned. */
export type OverlayChangePhase = 'preview' | 'commit' | 'cancel';

export interface OverlayBoxProps {
  /** Where the box is, as fractions of the displayed page (top-left origin). */
  rect: RectNorm;
  /**
   * The box moved or changed size. During a drag this is called with `preview`
   * for every pointer move and once with `commit` at the end; keyboard changes
   * are a single `commit`. `source` says what did it, so nudges can be merged
   * into one undo step.
   */
  onChange: (rect: RectNorm, phase: OverlayChangePhase, source: 'pointer' | 'keyboard') => void;
  selected: boolean;
  onSelect: () => void;
  /** Escape was pressed on the box. */
  onDeselect?: () => void;
  /** Delete or Backspace was pressed on the box. */
  onRemove?: () => void;
  /** Keep the shape when resizing. Defaults to true. */
  lockAspect?: boolean;
  /** Smallest width as a fraction of the page width. */
  minWidth?: number;
  /** The accessible name: "Signature, page 3". */
  label: string;
  /** A short tag shown on the selected box: "Drag to move · corners to resize". */
  hint?: string;
  disabled?: boolean;
  /** Extra data attributes for tests are passed through `data-kind`. */
  kind?: string;
  children?: ReactNode;
}

/**
 * Where each handle sits: OUTSIDE its corner, touching it, with the hit area
 * growing outwards from there. A signature is often only a few pixels tall on a
 * small screen; handles centred on its corners would cover the signature, and
 * their hit areas would cover the whole box and leave nothing to drag it by.
 */
const HANDLE_POSITION: Record<Corner, string> = {
  'top-left': 'left-0 top-0 -translate-x-full -translate-y-full items-end justify-end cursor-nwse-resize',
  'top-right': 'left-full top-0 -translate-y-full items-end justify-start cursor-nesw-resize',
  'bottom-right': 'left-full top-full items-start justify-start cursor-nwse-resize',
  'bottom-left': 'left-0 top-full -translate-x-full items-start justify-end cursor-nesw-resize',
};

const HANDLE_LABEL: Record<Corner, string> = {
  'top-left': 'Resize from the top-left corner',
  'top-right': 'Resize from the top-right corner',
  'bottom-right': 'Resize from the bottom-right corner',
  'bottom-left': 'Resize from the bottom-left corner',
};

/** Arrow keys move by this fraction of the page width. */
const NUDGE = 1 / 200;
const NUDGE_LARGE = 10;
/** `+` and `-` resize by this much. */
export const RESIZE_STEP = 1.05;
/** A press that moves less than this many pixels is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

interface Drag {
  pointerId: number;
  target: Corner | 'move';
  startX: number;
  startY: number;
  start: RectNorm;
  /** Page size in CSS pixels when the drag began. */
  pageWidth: number;
  pageHeight: number;
  moved: boolean;
  last: RectNorm;
}

const percent = (n: number) => `${n * 100}%`;

export function OverlayBox({
  rect,
  onChange,
  selected,
  onSelect,
  onDeselect,
  onRemove,
  lockAspect = true,
  minWidth = MIN_BOX_WIDTH,
  label,
  hint,
  disabled = false,
  kind,
  children,
}: OverlayBoxProps) {
  const context = useContext(LayerContext);
  const drag = useRef<Drag | null>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const begin = (e: React.PointerEvent<HTMLElement>, target: Corner | 'move') => {
    if (disabled || e.button !== 0) return;
    const page = context?.layer.current?.getBoundingClientRect();
    if (!page || !page.width || !page.height) return;
    e.stopPropagation();
    onSelect();
    // Capture, so the drag keeps following a finger, pen or mouse that leaves the box.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks cannot be captured; the drag
      // still works while it stays over the box.
    }
    drag.current = {
      pointerId: e.pointerId,
      target,
      startX: e.clientX,
      startY: e.clientY,
      start: rectRef.current,
      pageWidth: page.width,
      pageHeight: page.height,
      moved: false,
      last: rectRef.current,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dxPx = e.clientX - d.startX;
    const dyPx = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const dx = dxPx / d.pageWidth;
    const dy = dyPx / d.pageHeight;
    d.last =
      d.target === 'move'
        ? moveRect(d.start, dx, dy)
        : resizeFromCorner(d.start, d.target, dx, dy, { lockAspect, minWidth });
    onChange(d.last, 'preview', 'pointer');
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    if (cancelled) onChange(d.start, 'cancel', 'pointer');
    else onChange(d.last, sameRect(d.last, d.start) ? 'cancel' : 'commit', 'pointer');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || e.target !== e.currentTarget) return;
    const page = context?.layer.current?.getBoundingClientRect();
    // The same distance on screen in both directions, whatever the page's shape.
    const stepX = NUDGE * (e.shiftKey ? NUDGE_LARGE : 1);
    const stepY = page && page.height ? stepX * (page.width / page.height) : stepX;
    let next: RectNorm;
    switch (e.key) {
      case 'ArrowLeft':
        next = moveRect(rect, -stepX, 0);
        break;
      case 'ArrowRight':
        next = moveRect(rect, stepX, 0);
        break;
      case 'ArrowUp':
        next = moveRect(rect, 0, -stepY);
        break;
      case 'ArrowDown':
        next = moveRect(rect, 0, stepY);
        break;
      case '+':
      case '=':
        next = scaleRect(rect, RESIZE_STEP, { minWidth });
        break;
      case '-':
      case '_':
        next = scaleRect(rect, 1 / RESIZE_STEP, { minWidth });
        break;
      case 'Delete':
      case 'Backspace':
        if (onRemove) {
          e.preventDefault();
          onRemove();
        }
        return;
      case 'Escape':
        if (onDeselect) {
          e.preventDefault();
          onDeselect();
        }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (!selected) onSelect();
    if (!sameRect(next, rect)) onChange(next, 'commit', 'keyboard');
  };

  // The tag sits above the box unless the box is at the very top of the page.
  const hintBelow = rect.y < 0.07;

  return (
    <div
      role="group"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-describedby={context?.helpId}
      aria-roledescription="movable item"
      data-testid="overlay-item"
      data-kind={kind}
      data-selected={selected ? 'true' : 'false'}
      // The frame is an outline, not a border: an outline takes no room, so the
      // content fills exactly the rectangle that will be written to the file.
      className={cn(
        'absolute touch-none rounded-none outline-offset-0 outline-[var(--color-primary)]',
        !disabled && 'cursor-move',
        selected
          ? 'z-10 outline-2 outline-solid shadow-[0_0_0_3px_rgba(255,255,255,0.9)]'
          : 'outline-1 outline-dashed',
        'focus-visible:shadow-[0_0_0_3px_rgba(255,255,255,0.9),0_0_0_6px_color-mix(in_srgb,var(--color-primary)_45%,transparent)]',
      )}
      style={{
        left: percent(rect.x),
        top: percent(rect.y),
        width: percent(rect.width),
        height: percent(rect.height),
      }}
      onPointerDown={(e) => begin(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onFocus={(e) => {
        if (e.target === e.currentTarget && !selected && !disabled) onSelect();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {/* The grab area: the box itself, but never smaller than a fingertip. */}
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 size-full min-h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      />
      {children}

      {selected && hint && (
        <span
          data-testid="overlay-hint"
          aria-hidden="true"
          className={cn(
            // Fixed colours: it sits on the page, which is white in both themes.
            'pointer-events-none absolute left-0 z-10 whitespace-nowrap rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-white',
            hintBelow ? 'top-full mt-3' : 'bottom-full mb-3',
          )}
        >
          {hint}
        </span>
      )}

      {selected &&
        !disabled &&
        CORNERS.map((corner) => (
          <button
            key={corner}
            type="button"
            tabIndex={-1}
            aria-label={HANDLE_LABEL[corner]}
            data-testid={`overlay-handle-${corner}`}
            className={cn(
              'group absolute z-20 flex size-7 touch-none pointer-coarse:size-11',
              HANDLE_POSITION[corner],
            )}
            onPointerDown={(e) => begin(e, corner)}
            // Stopped here: the box listens for the same events for its own drag.
            onPointerMove={(e) => {
              e.stopPropagation();
              onPointerMove(e);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              finish(e, false);
            }}
            onPointerCancel={(e) => {
              e.stopPropagation();
              finish(e, true);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              aria-hidden="true"
              className="block size-3.5 rounded-[3px] border-2 border-white bg-[var(--color-primary)] shadow-[0_0_0_1px_rgba(0,0,0,0.6)] transition-transform group-hover:scale-125"
            />
          </button>
        ))}
    </div>
  );
}
