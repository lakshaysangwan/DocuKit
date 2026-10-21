import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Circle,
  Copy,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  Minus,
  PenLine,
  Plus,
  Redo2,
  Slash,
  Square,
  Stamp as StampIcon,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { OverlayBox, OverlayLayer, type OverlayChangePhase } from '@/components/islands/workspace/OverlayLayer';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useHistory } from '@/hooks/use-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { PageGeometry, RectNorm } from '@/lib/pdf/page-geometry';
import { moveRect } from '@/lib/workspace/overlay-math';
import { helveticaWidthEm, isPlainAscii } from '@/lib/sign/date-text';
import { prepareImageForPdf } from '@/lib/image-for-pdf';
import {
  DEFAULT_COLOUR,
  KIND_LABEL,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  MIN_OBJECT_WIDTH,
  STAMP_COLOURS,
  STAMP_LABELS,
  applyBoxMm,
  baselineEm,
  isVectorText,
  newDrawing,
  newImage,
  newObject,
  rectToBoxMm,
  reshapeToAspect,
  scaleObject,
  stampAspect,
  withFontSize,
  withRect,
  fitText,
  type BoxMm,
  type Direction,
  type EditKind,
  type EditObject,
  type MeasureEm,
  type StampLabel,
  type TextObject,
} from '@/lib/edit-pdf/objects';
import type { SaveMode } from '@/lib/edit-pdf/write';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import { cn, formatBytes, generateId } from '@/lib/utils';
import ObjectPreview from './ObjectPreview';

/**
 * Edit PDF, in the shared workspace.
 *
 * The page is shown large; the controls pane has the things that can be added
 * (text, image, shapes, lines, drawing, highlight, whiteout, stamp) and the
 * properties of the selected one. Everything added is a box on the page that
 * can be dragged, resized from its corners, sized exactly in millimetres, made
 * smaller or larger with buttons, and removed — and undone and redone. The box
 * is kept as a fraction of the displayed page and written through
 * `viewRectToPdfDraw`, so it lands where it was shown on rotated and cropped
 * pages too.
 */

const ACCEPT = ['application/pdf'];
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif';
/** "Smaller" / "Larger" change the size by this much per press. */
const SIZE_STEP = 1.1;
const DUPLICATE_OFFSET = 0.03;
/** Pixels per point when text the standard font cannot write is turned into a picture. */
const TEXT_RASTER_SCALE = 4;

const PALETTE: { kind: EditKind; label: string; Icon: typeof Type }[] = [
  { kind: 'text', label: 'Text', Icon: Type },
  { kind: 'image', label: 'Image', Icon: ImageIcon },
  { kind: 'rect', label: 'Rectangle', Icon: Square },
  { kind: 'ellipse', label: 'Ellipse', Icon: Circle },
  { kind: 'line', label: 'Line', Icon: Slash },
  { kind: 'arrow', label: 'Arrow', Icon: ArrowRight },
  { kind: 'draw', label: 'Draw', Icon: PenLine },
  { kind: 'highlight', label: 'Highlight', Icon: Highlighter },
  { kind: 'whiteout', label: 'Whiteout', Icon: Eraser },
  { kind: 'stamp', label: 'Stamp', Icon: StampIcon },
];

const ARROW_DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'right', label: 'Pointing right' },
  { value: 'left', label: 'Pointing left' },
  { value: 'down', label: 'Pointing down' },
  { value: 'up', label: 'Pointing up' },
  { value: 'down-right', label: 'Down and right' },
  { value: 'up-right', label: 'Up and right' },
  { value: 'down-left', label: 'Down and left' },
  { value: 'up-left', label: 'Up and left' },
];
const LINE_DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'right', label: 'Across' },
  { value: 'down', label: 'Up and down' },
  { value: 'down-right', label: 'Slanting down' },
  { value: 'up-right', label: 'Slanting up' },
];

const outlineButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';
const pressedButton = 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]';
const toolbarButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';
const barButton =
  'inline-flex h-11 min-w-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 text-[10px] font-medium leading-none text-[var(--color-text-primary)] hover:bg-[var(--color-background)] sm:h-9 sm:flex-row sm:gap-1.5 sm:border sm:border-[var(--color-border)] sm:px-2.5 sm:text-xs';
const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Measures text the way it will be saved: Helvetica's widths for plain ASCII
 * (written as real text), the browser's own font for anything else (saved as a
 * picture drawn with that same font).
 */
