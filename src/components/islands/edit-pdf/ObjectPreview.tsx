import {
  HIGHLIGHT_ALPHA,
  arrowHeadPt,
  baselineEm,
  isVectorText,
  lineEndsPt,
  stampLayout,
  type EditObject,
  type MeasureEm,
} from '@/lib/edit-pdf/objects';

/**
 * What an object looks like inside its box on the page.
 *
 * Drawn as SVG in the box's own frame — displayed points, y down — with the
 * same numbers `lib/edit-pdf/write.ts` writes into the file, so what is shown is
 * what is saved: the same stroke insets, the same arrowheads, text placed on the
 * same baselines and stretched to exactly Helvetica's width.
 */

const FONT = 'Helvetica, Arial, sans-serif';

interface Props {
  obj: EditObject;
  /** The box in displayed points. */
  widthPt: number;
  heightPt: number;
  measure: MeasureEm;
}

export default function ObjectPreview({ obj, widthPt: W, heightPt: H, measure }: Props) {
  if (obj.kind === 'image') {
    return (
      <img
        src={obj.src}
        alt=""
        draggable={false}
        data-testid="edit-image"
        className="pointer-events-none block size-full select-none"
        style={{ opacity: obj.opacity }}
      />
    );
  }

  const opacity = obj.kind === 'highlight' ? HIGHLIGHT_ALPHA : obj.kind === 'whiteout' ? 1 : obj.opacity;
  let body: React.ReactNode = null;

  switch (obj.kind) {
    case 'text': {
      const exact = isVectorText(obj.text);
      body = (
        <g fill={obj.color} fontFamily={FONT} fontSize={obj.fontSize}>
          {obj.text.split('\n').map((line, i) =>
            line ? (
              <text
                key={i}
                x={0}
                y={baselineEm(i) * obj.fontSize}
                // Helvetica's own width, whatever font the browser has, so the box is the box in the file.
                textLength={exact ? measure(line) * obj.fontSize : undefined}
                lengthAdjust={exact ? 'spacingAndGlyphs' : undefined}
                style={{ whiteSpace: 'pre' }}
              >
                {line}
              </text>
            ) : null,
          )}
        </g>
      );
      break;
    }
    case 'rect':
    case 'ellipse': {
      const lw = Math.min(obj.strokeWidth, W / 2, H / 2);
      body =
        obj.kind === 'rect' ? (
          <rect x={lw / 2} y={lw / 2} width={W - lw} height={H - lw} fill="none" stroke={obj.color} strokeWidth={lw} />
        ) : (
          <ellipse cx={W / 2} cy={H / 2} rx={(W - lw) / 2} ry={(H - lw) / 2} fill="none" stroke={obj.color} strokeWidth={lw} />
        );
      break;
    }
    case 'line':
    case 'arrow': {
      const [x1, y1, x2, y2] = lineEndsPt(obj, W, H);
      const head = obj.kind === 'arrow' ? arrowHeadPt(x1, y1, x2, y2, obj.strokeWidth) : null;
      body = (
        <g stroke={obj.color} strokeWidth={obj.strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          {head && <polyline points={`${head[0]},${head[1]} ${x2},${y2} ${head[2]},${head[3]}`} />}
        </g>
      );
      break;
    }
    case 'draw':
      body = (
        <polyline
          points={obj.points.map(([px, py]) => `${px * W},${py * H}`).join(' ')}
          fill="none"
          stroke={obj.color}
          strokeWidth={obj.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
      break;
    case 'highlight':
      body = <rect x={0} y={0} width={W} height={H} fill={obj.color} />;
      break;
    case 'whiteout':
      body = <rect x={0} y={0} width={W} height={H} fill="#FFFFFF" />;
      break;
    case 'stamp': {
      const s = stampLayout(W, H);
      body = (
        <g>
          <rect
            x={s.lineWidth / 2}
            y={s.lineWidth / 2}
            width={W - s.lineWidth}
            height={H - s.lineWidth}
            fill="none"
            stroke={obj.color}
            strokeWidth={s.lineWidth}
          />
          <text
            x={s.textX}
            y={s.baseline}
            fontSize={s.fontSize}
            fontFamily={FONT}
            fontWeight={700}
            fill={obj.color}
            textLength={s.textWidth}
            lengthAdjust="spacingAndGlyphs"
          >
            {obj.label}
          </text>
        </g>
      );
      break;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${Math.max(W, 0.001)} ${Math.max(H, 0.001)}`}
      preserveAspectRatio="none"
      className="pointer-events-none block size-full overflow-hidden"
      aria-hidden="true"
      data-testid={`edit-${obj.kind}`}
      opacity={opacity}
    >
      {body}
    </svg>
  );
}
