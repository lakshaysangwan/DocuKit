import { useEffect, useRef, useState } from 'react';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';

export interface WatermarkPreviewOptions {
  type: 'text' | 'image';
  text: string;
  fontSize: number;
  color: string;
  opacity: number;
  rotation: number;
  placement: 'center' | 'tiled';
  imageDataUrl: string | null;
}

interface Props {
  buffer: ArrayBuffer | null;
  options: WatermarkPreviewOptions;
}

interface PageRender {
  bg: HTMLImageElement;
  width: number; // PDF points (scale 1)
  height: number;
}

/**
 * Live, before-you-commit preview of the watermark on page 1. Renders the page
 * once with pdf.js, then re-composites the watermark on a canvas whenever an
 * option changes — so opacity/rotation/size/placement/text are all visible
 * without downloading.
 */
export default function WatermarkPreview({ buffer, options }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageRender, setPageRender] = useState<PageRender | null>(null);
  const imgCacheRef = useRef<{ url: string; img: HTMLImageElement } | null>(null);

  // Render page 1 to an image whenever the source PDF changes.
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

  // Preload watermark image (if any).
  useEffect(() => {
    if (options.type !== 'image' || !options.imageDataUrl) { imgCacheRef.current = null; return; }
    if (imgCacheRef.current?.url === options.imageDataUrl) return;
    const img = new Image();
    img.onload = () => { imgCacheRef.current = { url: options.imageDataUrl!, img }; redraw(); };
    img.src = options.imageDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.imageDataUrl, options.type]);

  // Composite whenever the page or any option changes.
  const redraw = () => {
    const canvas = canvasRef.current;
    const pr = pageRender;
    if (!canvas || !pr) return;
    const canvasW = pr.bg.naturalWidth;
    const canvasH = pr.bg.naturalHeight;
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.drawImage(pr.bg, 0, 0, canvasW, canvasH);

    const scale = canvasW / pr.width; // px per PDF point
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, options.opacity / 100));

    const drawOne = (cx: number, cy: number) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((options.rotation * Math.PI) / 180);
      if (options.type === 'text') {
        const fs = options.fontSize * scale;
        ctx.font = `bold ${fs}px Helvetica, Arial, sans-serif`;
        ctx.fillStyle = options.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(options.text || ' ', 0, 0);
      } else if (imgCacheRef.current) {
        const im = imgCacheRef.current.img;
        const w = options.fontSize * scale * 4;
        const h = (im.naturalHeight / im.naturalWidth) * w;
        ctx.drawImage(im, -w / 2, -h / 2, w, h);
      }
      ctx.restore();
    };

    if (options.placement === 'tiled') {
      const stepX = canvasW / 3;
      const stepY = canvasH / 4;
      for (let gx = 0; gx < 3; gx++) {
        for (let gy = 0; gy < 4; gy++) {
          drawOne(stepX * (gx + 0.5), stepY * (gy + 0.5));
        }
      }
    } else {
      drawOne(canvasW / 2, canvasH / 2);
    }
    ctx.restore();
  };

  useEffect(redraw, [
    pageRender,
    options.type,
    options.text,
    options.fontSize,
    options.color,
    options.opacity,
    options.rotation,
    options.placement,
  ]);

  if (!buffer) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-[var(--color-text-muted)]">Live preview (page 1)</p>
      <div className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
        {pageRender ? (
          <canvas
            ref={canvasRef}
            data-testid="watermark-preview"
            className="block h-auto w-full"
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
