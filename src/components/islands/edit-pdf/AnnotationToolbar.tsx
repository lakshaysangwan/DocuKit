import { cn } from '@/lib/utils';

export type AnnotationTool =
  | 'select'
  | 'text'
  | 'image'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'highlight'
  | 'whiteout'
  | 'stamp';

export type StampType = 'APPROVED' | 'DRAFT' | 'CONFIDENTIAL' | 'COPY' | 'VOID';

interface AnnotationToolbarProps {
  activeTool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
  // Drawing style controls
  color: string;
  onColorChange: (color: string) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  strokeWidth: number;
  onStrokeWidthChange: (w: number) => void;
  opacity: number;
  onOpacityChange: (o: number) => void;
  stampType: StampType;
  onStampTypeChange: (s: StampType) => void;
  // Actions
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onDeleteSelected: () => void;
}

const TOOL_GROUPS = [
  {
    label: 'Select',
    tools: [
      { id: 'select' as AnnotationTool, icon: '↖', title: 'Select / Move (V)' },
    ],
  },
  {
    label: 'Text',
    tools: [
      { id: 'text' as AnnotationTool, icon: 'T', title: 'Text Box (T)' },
    ],
  },
  {
    label: 'Draw',
    tools: [
      { id: 'draw' as AnnotationTool, icon: '✏️', title: 'Freehand Draw (D)' },
      { id: 'highlight' as AnnotationTool, icon: '🖊', title: 'Highlight (H)' },
      { id: 'whiteout' as AnnotationTool, icon: '▭', title: 'Whiteout (W)' },
    ],
  },
  {
    label: 'Shapes',
    tools: [
      { id: 'rectangle' as AnnotationTool, icon: '□', title: 'Rectangle (R)' },
      { id: 'ellipse' as AnnotationTool, icon: '○', title: 'Ellipse (E)' },
      { id: 'line' as AnnotationTool, icon: '╱', title: 'Line (L)' },
      { id: 'arrow' as AnnotationTool, icon: '→', title: 'Arrow (A)' },
    ],
  },
  {
    label: 'Insert',
    tools: [
      { id: 'image' as AnnotationTool, icon: '🖼', title: 'Image (I)' },
      { id: 'stamp' as AnnotationTool, icon: '📋', title: 'Stamp (S)' },
    ],
  },
];

const STAMP_OPTIONS: StampType[] = ['APPROVED', 'DRAFT', 'CONFIDENTIAL', 'COPY', 'VOID'];

export default function AnnotationToolbar({
  activeTool,
  onToolChange,
  color,
  onColorChange,
  fontSize,
  onFontSizeChange,
  strokeWidth,
  onStrokeWidthChange,
  opacity,
  onOpacityChange,
  stampType,
  onStampTypeChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onDeleteSelected,
}: AnnotationToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      {/* Tool groups */}
      {TOOL_GROUPS.map((group, gi) => (
        <div key={group.label} className={cn('flex items-center gap-1', gi > 0 && 'border-l border-[var(--color-border)] pl-1')}>
          {group.tools.map((tool) => (
            <button
              key={tool.id}
              title={tool.title}
              onClick={() => onToolChange(tool.id)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg text-sm transition-colors',
                activeTool === tool.id
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'hover:bg-[var(--color-background)] text-[var(--color-text-secondary)]'
              )}
            >
              {tool.icon}
            </button>
          ))}
        </div>
      ))}

      {/* Separator */}
      <div className="mx-1 h-6 w-px bg-[var(--color-border)]" />

      {/* Color picker */}
      <div className="flex items-center gap-1">
        <label className="text-xs text-[var(--color-text-muted)]" title="Color">
          <span className="sr-only">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            className="h-6 w-6 cursor-pointer rounded border border-[var(--color-border)]"
          />
        </label>
      </div>

      {/* Font size (text tool) */}
      {activeTool === 'text' && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Size</span>
          <input
            type="number"
            min={8}
            max={72}
            value={fontSize}
            onChange={(e) => onFontSizeChange(Number(e.target.value))}
            className="w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-0.5 text-xs outline-none"
          />
        </div>
      )}

      {/* Stroke width (shapes/draw) */}
      {['draw', 'rectangle', 'ellipse', 'line', 'arrow'].includes(activeTool) && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Width</span>
          <input
            type="range"
            min={1}
            max={20}
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
            className="w-16 accent-[var(--color-primary)]"
          />
          <span className="w-4 text-xs tabular-nums text-[var(--color-text-muted)]">{strokeWidth}</span>
        </div>
      )}

      {/* Opacity */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-[var(--color-text-muted)]">α</span>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={Math.round(opacity * 100)}
          onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
          className="w-16 accent-[var(--color-primary)]"
        />
      </div>

      {/* Stamp type selector */}
      {activeTool === 'stamp' && (
        <select
          value={stampType}
          onChange={(e) => onStampTypeChange(e.target.value as StampType)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-0.5 text-xs outline-none"
        >
          {STAMP_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      )}

      {/* Separator */}
      <div className="mx-1 h-6 w-px bg-[var(--color-border)]" />

      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-sm hover:bg-[var(--color-background)] disabled:opacity-30"
      >
        ↩
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-sm hover:bg-[var(--color-background)] disabled:opacity-30"
      >
        ↪
      </button>

      {/* Delete selected */}
      <button
        onClick={onDeleteSelected}
        title="Delete selected (Del)"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-sm hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)] text-[var(--color-text-muted)]"
      >
        🗑
      </button>
    </div>
  );
}
