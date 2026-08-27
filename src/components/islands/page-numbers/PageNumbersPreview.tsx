import { useEffect, useRef, useState } from 'react';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';
import type { PageNumberOptions } from '@/types/worker-messages';

interface Props {
  buffer: ArrayBuffer | null;
  options: Pick<PageNumberOptions, 'position' | 'format' | 'startNumber' | 'skipFirstN' | 'fontSize' | 'color' | 'marginX' | 'marginY'>;
}

interface PageRender {
  bg: HTMLImageElement;
  width: number;
  height: number;
  total: number;
}

const mmToPoints = (mm: number) => mm * 2.834645669;

function romanize(n: number): string {
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  let v = n;
  for (const [num, sym] of map) while (v >= num) { out += sym; v -= num; }
  return out || 'i';
}

function alpha(n: number): string {
  let v = n;
  let s = '';
  while (v > 0) { v--; s = String.fromCharCode(97 + (v % 26)) + s; v = Math.floor(v / 26); }
  return s || 'a';
}

function labelFor(pageNum: number, total: number, format: PageNumberOptions['format']): string {
  switch (format) {
    case 'n': return String(pageNum);
    case 'page-n': return `Page ${pageNum}`;
    case 'page-n-of-total': return `Page ${pageNum} of ${total}`;
    case 'n-of-total': return `${pageNum}/${total}`;
    case 'roman': return romanize(pageNum);
    case 'alpha': return alpha(pageNum);
    default: return String(pageNum);
  }
}

/**
 * Live preview of page numbering on page 1, mirroring the worker's placement
 * (mm margins, bottom-left origin) so position/format/size/start/skip are all
 * visible before applying.
 */
export default function PageNumbersPreview({ buffer, options }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageRender, setPageRender] = useState<PageRender | null>(null);

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
        const total = doc.numPages;
        const img = new Image();
        img.onload = () => { if (!cancelled) setPageRender({ bg: img, width: base.width, height: base.height, total }); };
        img.src = c.toDataURL('image/jpeg', 0.85);
        doc.destroy();
      } catch {
        if (!cancelled) setPageRender(null);
      }
    })();
    return () => { cancelled = true; };
  }, [buffer]);

  const redraw = () => {
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

    const skip = options.skipFirstN ?? 0;
    if (skip >= 1) return; // page 1 is skipped — nothing to show

    const scale = cw / pr.width;
    const total = pr.total - skip;
    const pageNum = 0 - skip + (options.startNumber ?? 1);
    const label = labelFor(pageNum, total, options.format);
    const fontSize = (options.fontSize ?? 10) * scale;
    const marginX = mmToPoints(options.marginX ?? 20) * scale;
    const marginY = mmToPoints(options.marginY ?? 15) * scale;

    ctx.font = `${fontSize}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = options.color ?? '#333333';
    ctx.textBaseline = 'alphabetic';
    const textW = ctx.measureText(label).width;

    // Compute in PDF space (bottom-left), then flip Y for canvas.
    let x: number;
    let pdfY: number;
    const W = pr.width * scale;
    const H = pr.height * scale;
    switch (options.position) {
      case 'bottom-left': x = marginX; pdfY = marginY; break;
      case 'bottom-right': x = W - marginX - textW; pdfY = marginY; break;
      case 'top-center': x = W / 2 - textW / 2; pdfY = H - marginY - fontSize; break;
      case 'top-left': x = marginX; pdfY = H - marginY - fontSize; break;
      case 'top-right': x = W - marginX - textW; pdfY = H - marginY - fontSize; break;
      case 'bottom-center':
      default: x = W / 2 - textW / 2; pdfY = marginY;
    }
    // pdfY is the text baseline from the bottom; canvas y is from the top.
    const canvasY = ch - pdfY;
    ctx.fillText(label, x, canvasY);
  };

  useEffect(redraw, [
    pageRender,
    options.position,
    options.format,
    options.startNumber,
    options.skipFirstN,
    options.fontSize,
    options.color,
    options.marginX,
    options.marginY,
  ]);

  if (!buffer) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-[var(--color-text-muted)]">Live preview (page 1)</p>
      <div className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
        {pageRender ? (
          <canvas ref={canvasRef} data-testid="page-numbers-preview" className="block h-auto w-full" />
        ) : (
          <div className="flex h-64 items-center justify-center text-xs text-[var(--color-text-muted)]">
            Rendering preview…
          </div>
        )}
      </div>
    </div>
  );
}
