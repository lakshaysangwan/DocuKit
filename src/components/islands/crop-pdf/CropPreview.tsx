import { useEffect, useRef, useState, useCallback } from 'react';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';

export interface MarginsPt {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type CropUnit = 'mm' | 'pt';

/** PDF points per millimetre, as the margin fields and the crop itself use it. */
export const MM_TO_PT = 2.8346;

interface Props {
  buffer: ArrayBuffer | null;
  /** Current crop margins in PDF points. */
  marginsPt: MarginsPt;
  onChangePt: (next: MarginsPt) => void;
  /** Unit of the margin fields: the size readout and the keyboard step follow it. */
  unit: CropUnit;
}

interface PageRender {
  bg: HTMLImageElement;
  width: number; // points
  height: number;
}

type Side = 'top' | 'right' | 'bottom' | 'left';

interface Handle {
  id: string;
  label: string;
  sides: Side[];
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
const EDGES: { side: Side; strip: string; line: string }[] = [
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

/** The crop box never gets smaller than this, in points. */
const MIN_BOX_PT = 10;
/** Shift + arrow moves a handle this many units instead of one. */
const LARGE_STEP = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Move the given sides by a pointer delta (in points), keeping the box on the page. */
function resizeMargins(start: MarginsPt, sides: Side[], dx: number, dy: number, page: PageRender): MarginsPt {
  const m = { ...start };
  if (sides.includes('top')) m.top = clamp(start.top + dy, 0, page.height - m.bottom - MIN_BOX_PT);
  if (sides.includes('bottom')) m.bottom = clamp(start.bottom - dy, 0, page.height - m.top - MIN_BOX_PT);
  if (sides.includes('left')) m.left = clamp(start.left + dx, 0, page.width - m.right - MIN_BOX_PT);
  if (sides.includes('right')) m.right = clamp(start.right - dx, 0, page.width - m.left - MIN_BOX_PT);
  return m;
}

/** Slide the whole box by a pointer delta (in points) without changing its size. */
function moveMargins(start: MarginsPt, dx: number, dy: number): MarginsPt {
  const mx = clamp(dx, -start.left, start.right);
  const my = clamp(dy, -start.top, start.bottom);
  return { top: start.top + my, bottom: start.bottom - my, left: start.left + mx, right: start.right - mx };
}

const percent = (part: number, whole: number) => `${clamp((part / whole) * 100, 0, 100)}%`;

function formatSize(pt: number, unit: CropUnit): string {
  const v = Math.max(0, pt);
  return unit === 'mm' ? String(Math.round((v / MM_TO_PT) * 10) / 10) : String(Math.round(v));
}

interface Drag {
  pointerId: number;
  target: Side[] | 'move';
  startX: number;
  startY: number;
  start: MarginsPt;
  /** Points per CSS pixel of the displayed page. */
  scaleX: number;
  scaleY: number;
}

/**
 * Visual crop editor: renders page 1 with a draggable crop box that stays in
 * sync with the numeric margin inputs, dims the area being cropped away, and
 * offers one-click auto-crop of surrounding whitespace.
 *
 * The page and the dimming are painted on the canvas; the box, its edges and its
 * eight handles are real elements on top, so the pointer only changes where
 * something can be dragged and every handle can be reached from the keyboard.
 */
export default function CropPreview({ buffer, marginsPt, onChangePt, unit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [pageRender, setPageRender] = useState<PageRender | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const marginsRef = useRef(marginsPt);
  marginsRef.current = marginsPt;

  useEffect(() => {
    let cancelled = false;
    if (!buffer) { setPageRender(null); return; }
    (async () => {
      try {
        const pdfjsLib = await getPdfjs();
        const doc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: buffer.slice(0) }).promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 900 / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext('2d')!;
        await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
        if (cancelled) return;
        const img = new Image();
        img.onload = () => { if (!cancelled) setPageRender({ bg: img, width: base.width, height: base.height }); };
        img.src = c.toDataURL('image/jpeg', 0.85);
        doc.destroy();
      } catch {
        if (!cancelled) setPageRender(null);
      }
    })();
    return () => { cancelled = true; };
  }, [buffer]);

  // Crop rectangle in canvas pixels from current margins.
  const rectPx = useCallback(() => {
    const pr = pageRender!;
    const cw = pr.bg.naturalWidth;
    const ch = pr.bg.naturalHeight;
    const m = marginsRef.current;
    return {
      cw, ch,
      x0: (m.left / pr.width) * cw,
      x1: cw - (m.right / pr.width) * cw,
      y0: (m.top / pr.height) * ch,
      y1: ch - (m.bottom / pr.height) * ch,
    };
  }, [pageRender]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const pr = pageRender;
    if (!canvas || !pr) return;
    const cw = pr.bg.naturalWidth;
    const ch = pr.bg.naturalHeight;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(pr.bg, 0, 0, cw, ch);

    const { x0, x1, y0, y1 } = rectPx();
    // Dim the cropped-away region. The box outline and handles are elements.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, cw, y0);
    ctx.fillRect(0, y1, cw, ch - y1);
    ctx.fillRect(0, y0, x0, y1 - y0);
    ctx.fillRect(x1, y0, cw - x1, y1 - y0);
  }, [pageRender, rectPx]);

