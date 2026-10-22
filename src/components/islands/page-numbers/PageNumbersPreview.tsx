import type { PageFrame } from '@/components/islands/workspace/PageViewer';
import { PAGE_NUMBER_FONTS, type PageNumberFont, type PageNumberPlacement } from '@/lib/page-number-layout';

export interface PageNumbersPreviewProps {
  frame: PageFrame;
  /** From `layoutPageNumber(frame.geometry, …)` — the same call the worker makes. */
  placement: PageNumberPlacement;
  font: PageNumberFont;
  fontSize: number;
  color: string;
}

/**
 * The page's number drawn over the page in the viewer, from the layout the
 * worker will write. An SVG the size of the page whose units are the page's
 * displayed points, so the box sits exactly where `layoutPageNumber` says;
 * the text is stretched to the width the standard font gives it in the file
 * (`textLength`), whatever font the browser substitutes.
 *
 * Test ids: `page-numbers-preview` (with `data-text`), `pn-box` — the
 * number's box — and `pn-number`, the drawn text.
 */
export default function PageNumbersPreview({ frame, placement, font, fontSize, color }: PageNumbersPreviewProps) {
  const W = frame.geometry.widthPt;
  const H = frame.geometry.heightPt;
  const x = placement.rect.x * W;
  const y = placement.rect.y * H;
  const w = placement.boxWidthPt;
  const h = placement.boxHeightPt;
  const family = PAGE_NUMBER_FONTS.find((f) => f.value === font)?.css ?? 'sans-serif';

  return (
    <div
      data-testid="page-numbers-preview"
      data-text={placement.text}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" className="absolute inset-0 block overflow-hidden">
        <rect data-testid="pn-box" x={x} y={y} width={w} height={h} fill="none" stroke="none" />
        <text
          data-testid="pn-number"
          x={x}
          y={y + h - placement.baselinePt}
          fontSize={fontSize}
          fontFamily={family}
          fill={color}
          textLength={w}
          lengthAdjust="spacingAndGlyphs"
          style={{ whiteSpace: 'pre' }}
        >
          {placement.text}
        </text>
      </svg>
    </div>
  );
}
