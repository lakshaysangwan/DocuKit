import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Points, origin at the page's bottom-left corner — as a PDF is written. */
export interface OutputRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutputMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface OutputPagePreviewProps {
  /** Page size in points. */
  pageW: number;
  pageH: number;
  /** Where the content is drawn on the page, from the tool's layout function. */
  draw: OutputRect;
  /** What is drawn there. It is stretched to fill `draw` exactly, as the PDF does. */
  children: ReactNode;
  /** Show dashed guides at these margins (points). */
  margins?: OutputMargins;
  /** Sizes the page: give it a width; the height follows from the page's proportions. */
  className?: string;
  style?: CSSProperties;
}

const percent = (part: number, whole: number) => `${(part / whole) * 100}%`;

/**
 * A page that is about to be written, drawn to scale.
 *
 * It is a box with the page's proportions and the content positioned inside it
 * by the same rectangle the writer uses, so it cannot show something the file
 * will not have. Content that runs over the edge is cut off, exactly as a PDF
 * page clips what is drawn outside it.
 *
 * Plain CSS, nothing rendered: it follows a margin field key by key.
 *
 * Test ids: `output-page` with `data-page="width,height"` and
 * `data-draw="x,y,w,h"` (points, bottom-left origin — the numbers the file
 * carries), `output-page-content`, `output-page-margins`.
 */
export default function OutputPagePreview({
  pageW,
  pageH,
  draw,
  children,
  margins,
  className,
  style,
}: OutputPagePreviewProps) {
  const guides = margins && pageW - margins.left - margins.right > 0 && pageH - margins.top - margins.bottom > 0;
  return (
    <div
      data-testid="output-page"
      data-page={`${pageW},${pageH}`}
      data-draw={`${draw.x},${draw.y},${draw.w},${draw.h}`}
      className={cn('relative overflow-hidden bg-white shadow-sm ring-1 ring-black/15', className)}
      style={{ aspectRatio: `${pageW} / ${pageH}`, ...style }}
    >
      <div
        data-testid="output-page-content"
        className="absolute"
        style={{
          left: percent(draw.x, pageW),
          bottom: percent(draw.y, pageH),
          width: percent(draw.w, pageW),
          height: percent(draw.h, pageH),
        }}
      >
        {children}
      </div>
      {guides && (
        <div
          aria-hidden="true"
          data-testid="output-page-margins"
          className="pointer-events-none absolute border border-dashed border-[#2563eb] shadow-[0_0_0_1px_rgba(255,255,255,0.55)]"
          style={{
            left: percent(margins.left, pageW),
            right: percent(margins.right, pageW),
            top: percent(margins.top, pageH),
            bottom: percent(margins.bottom, pageH),
          }}
        />
      )}
    </div>
  );
}