  useEffect(redraw, [redraw, marginsPt]);

  const startDrag = (e: React.PointerEvent<HTMLElement>, target: Side[] | 'move', id: string) => {
    const pr = pageRender;
    const frame = frameRef.current;
    if (!pr || !frame || e.button !== 0) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Capture, so the drag keeps following a finger, pen or mouse that leaves the handle.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      target,
      startX: e.clientX,
      startY: e.clientY,
      start: { ...marginsRef.current },
      scaleX: pr.width / rect.width,
      scaleY: pr.height / rect.height,
    };
    setActive(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const pr = pageRender;
    if (!drag || !pr || e.pointerId !== drag.pointerId) return;
    const dx = (e.clientX - drag.startX) * drag.scaleX;
    const dy = (e.clientY - drag.startY) * drag.scaleY;
    onChangePt(
      drag.target === 'move'
        ? moveMargins(drag.start, dx, dy)
        : resizeMargins(drag.start, drag.target, dx, dy, pr),
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setActive(null);
  };

  // Arrow keys nudge a focused handle by one unit of the margin fields.
  const onHandleKey = (e: React.KeyboardEvent, sides: Side[]) => {
    const pr = pageRender;
    if (!pr) return;
    const step = (unit === 'mm' ? MM_TO_PT : 1) * (e.shiftKey ? LARGE_STEP : 1);
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
    onChangePt(resizeMargins(marginsRef.current, sides, dx, dy, pr));
  };

  // Detect the content bounding box on page 1 and set margins to the surrounding
  // whitespace (with a small padding).
  const autoCrop = useCallback(() => {
    const pr = pageRender;
    if (!pr) return;
    const cw = pr.bg.naturalWidth;
    const ch = pr.bg.naturalHeight;
    const tmp = document.createElement('canvas');
    tmp.width = cw; tmp.height = ch;
    const ctx = tmp.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(pr.bg, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    let minX = cw, minY = ch, maxX = 0, maxY = 0;
    const THRESH = 245; // treat near-white as background
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        if (data[i] < THRESH || data[i + 1] < THRESH || data[i + 2] < THRESH) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) return; // blank page
    const pad = 4; // px padding around content
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(cw, maxX + pad); maxY = Math.min(ch, maxY + pad);
    onChangePt({
      left: Math.round((minX / cw) * pr.width),
      right: Math.round(((cw - maxX) / cw) * pr.width),
      top: Math.round((minY / ch) * pr.height),
      bottom: Math.round(((ch - maxY) / ch) * pr.height),
    });
  }, [pageRender, onChangePt]);

  if (!buffer) return null;

  // The box can only be slid around once something has been cropped off.
  const movable = marginsPt.top + marginsPt.bottom > 0 || marginsPt.left + marginsPt.right > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--color-text-muted)]" data-testid="crop-hint">
          Drag the handles to crop (page 1). Arrow keys nudge a focused handle.
        </p>
        <button
          type="button"
          onClick={autoCrop}
          disabled={!pageRender}
          data-testid="crop-autocrop"
          className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[var(--color-primary)] disabled:opacity-50"
        >
          Auto-crop whitespace
        </button>
      </div>
      {/* The padding leaves room for handles that sit on the very edge of the page. */}
      <div className="mx-auto w-full max-w-[26rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4">
        {pageRender ? (
          <div ref={frameRef} className="relative select-none">
            <canvas
              ref={canvasRef}
              data-testid="crop-preview"
              width={pageRender.bg.naturalWidth}
              height={pageRender.bg.naturalHeight}
              className="block h-auto w-full"
            />
            <div
              role="group"
              aria-label="Crop area"
              data-testid="overlay-item"
              className="absolute border-2 border-[var(--color-primary)] outline outline-1 outline-white/80"
              style={{
                top: percent(marginsPt.top, pageRender.height),
                right: percent(marginsPt.right, pageRender.width),
                bottom: percent(marginsPt.bottom, pageRender.height),
                left: percent(marginsPt.left, pageRender.width),
              }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            >
              {/* Inside the box: slide the whole crop area. Mouse only, so a
                  finger on the page still scrolls it. */}
              <div
                data-testid="crop-move"
                className={`absolute inset-0 ${movable ? 'cursor-move' : ''}`}
                onPointerDown={(e) => { if (movable && e.pointerType === 'mouse') startDrag(e, 'move', 'move'); }}
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
          </div>
        ) : (
          // Page-shaped while it loads, so the controls below barely move when the page appears.
          <div className="flex aspect-[210/297] items-center justify-center text-xs text-[var(--color-text-muted)]">
            Rendering preview…
          </div>
        )}
      </div>
      {/* Always in the layout, so it does not push the button down when it fills in. */}
      <p
        className="min-h-4 text-center text-xs text-[var(--color-text-muted)]"
        data-testid="crop-size-readout"
        aria-live="polite"
      >
        {pageRender && (
          <>
            Page 1 after crop:{' '}
            {formatSize(pageRender.width - marginsPt.left - marginsPt.right, unit)} ×{' '}
            {formatSize(pageRender.height - marginsPt.top - marginsPt.bottom, unit)} {unit}
          </>
        )}
      </p>
    </div>
  );
}
