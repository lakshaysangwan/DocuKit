import type { PageFrame } from '@/components/islands/workspace/PageViewer';
import type { WatermarkLayout } from '@/lib/watermark-layout';
import { WATERMARK_FONTS, type WatermarkFont } from '@/lib/watermark-fonts';

export interface WatermarkPreviewProps {
  frame: PageFrame;
  /** From `layoutWatermark(frame.geometry, …)` — the same call the worker makes. */
  layout: WatermarkLayout;
  type: 'text' | 'image';
  text: string;
  font: WatermarkFont;
  fontSize: number;
  color: string;
  /** 0–1. */
  opacity: number;
  /** Image watermark: the exact PNG/JPEG that will be embedded. */
  imageUrl: string | null;
  layer: 'front' | 'behind';
}

/**
 * The watermark drawn over the page in the viewer, from the layout the worker
 * will write. An SVG the size of the page whose units are the page's displayed
 * points, so every box is placed and turned exactly as `layoutWatermark` says;
 * text is stretched to the width the standard font gives it in the file
 * (`textLength`), whatever font the browser substitutes. Copies that reach
 * past the page edge are cut off at the edge, as they are in the file.
 *
 * "Behind content" can only be approximated over a picture of the page: the
 * watermark is multiplied into it, which is what the file looks like wherever
 * the page is white. The tool says so, and shows the real file after a run.
 *
 * Test ids: `watermark-preview` (with `data-count`), `wm-mark` per copy, and
 * `wm-box` — the copy's box, turned as it is on screen.
 */
export default function WatermarkPreview({
  frame,
  layout,
  type,
  text,
  font,
  fontSize,
  color,
  opacity,
  imageUrl,
  layer,
}: WatermarkPreviewProps) {
  const W = frame.geometry.widthPt;
  const H = frame.geometry.heightPt;
  const w = layout.boxWidthPt;
  const h = layout.boxHeightPt;
  const family = WATERMARK_FONTS.find((f) => f.value === font)?.css ?? 'sans-serif';
  const drawable = type === 'text' ? text.length > 0 : !!imageUrl;

  return (
    <div
      data-testid="watermark-preview"
      data-count={drawable ? layout.placements.length : 0}
      className="pointer-events-none absolute inset-0"
      style={layer === 'behind' ? { mixBlendMode: 'multiply' } : undefined}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        className="absolute inset-0 block overflow-hidden"
      >
        {drawable &&
          layout.placements.map((p, i) => {
            const x = p.rect.x * W;
            const y = p.rect.y * H;
            const cx = x + w / 2;
            const cy = y + h / 2;
            return (
              <g key={i} data-testid="wm-mark" transform={`rotate(${p.rotation} ${cx} ${cy})`}>
                <rect data-testid="wm-box" x={x} y={y} width={w} height={h} fill="none" stroke="none" />
                {type === 'text' ? (
                  <text
                    x={x}
                    y={y + h - layout.baselinePt}
                    fontSize={fontSize}
                    fontFamily={family}
                    fontWeight="bold"
                    fill={color}
                    fillOpacity={opacity}
                    textLength={w}
                    lengthAdjust="spacingAndGlyphs"
                    style={{ whiteSpace: 'pre' }}
                  >
                    {text}
                  </text>
                ) : (
                  <image href={imageUrl!} x={x} y={y} width={w} height={h} preserveAspectRatio="none" opacity={opacity} />
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
}