function makeMeasure(): MeasureEm {
  let ctx: CanvasRenderingContext2D | null = null;
  return (line) => {
    if (isPlainAscii(line)) return helveticaWidthEm(line);
    if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return line.length * 0.6;
    ctx.font = '100px Helvetica, Arial, sans-serif';
    return ctx.measureText(line).width / 100;
  };
}

/** Text Helvetica cannot write (other scripts, emoji) becomes a picture of itself, same box. */
function rasteriseText(obj: TextObject, geom: PageGeometry): EditObject {
  const W = obj.rect.width * geom.widthPt;
  const H = obj.rect.height * geom.heightPt;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(W * TEXT_RASTER_SCALE));
  canvas.height = Math.max(1, Math.ceil(H * TEXT_RASTER_SCALE));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(canvas.width / W, canvas.height / H);
  ctx.fillStyle = obj.color;
  ctx.font = `${obj.fontSize}px Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  obj.text.split('\n').forEach((line, i) => ctx.fillText(line, 0, baselineEm(i) * obj.fontSize));
  return {
    id: obj.id,
    pageIndex: obj.pageIndex,
    kind: 'image',
    rect: obj.rect,
    opacity: obj.opacity,
    lockAspect: true,
    src: canvas.toDataURL('image/png'),
    mime: 'image/png',
  };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

interface NumberFieldProps {
  label: string;
  testId: string;
  value: number | null;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** A number field. Shows what is typed while typing, the real value otherwise. */
function NumberField({ label, testId, value, onCommit, min = 0, max, step = 1 }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = draft ?? (value === null ? '' : String(round1(value)));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--color-text-secondary)]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={shown}
        disabled={value === null}
        data-testid={testId}
        onFocus={() => setDraft(shown)}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = Number.parseFloat(e.target.value);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
        className={cn(fieldClass, 'tabular-nums')}
      />
    </div>
  );
}

interface Style {
  color: string;
  strokeWidth: number;
  opacity: number;
  stampLabel: StampLabel;
}

export default function EditPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const history = useHistory<EditObject[]>([]);
  const objects = history.value;

  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>('flatten');
  const [style, setStyle] = useState<Style>({ color: DEFAULT_COLOUR, strokeWidth: 2, opacity: 1, stampLabel: 'APPROVED' });
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const [compare, setCompare] = useState<'after' | 'before'>('after');
  const [imageError, setImageError] = useState<string | null>(null);
  const [pageGeom, setPageGeom] = useState<{ doc: unknown; pageIndex: number; geom: PageGeometry } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  const strokeRef = useRef<{ pointerId: number; points: [number, number][] } | null>(null);
  const measure = useMemo(makeMeasure, []);

  const run = useToolRun<File>();
  const output = usePdfDocument(run.result);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const coarse = useMediaQuery('(pointer: coarse)');

  const active = !!file;
  const editing = run.phase === 'ready' || run.phase === 'error';
  const selected = objects.find((o) => o.id === selectedId && o.pageIndex === pageIndex) ?? null;
  const geometry = pageGeom && pageGeom.doc === doc && pageGeom.pageIndex === pageIndex ? pageGeom.geom : null;

  useEffect(() => {
    if (status === 'error' || status === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  // The current page's size: for new objects and the millimetre fields.
  useEffect(() => {
    if (!doc || pageIndex >= doc.pageCount) return;
    let live = true;
    doc.geometry(pageIndex).then(
      (geom) => {
        if (live) setPageGeom({ doc, pageIndex, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, pageIndex]);

  const { set: commit, preview, cancelPreview, undo, redo, reset, committed } = history;
  const { invalidate, start } = run;

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      reset([]);
      invalidate();
      setFile(next);
      setPageIndex(0);
      setSelectedId(null);
      setDrawing(false);
      setOptionsOpen(true);
      setCompare('after');
    },
    [reset, invalidate],
  );

  const removeFile = useCallback(() => {
    reset([]);
    invalidate();
    setFile(null);
    setSelectedId(null);
    setDrawing(false);
  }, [reset, invalidate]);

  const goToPage = useCallback((next: number) => {
    setPageIndex(next);
    setSelectedId(null);
  }, []);

  const pageGeometry = useCallback(async (): Promise<PageGeometry | null> => {
    if (geometry) return geometry;
    if (!doc) return null;
    return doc.geometry(pageIndex);
  }, [geometry, doc, pageIndex]);

  /** Put a new object on the page, selected, and say so. */
  const place = useCallback(
    (obj: EditObject) => {
      commit((list) => [...list, obj]);
      setSelectedId(obj.id);
      setFreshId(obj.id);
      setAnnouncement(`${KIND_LABEL[obj.kind]} added to page ${obj.pageIndex + 1}. Drag to move it, pull a corner to resize it.`);
      // On a phone the panel closes so the new object on the page is what is seen.
      if (phone) setOptionsOpen(false);
    },
    [commit, phone],
  );

  const add = useCallback(
    async (kind: EditKind) => {
      setImageError(null);
      if (kind === 'image') {
        imageInput.current?.click();
        return;
      }
      if (kind === 'draw') {
        setDrawing((on) => !on);
        setSelectedId(null);
        return;
      }
      setDrawing(false);
      const page = await pageGeometry();
      if (!page) return;
      const alreadyThere = objects.filter((o) => o.pageIndex === pageIndex && o.kind === kind).length;
      place(
        newObject(kind, {
          id: generateId(),
          pageIndex,
          page,
          alreadyThere,
          color: kind === 'highlight' ? undefined : style.color,
          strokeWidth: style.strokeWidth,
          opacity: style.opacity,
          stampLabel: style.stampLabel,
        }),
      );
    },
    [pageGeometry, objects, pageIndex, place, style],
  );

  const addImage = useCallback(
    async (picked: File | undefined) => {
      if (!picked) return;
      setDrawing(false);
      try {
        const prepared = await prepareImageForPdf(picked);
        const src = await readAsDataUrl(prepared.blob);
        const page = await pageGeometry();
        if (!page) return;
        place(
          newImage({
            id: generateId(),
            pageIndex,
            page,
            alreadyThere: objects.filter((o) => o.pageIndex === pageIndex && o.kind === 'image').length,
            opacity: style.opacity,
            src,
            mime: prepared.mime,
            pixelWidth: prepared.width,
            pixelHeight: prepared.height,
          }),
        );
      } catch (err) {
        setImageError(err instanceof Error ? err.message : 'This image could not be read.');
      }
    },
    [pageGeometry, pageIndex, objects, place, style.opacity],
  );

  const replace = useCallback(
    (id: string, next: EditObject) => (list: EditObject[]) => list.map((o) => (o.id === id ? next : o)),
    [],
  );

  const onBoxChange = useCallback(
    (obj: EditObject, rect: RectNorm, phase: OverlayChangePhase, source: 'pointer' | 'keyboard', geom: PageGeometry) => {
      if (phase === 'cancel') {
        cancelPreview();
        return;
      }
      // Measured from the object as it was when the change began: a text box's
      // font size follows the width its box is pulled to.
      const base = committed.find((o) => o.id === obj.id) ?? obj;
      const next = withRect(base, rect, geom, measure);
      if (phase === 'preview') {
        preview(replace(obj.id, next));
        return;
      }
      commit(replace(obj.id, next), source === 'keyboard' ? { coalesce: `keys:${obj.id}` } : undefined);
      setFreshId(null);
      if (source === 'keyboard') {
        const mm = rectToBoxMm(next.rect, geom);
        setAnnouncement(
          `${KIND_LABEL[obj.kind]} at ${Math.round(mm.x)} millimetres from the left, ${Math.round(mm.y)} from the top, ${Math.round(mm.width)} by ${Math.round(mm.height)}.`,
        );
      }
    },
    [cancelPreview, committed, measure, preview, replace, commit],
  );

  /** Change the selected object; `key` merges quick repeats (typing, a colour picker) into one undo step. */
  const update = useCallback(
    (change: (o: EditObject) => EditObject, key?: string) => {
      if (!selected) return;
      commit(replace(selected.id, change(selected)), key ? { coalesce: `${key}:${selected.id}` } : undefined);
      setFreshId(null);
    },
    [selected, commit, replace],
  );

  const remove = useCallback(
    (id: string) => {
      const obj = objects.find((o) => o.id === id);
      commit((list) => list.filter((o) => o.id !== id));
      setSelectedId(null);
      setAnnouncement(`${obj ? KIND_LABEL[obj.kind] : 'Item'} removed.`);
    },
    [objects, commit],
  );

  const resizeSelected = useCallback(
    (factor: number) => {
      if (!selected || !geometry) return;
      update((o) => scaleObject(o, factor, geometry, measure), 'size');
      setAnnouncement(factor > 1 ? 'Made larger.' : 'Made smaller.');
    },
    [selected, geometry, update, measure],
  );

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    const copy = { ...selected, id: generateId(), rect: moveRect(selected.rect, DUPLICATE_OFFSET, DUPLICATE_OFFSET) } as EditObject;
    commit((list) => [...list, copy]);
    setSelectedId(copy.id);
    setAnnouncement(`${KIND_LABEL[selected.kind]} duplicated.`);
  }, [selected, commit]);

  const editMm = useCallback(
    (edit: Partial<BoxMm>) => {
      if (!selected || !geometry) return;
      update((o) => applyBoxMm(o, edit, geometry, measure), 'field');
    },
    [selected, geometry, update, measure],
  );

  const setFontSize = useCallback(
    (size: number) => {
      if (!selected || selected.kind !== 'text' || !geometry) return;
      update((o) => withFontSize(o as TextObject, size, geometry, measure), 'font');
    },
    [selected, geometry, update, measure],
  );

  const setColour = useCallback(
    (color: string) => {
      setStyle((s) => ({ ...s, color }));
      update((o) => ('color' in o ? ({ ...o, color } as EditObject) : o), 'colour');
    },
    [update],
  );

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y — except while typing in a field.
  useEffect(() => {
    if (!active || !editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editing, undo, redo]);

  // Undo can take away the selected object; let go of it then.
  useEffect(() => {
    if (selectedId && !objects.some((o) => o.id === selectedId)) setSelectedId(null);
  }, [objects, selectedId]);

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-edited.pdf`;

  const apply = useCallback(() => {
    if (!doc || !file) return;
    const toWrite = committed.filter((o) => o.kind !== 'text' || o.text.trim() !== '');
    setSelectedId(null);
    setDrawing(false);
    setCompare('after');
    void start(async () => {
      const [{ PDFDocument }, { writeEditObjects }] = await Promise.all([import('pdf-lib'), import('@/lib/edit-pdf/write')]);
      const geoms = new Map<number, PageGeometry>();
      for (const o of toWrite) if (!geoms.has(o.pageIndex)) geoms.set(o.pageIndex, await doc.geometry(o.pageIndex));
      const prepared = toWrite.map((o) =>
        o.kind === 'text' && !isVectorText(o.text) ? rasteriseText(o, geoms.get(o.pageIndex)!) : o,
      );
      const pdf = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      await writeEditObjects(pdf, prepared, { mode: saveMode, geometry: (i) => geoms.get(i)! });
      const bytes = await pdf.save();
      return new File([bytes as BlobPart], outputName, { type: 'application/pdf' });
    });
  }, [doc, file, committed, start, saveMode, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result, run.result.name);
  }, [run.result]);

  const count = objects.length;
  const pagesEdited = useMemo(() => new Set(objects.map((o) => o.pageIndex)).size, [objects]);
  const perPage = useMemo(() => {
    const counts = new Map<number, number>();
    for (const o of objects) counts.set(o.pageIndex, (counts.get(o.pageIndex) ?? 0) + 1);
    return counts;
  }, [objects]);

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const closed = phone && !optionsOpen;
  const beside = wide ? 'on the right' : 'below';
  const press = coarse ? 'Tap' : 'Click';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (run.phase === 'running') {
    prompt = 'Saving your PDF…';
  } else if (run.phase === 'done') {
    prompt = 'Your edited PDF is ready. Download it, or make changes.';
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be saved. Try again.';
    promptTone = 'error';
  } else if (status !== 'ready') {
    prompt = 'Opening your PDF…';
  } else if (drawing) {
    prompt = `Draw on the page with your ${coarse ? 'finger' : 'mouse or pen'}, then press Done drawing.`;
  } else if (selected) {
    prompt = closed
      ? 'Drag to move it, pull a corner to resize it, or use Smaller and Larger.'
      : `Drag to move it, pull a corner to resize it, or type its exact size ${beside}.`;
  } else if (count === 0) {
    prompt = closed ? 'Open Options and choose what to add to this page.' : `Choose what to add to this page ${beside}.`;
  } else {
    prompt = `${press} something on the page to move or resize it, or press Save PDF when it looks right.`;
  }

  const disabledReason = status !== 'ready' ? 'Opening your PDF…' : count === 0 ? 'Add something to a page first' : null;
  const hint = `${plural(count, 'item')} on ${plural(pagesEdited, 'page')} will be saved into your PDF.`;
  const summary = run.result ? `${run.result.name} · ${formatBytes(run.result.size)} · ${plural(pageCount, 'page')}` : undefined;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const showingOutput = run.phase === 'done' && compare === 'after';
  const viewerDoc = showingOutput ? output.doc : doc;

  const strokeHandlers = (frame: PageFrame) => {
    const point = (e: React.PointerEvent<HTMLDivElement>): [number, number] => {
      const box = e.currentTarget.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
        Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
      ];
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Not capturable: the stroke still follows while over the page.
        }
        strokeRef.current = { pointerId: e.pointerId, points: [point(e)] };
        setStroke(strokeRef.current.points);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        const s = strokeRef.current;
        if (!s || s.pointerId !== e.pointerId) return;
        s.points = [...s.points, point(e)];
        setStroke(s.points);
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        const s = strokeRef.current;
        if (!s || s.pointerId !== e.pointerId) return;
        strokeRef.current = null;
        setStroke(null);
        const obj = newDrawing(s.points, {
          id: generateId(),
          pageIndex: frame.pageIndex,
          page: frame.geometry,
          color: style.color,
          strokeWidth: style.strokeWidth,
          opacity: style.opacity,
        });
        if (obj) {
          commit((list) => [...list, obj]);
          setSelectedId(obj.id);
          setAnnouncement('Drawing added.');
        }
      },
      onPointerCancel: () => {
        strokeRef.current = null;
        setStroke(null);
      },
    };
  };

  const renderOverlay = (frame: PageFrame) => {
    const geom = frame.geometry;
    return (
      <OverlayLayer onBackgroundClick={() => setSelectedId(null)} disabled={!editing}>
        {objects
          .filter((o) => o.pageIndex === frame.pageIndex)
          .map((o) => (
            <OverlayBox
              key={o.id}
              kind={o.kind}
              rect={o.rect}
              label={`${KIND_LABEL[o.kind]}, page ${o.pageIndex + 1}`}
              selected={o.id === selectedId}
              disabled={!editing || drawing}
              lockAspect={o.kind === 'text' || o.lockAspect}
              minWidth={MIN_OBJECT_WIDTH}
              onSelect={() => setSelectedId(o.id)}
              onDeselect={() => setSelectedId(null)}
              onRemove={() => remove(o.id)}
              onChange={(rect, phase, source) => onBoxChange(o, rect, phase, source, geom)}
              hint={o.id === freshId ? 'Drag to move · corners to resize' : undefined}
            >
              <div
                className="absolute inset-0"
                onDoubleClick={() => {
                  if (o.kind !== 'text') return;
                  setOptionsOpen(true);
                  requestAnimationFrame(() => textField.current?.focus());
                }}
              >
                <ObjectPreview
                  obj={o}
                  widthPt={o.rect.width * geom.widthPt}
                  heightPt={o.rect.height * geom.heightPt}
                  measure={measure}
                />
              </div>
            </OverlayBox>
          ))}
        {drawing && editing && (
          <div
            data-testid="draw-surface"
            aria-label="Drawing area: draw with a mouse, pen or finger"
            role="application"
            className="absolute inset-0 z-30 cursor-crosshair touch-none"
            {...strokeHandlers(frame)}
          >
            {stroke && stroke.length > 1 && (
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
                <polyline
                  points={stroke.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none"
                  stroke={style.color}
                  strokeOpacity={style.opacity}
                  strokeWidth={(style.strokeWidth * frame.widthPx) / geom.widthPt}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        )}
      </OverlayLayer>
    );
  };

  const undoRedo = (
    <>
      {count > 0 && (
        <span data-testid="placed-count" className="mr-1 whitespace-nowrap text-xs font-medium text-[var(--color-text-secondary)]">
          {plural(count, 'item')}
        </span>
      )}
      <button type="button" onClick={undo} disabled={!history.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="undo" className={toolbarButton}>
        <Undo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Undo</span>
      </button>
      <button type="button" onClick={redo} disabled={!history.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" data-testid="redo" className={toolbarButton}>
        <Redo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Redo</span>
      </button>
    </>
  );

  const selectionBar = (
    <div className="flex h-14 items-center gap-1 px-2 sm:h-12 sm:gap-2 sm:px-3" data-testid="selection-bar">
      {drawing ? (
        <>
          <p className="mr-auto truncate text-xs font-medium text-[var(--color-text-primary)]">Drawing on the page</p>
          <button type="button" onClick={() => setDrawing(false)} data-testid="draw-done" className={cn(barButton, 'sm:flex-row')}>
            <Check className="size-4" aria-hidden="true" />
            Done drawing
          </button>
        </>
      ) : selected ? (
        <>
          <p className="mr-auto truncate text-xs font-medium text-[var(--color-text-primary)] max-sm:hidden">
            {KIND_LABEL[selected.kind]} selected
          </p>
          <div
            role="toolbar"
            aria-label={`${KIND_LABEL[selected.kind]} actions`}
            className="flex flex-1 items-center justify-between gap-1 sm:flex-none sm:justify-end sm:gap-1.5"
          >
            <button type="button" onClick={() => resizeSelected(1 / SIZE_STEP)} data-testid="object-smaller" className={barButton}>
              <Minus className="size-4" aria-hidden="true" />
              Smaller
            </button>
            <button type="button" onClick={() => resizeSelected(SIZE_STEP)} data-testid="object-larger" className={barButton}>
              <Plus className="size-4" aria-hidden="true" />
              Larger
            </button>
            <button type="button" onClick={duplicateSelected} data-testid="object-duplicate" className={barButton}>
              <Copy className="size-4" aria-hidden="true" />
              Duplicate
            </button>
            <button
              type="button"
              onClick={() => remove(selected.id)}
              data-testid="overlay-remove"
              className={cn(barButton, 'text-[var(--color-error)]')}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Remove
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-[var(--color-text-secondary)]" data-testid="selection-hint">
          {count === 0
            ? 'What you add appears on the page, ready to move and resize.'
            : `${press} something on the page to move, resize or remove it.`}
        </p>
      )}
    </div>
  );

  const compareBar = (
    <div className="flex h-14 items-center gap-3 px-2 sm:h-12 sm:px-3" data-testid="compare-bar">
      <p data-testid="output-caption" className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {compare === 'after' ? 'Edited — this is your file' : 'Before — your original'}
      </p>
      <div role="group" aria-label="Compare before and after" className="ml-auto flex shrink-0 rounded-lg border border-[var(--color-border)] p-0.5">
        {(['before', 'after'] as const).map((side) => (
          <button
            key={side}
            type="button"
            aria-pressed={compare === side}
            onClick={() => setCompare(side)}
            data-testid={`compare-${side}`}
            className={cn(
              'h-8 rounded-md px-3 text-xs font-medium',
              compare === side
                ? 'bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {side === 'before' ? 'Before' : 'After'}
          </button>
        ))}
      </div>
    </div>
  );

  const stage = (
    <PageViewer
      doc={viewerDoc}
      pageIndex={pageIndex}
      onPageChange={goToPage}
      overlay={run.phase === 'done' ? undefined : renderOverlay}
      toolbarEnd={run.phase === 'done' ? undefined : undoRedo}
      footer={run.phase === 'done' ? compareBar : selectionBar}
      pageLabel={showingOutput ? 'Edited page' : 'Page'}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={pageIndex}
      onSelect={goToPage}
      label={showingOutput ? 'Edited pages' : 'Pages'}
      renderBadge={
        run.phase === 'done'
          ? undefined
          : (i) => {
              const c = perPage.get(i);
              if (!c) return null;
              return (
                <span
                  data-testid={`rail-badge-${i + 1}`}
                  title={`${plural(c, 'item')} on this page`}
                  className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-success)] px-1 text-[10px] font-bold text-white"
                >
                  {c}
                </span>
              );
            }
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const mm = selected && geometry ? rectToBoxMm(selected.rect, geometry) : null;
  const lockForced = selected?.kind === 'text';
  const hasColour = selected && 'color' in selected;
  const hasStroke = selected && 'strokeWidth' in selected;
  const hasOpacity = selected && selected.kind !== 'highlight' && selected.kind !== 'whiteout';

  const properties = selected ? (
    <section className="flex flex-col gap-3" aria-labelledby="edit-selected" data-testid="object-properties">
      <h3 id="edit-selected" className={heading}>
        Selected: {KIND_LABEL[selected.kind]}
      </h3>

      {selected.kind === 'text' && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="edit-text" className="text-xs text-[var(--color-text-secondary)]">
              Text
            </label>
            <textarea
              id="edit-text"
              ref={textField}
              rows={2}
              value={selected.text}
              data-testid="object-text"
              onChange={(e) => {
                const text = e.target.value;
                if (geometry) update((o) => fitText({ ...(o as TextObject), text }, geometry, measure), 'text');
              }}
              className={cn(fieldClass, 'resize-y')}
            />
          </div>
          <div className="flex items-end gap-2">
            <NumberField
              label="Font size (pt)"
              testId="font-size"
              value={selected.fontSize}
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              onCommit={setFontSize}
            />
            <button
              type="button"
              onClick={() => setFontSize(Math.round(selected.fontSize) - 1)}
              disabled={selected.fontSize <= MIN_FONT_SIZE}
              aria-label="Smaller font"
              data-testid="font-size-down"
              className={outlineButton}
            >
              <Minus className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setFontSize(Math.round(selected.fontSize) + 1)}
              disabled={selected.fontSize >= MAX_FONT_SIZE}
              aria-label="Larger font"
              data-testid="font-size-up"
              className={outlineButton}
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {MIN_FONT_SIZE}–{MAX_FONT_SIZE} pt. Pulling a corner of the text changes its font size too.
          </p>
        </>
      )}

      {(selected.kind === 'line' || selected.kind === 'arrow') && (
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-direction" className="text-xs text-[var(--color-text-secondary)]">
            Direction
          </label>
          <select
            id="edit-direction"
            value={selected.direction}
            data-testid="line-direction"
            onChange={(e) => {
              const direction = e.target.value as Direction;
              if (!geometry) return;
              update((o) => {
                const next = { ...o, direction } as EditObject;
                // A slanting line in a flat box would be nearly flat: make the box square.
                const slanting = direction.includes('-');
                const flat = Math.min(o.rect.width * geometry.widthPt, o.rect.height * geometry.heightPt) < 24;
                if ((slanting || direction === 'down' || direction === 'up') && flat) {
                  return { ...next, rect: reshapeToAspect(o.rect, 1, geometry) };
                }
                return next;
              });
            }}
            className={fieldClass}
          >
            {(selected.kind === 'arrow' ? ARROW_DIRECTIONS : LINE_DIRECTIONS).map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {selected.kind === 'stamp' && (
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-stamp" className="text-xs text-[var(--color-text-secondary)]">
            Stamp wording
          </label>
          <select
            id="edit-stamp"
            value={selected.label}
            data-testid="stamp-label"
            onChange={(e) => {
              const label = e.target.value as StampLabel;
              setStyle((s) => ({ ...s, stampLabel: label }));
              if (!geometry) return;
              update((o) => ({
                ...(o as EditObject & { kind: 'stamp' }),
                label,
                color: STAMP_COLOURS[label],
                // The box takes the new word's shape at the same height.
                rect: (() => {
                  const h = o.rect.height * geometry.heightPt;
                  const width = Math.min(1, (h * stampAspect(label)) / geometry.widthPt);
                  return { ...o.rect, width, x: Math.min(o.rect.x, 1 - width) };
                })(),
              }));
            }}
            className={fieldClass}
          >
            {STAMP_LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}

      {(hasColour || hasStroke || hasOpacity) && (
        <div className="flex flex-wrap items-end gap-3">
          {hasColour && (
            <div className="flex flex-col gap-1">
              <label htmlFor="edit-colour" className="text-xs text-[var(--color-text-secondary)]">
                Colour
              </label>
              <input
                id="edit-colour"
                type="color"
                value={(selected as { color: string }).color}
                data-testid="object-colour"
                onChange={(e) => setColour(e.target.value)}
                className="h-9 w-14 cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]"
              />
            </div>
          )}
          {hasStroke && (
            <div className="w-24">
              <NumberField
                label="Line width (pt)"
                testId="stroke-width"
                value={(selected as { strokeWidth: number }).strokeWidth}
                min={0.5}
                max={20}
                step={0.5}
                onCommit={(w) => {
                  const strokeWidth = Math.min(20, Math.max(0.5, w));
                  setStyle((s) => ({ ...s, strokeWidth }));
                  update((o) => ({ ...o, strokeWidth }) as EditObject, 'stroke');
                }}
              />
            </div>
          )}
          {hasOpacity && (
            <div className="flex min-w-32 flex-1 flex-col gap-1">
              <label htmlFor="edit-opacity" className="text-xs text-[var(--color-text-secondary)]">
                Opacity {Math.round(selected.opacity * 100)}%
              </label>
              <input
                id="edit-opacity"
                type="range"
                min={10}
                max={100}
                step={5}
                value={Math.round(selected.opacity * 100)}
                data-testid="object-opacity"
                onChange={(e) => {
                  const opacity = Number(e.target.value) / 100;
                  setStyle((s) => ({ ...s, opacity }));
                  update((o) => ({ ...o, opacity }), 'opacity');
                }}
                className="h-9 accent-[var(--color-primary)]"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="object-size">
        <p className="text-xs font-medium text-[var(--color-text-primary)]">Size and position (mm)</p>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Width" testId="object-width" value={mm ? mm.width : null} onCommit={(width) => editMm({ width })} />
          <NumberField label="Height" testId="object-height" value={mm ? mm.height : null} onCommit={(height) => editMm({ height })} />
          <NumberField label="From left" testId="object-x" value={mm ? mm.x : null} onCommit={(x) => editMm({ x })} />
          <NumberField label="From top" testId="object-y" value={mm ? mm.y : null} onCommit={(y) => editMm({ y })} />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
          <input
            type="checkbox"
            checked={lockForced || selected.lockAspect}
            disabled={lockForced}
            data-testid="object-lock"
            onChange={(e) => update((o) => ({ ...o, lockAspect: e.target.checked }))}
            className="size-4 accent-[var(--color-primary)]"
          />
          Keep proportions
        </label>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {lockForced
            ? 'Text always keeps its proportions: a new width or height changes the font size.'
            : 'Arrow keys move it; plus and minus resize it.'}
        </p>
      </div>
    </section>
  ) : (
    <p className="text-xs text-[var(--color-text-secondary)]" data-testid="properties-empty">
      {count === 0
        ? 'Add something above. It appears in the middle of the page, ready to drag and resize.'
        : `${press} something on the page to change its size, position or colour.`}
    </p>
  );

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start md:max-lg:gap-x-6" inert={!editing}>
      <section className="flex flex-col gap-3" aria-labelledby="edit-add">
        <h3 id="edit-add" className={heading}>
          Add to this page
        </h3>
        <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3" data-testid="edit-palette">
          {PALETTE.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              onClick={() => void add(kind)}
              disabled={status !== 'ready'}
              aria-pressed={kind === 'draw' ? drawing : undefined}
              data-testid={`add-${kind}`}
              className={cn(outlineButton, 'justify-start', kind === 'draw' && drawing && pressedButton)}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {kind === 'draw' && drawing ? 'Drawing…' : label}
            </button>
          ))}
        </div>
        <input
          ref={imageInput}
          type="file"
          accept={IMAGE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="add-image-input"
          onChange={(e) => {
            void addImage(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {imageError && (
          <p role="alert" className="text-xs font-medium text-[var(--color-error)]">
            {imageError}
          </p>
        )}
        {drawing && (
          <button type="button" onClick={() => setDrawing(false)} data-testid="draw-done-pane" className={outlineButton}>
            <Check className="size-4" aria-hidden="true" />
            Done drawing
          </button>
        )}
      </section>

      <div className="flex flex-col gap-3">{properties}</div>

      <section className="flex flex-col gap-2" aria-labelledby="edit-save-mode">
        <h3 id="edit-save-mode" className={heading}>
          How to save
        </h3>
        <div role="radiogroup" aria-labelledby="edit-save-mode" className="grid grid-cols-2 gap-2">
          {(
            [
              ['flatten', 'Part of the page'],
              ['annotations', 'Separate annotations'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={saveMode === value}
              onClick={() => {
                setSaveMode(value);
                invalidate();
              }}
              data-testid={`save-mode-${value}`}
              className={cn(outlineButton, saveMode === value && pressedButton)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]" data-testid="save-mode-note">
          {saveMode === 'flatten'
            ? 'Everything you added is drawn into the page itself and cannot be moved afterwards.'
            : 'Each item is saved as a PDF annotation that other PDF apps can select, move or delete.'}
        </p>
      </section>

      <p className="sr-only" role="status" aria-live="polite" data-testid="edit-announce">
        {announcement}
      </p>
    </div>
  );

  const result =
    run.phase === 'done' && run.result ? (
      <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
        <h3 className={heading}>Saved and ready</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {plural(count, 'item')} added to {plural(pagesEdited, 'page')}
          {saveMode === 'annotations' ? ' as annotations' : ''}. The page shown is the saved file itself — switch to
          Before to compare it with your original.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-secondary)]">File</dt>
          <dd className="truncate font-medium text-[var(--color-text-primary)]">{run.result.name}</dd>
          <dt className="text-[var(--color-text-secondary)]">Size</dt>
          <dd className="text-[var(--color-text-primary)]">{formatBytes(run.result.size)}</dd>
          <dt className="text-[var(--color-text-secondary)]">Pages</dt>
          <dd className="text-[var(--color-text-primary)]">{pageCount}</dd>
        </dl>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Something not right? Make changes takes you back to move, resize or remove anything you added.
        </p>
      </div>
    ) : undefined;

  return (
    <ToolWorkspace
      toolId="edit-pdf"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to annotate" />}
      title="Edit this PDF"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        file ? (
          <WorkspaceFileBar
            file={file}
            extra={pageCount > 0 ? plural(pageCount, 'page') : undefined}
            onRemove={removeFile}
            onReplace={acceptFile}
            accept={ACCEPT}
            disabled={run.phase === 'running'}
          />
        ) : null
      }
      stage={stage}
      rail={rail}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label="Save PDF"
          runningLabel="Saving…"
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download edited PDF: ${outputName}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
