import { useEffect, useRef, useState, useCallback } from 'react';
import { getPdfjs } from '@/lib/pdfjs';

export interface MarginsPt {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Props {
  buffer: ArrayBuffer | null;
  /** Current crop margins in PDF points. */
  marginsPt: MarginsPt;
  onChangePt: (next: MarginsPt) => void;
}

interface PageRender {
  bg: HTMLImageElement;
  width: number; // points
  height: number;
}

type Edge = 'top' | 'right' | 'bottom' | 'left' | null;
const HANDLE_TOL = 12; // px

/**
 * Visual crop editor: renders page 1 with a draggable crop rectangle that stays
 * in sync with the numeric margin inputs, dims the area being cropped away, and
 * offers one-click auto-crop of surrounding whitespace.
 */
export default function CropPreview({ buffer, marginsPt, onChangePt }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageRender, setPageRender] = useState<PageRender | null>(null);
  const dragRef = useRef<Edge>(null);
  const marginsRef = useRef(marginsPt);
  marginsRef.current = marginsPt;

  useEffect(() => {
    let cancelled = false;
    if (!buffer) { setPageRender(null); return; }
    (async () => {
      try {
        const pdfjsLib = await getPdfjs();
        const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
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
    // Dim the cropped-away region.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, cw, y0);
    ctx.fillRect(0, y1, cw, ch - y1);
    ctx.fillRect(0, y0, x0, y1 - y0);
    ctx.fillRect(x1, y0, cw - x1, y1 - y0);
    // Crop border + handles.
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = '#4F46E5';
    const mids: [number, number][] = [
      [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2],
    ];
    for (const [hx, hy] of mids) { ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fill(); }
  }, [pageRender, rectPx]);

  useEffect(redraw, [redraw, marginsPt]);

  const pointFromEvent = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pageRender) return;
    const { x, y } = pointFromEvent(e);
    const { x0, x1, y0, y1 } = rectPx();
    let edge: Edge = null;
    if (Math.abs(y - y0) < HANDLE_TOL && x > x0 - HANDLE_TOL && x < x1 + HANDLE_TOL) edge = 'top';
    else if (Math.abs(y - y1) < HANDLE_TOL && x > x0 - HANDLE_TOL && x < x1 + HANDLE_TOL) edge = 'bottom';
    else if (Math.abs(x - x0) < HANDLE_TOL && y > y0 - HANDLE_TOL && y < y1 + HANDLE_TOL) edge = 'left';
    else if (Math.abs(x - x1) < HANDLE_TOL && y > y0 - HANDLE_TOL && y < y1 + HANDLE_TOL) edge = 'right';
    if (edge) {
      dragRef.current = edge;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const edge = dragRef.current;
    const pr = pageRender;
    if (!edge || !pr) return;
    const { x, y } = pointFromEvent(e);
    const cw = pr.bg.naturalWidth;
    const ch = pr.bg.naturalHeight;
    const m = { ...marginsRef.current };
    if (edge === 'top') m.top = Math.max(0, Math.min((y / ch) * pr.height, pr.height - m.bottom - 10));
    else if (edge === 'bottom') m.bottom = Math.max(0, Math.min(((ch - y) / ch) * pr.height, pr.height - m.top - 10));
    else if (edge === 'left') m.left = Math.max(0, Math.min((x / cw) * pr.width, pr.width - m.right - 10));
    else if (edge === 'right') m.right = Math.max(0, Math.min(((cw - x) / cw) * pr.width, pr.width - m.left - 10));
    onChangePt({
      top: Math.round(m.top), right: Math.round(m.right), bottom: Math.round(m.bottom), left: Math.round(m.left),
    });
  };

  const onPointerUp = () => { dragRef.current = null; };

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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-[var(--color-text-muted)]">
          Drag the edges to crop (page 1)
        </p>
        <button
          type="button"
          onClick={autoCrop}
          disabled={!pageRender}
          data-testid="crop-autocrop"
          className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[var(--color-primary)] disabled:opacity-50"
        >
          Auto-crop whitespace
        </button>
      </div>
      <div className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
        {pageRender ? (
          <canvas
            ref={canvasRef}
            data-testid="crop-preview"
            className="block h-auto w-full cursor-crosshair touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-xs text-[var(--color-text-muted)]">
            Rendering preview…
          </div>
        )}
      </div>
    </div>
  );
}
