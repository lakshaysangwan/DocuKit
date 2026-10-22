import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Minus, PenLine, Plus, Redo2, Search, SquarePlus, Trash2, Undo2 } from 'lucide-react';
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
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import { scaleRect } from '@/lib/workspace/overlay-math';
import {
  applyMarkMm,
  defaultMarkRect,
  markRectToMm,
  markToJob,
  marksPerPage,
  rectContains,
  runMatches,
  textRunViewCentre,
  textRunViewRect,
  type MarkMm,
  type RedactJobMark,
  type RedactMark,
} from '@/lib/redact/marks';
import { getPdfjs, PDFJS_DOC_ASSETS } from '@/lib/pdfjs';
import { createCanvas2D, canvasToBlob } from '@/lib/canvas-2d';
import { redactWithMupdf } from '@/lib/redact-with-mupdf';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import { cn, formatBytes, generateId } from '@/lib/utils';

/**
 * Redact PDF, in the shared workspace.
 *
 * One page large. A drag on the page — mouse, finger or pen (pointer events) —
 * draws a mark; marks are boxes that can be selected, moved, resized from the
 * corners, nudged with the keyboard, typed in millimetres or removed, with undo
 * and redo. "Find & mark all" marks every run of text that contains a phrase.
 *
 * A mark is kept as a fraction of the displayed page and goes through
 * `page-geometry.ts` to PDF user space only when the file is written, so on a
 * `/Rotate 90` scan, a page with an offset CropBox or a UserUnit page the area
 * removed is the area that was shown. After "Redact PDF" the document pane
 * shows the redacted file itself, page by page, and the result pane says what
 * a check of that file found under the marks.
 */

interface RedactResult {
  file: File;
  /** `mupdf`: per-area removal; `raster`: every page turned into an image (fallback). */
  method: 'mupdf' | 'raster';
  hashes: { before: string; after: string } | null;
  markCount: number;
  pageCount: number;
}

interface Verification {
  /** Text runs of the redacted file whose centre lies under a mark. */
  leftUnderMarks: number;
  phrases: { phrase: string; remaining: number }[];
}

const ACCEPT = ['application/pdf'];
const SIZE_STEP = 1.1;
/** Marks can be thinner than a stamp: a line of small print. */
const MARK_MIN_WIDTH = 0.01;

const toolbarButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const barButton =
  'inline-flex h-11 min-w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 text-[10px] font-medium leading-none text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40 sm:h-9 sm:flex-row sm:gap-1.5 sm:border sm:border-[var(--color-border)] sm:px-2.5 sm:text-xs';

const outlineButton =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * Fallback redaction: render each page to a raster and paint black boxes over
 * the marks, then re-embed as images. Guarantees content removal but destroys
 * the text layer — used only if the MuPDF path fails.
 */
async function rasterizeRedact(
  buffer: ArrayBuffer,
  marks: RedactJobMark[],
  setProgress: (n: number) => void,
): Promise<ArrayBuffer> {
  const pdfjsLib = await getPdfjs();
  const { PDFDocument } = await import('pdf-lib');

  const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOC_ASSETS, data: new Uint8Array(buffer) }).promise;
  const outDoc = await PDFDocument.create();

  const RENDER_SCALE = 3; // ~216 DPI for quality
  const totalPgs = pdfDoc.numPages;

  for (let i = 0; i < totalPgs; i++) {
    setProgress(30 + Math.round((i / totalPgs) * 60));

    const page = await pdfDoc.getPage(i + 1);
    const vp = page.getViewport({ scale: RENDER_SCALE });
    const { canvas, ctx } = createCanvas2D(vp.width, vp.height);
    await page.render({ canvasContext: ctx as any, viewport: vp, canvas: canvas as any } as any).promise;

    // The viewport is the displayed page, so the view rectangles apply as they are.
    ctx.fillStyle = '#000000';
    for (const m of marks) {
      if (m.pageIndex !== i) continue;
      ctx.fillRect(m.view.x * vp.width, m.view.y * vp.height, m.view.width * vp.width, m.view.height * vp.height);
    }

    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const img = await outDoc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const origVp = page.getViewport({ scale: 1 });
    const outPage = outDoc.addPage([origVp.width, origVp.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: origVp.width, height: origVp.height });
  }

  pdfDoc.destroy();
  const bytes = await outDoc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

/** Hex SHA-256 of a buffer, for the before/after integrity panel. */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Look through the redacted file for text under the marks and for the phrases searched. */
async function verifyOutput(out: PdfDocHandle, marks: RedactMark[], phrases: string[]): Promise<Verification> {
  let leftUnderMarks = 0;
  const remaining = new Map(phrases.map((p) => [p, 0]));
  const byPage = new Map<number, RectNorm[]>();
  for (const m of marks) byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), m.rect]);
  const pagesToRead = phrases.length > 0 ? Array.from({ length: out.pageCount }, (_, i) => i) : [...byPage.keys()];
  for (const pageIndex of pagesToRead) {
    if (pageIndex >= out.pageCount) continue;
    const [geom, runs] = await Promise.all([out.geometry(pageIndex), out.textContent(pageIndex)]);
    const rects = byPage.get(pageIndex) ?? [];
    for (const run of runs) {
      if (!run.str.trim()) continue;
      const centre = textRunViewCentre(geom, run);
      if (rects.some((r) => rectContains(r, centre))) leftUnderMarks++;
      for (const phrase of phrases) {
        if (runMatches(run.str, phrase)) remaining.set(phrase, (remaining.get(phrase) ?? 0) + 1);
      }
    }
  }
  return { leftUnderMarks, phrases: [...remaining].map(([phrase, n]) => ({ phrase, remaining: n })) };
}

interface NumberFieldProps {
  label: string;
  testId: string;
  value: number | null;
  onCommit: (value: number) => void;
}

/** A millimetre field. Shows what is typed while typing, the real value otherwise. */
function NumberField({ label, testId, value, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = draft ?? (value === null ? '' : String(Math.round(value * 10) / 10));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--color-text-secondary)]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="1"
        min="0"
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
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm tabular-nums text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
      />
    </div>
  );
}

function SecurityNotice() {
  return (
    <div className="flex gap-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
      <svg className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <div className="text-sm">
        <p className="font-medium text-[var(--color-error)]">Redaction is permanent and irreversible</p>
        <p className="mt-0.5 text-[var(--color-text-secondary)]">
          The text and image pixels under each mark are removed from the file — not just covered — and so are
          shapes a mark covers completely. The rest of the document stays intact and selectable.
        </p>
      </div>
    </div>
  );
}

export default function RedactPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const history = useHistory<RedactMark[]>([]);
  const marks = history.value;

  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The mark just added, until it is first changed: it alone carries the how-to tag.
  const [freshId, setFreshId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [stripMetadata, setStripMetadata] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState('');
  const [phrases, setPhrases] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [compare, setCompare] = useState<'after' | 'before'>('after');
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [progress, setProgress] = useState(0);
  const [pageGeom, setPageGeom] = useState<{ doc: unknown; pageIndex: number; geom: PageGeometry } | null>(null);
  const [verification, setVerification] = useState<{ result: RedactResult; value: Verification | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useToolRun<RedactResult>();
  const output = usePdfDocument(run.result?.file ?? null);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const coarse = useMediaQuery('(pointer: coarse)');

  const active = !!file;
  const editing = run.phase === 'ready' || run.phase === 'error';
  const selected = marks.find((m) => m.id === selectedId && m.pageIndex === pageIndex) ?? null;
  const geometry = pageGeom && pageGeom.doc === doc && pageGeom.pageIndex === pageIndex ? pageGeom.geom : null;

  const { set: commit, preview, cancelPreview, undo, redo, reset, committed } = history;
  const { invalidate, start } = run;

  // A file that cannot be opened: say so and go back to the dropzone.
  useEffect(() => {
    if (status === 'error' || status === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  // The current page's size, for the millimetre fields.
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

  // Any change to what will be redacted makes a finished result stale.
  useEffect(() => {
    invalidate();
  }, [committed, stripMetadata, confirmed, invalidate]);

  // Once the redacted file is open, check it: text under the marks, and the phrases searched for.
  useEffect(() => {
    const result = run.result;
    if (run.phase !== 'done' || !result || !output.doc) return;
    let live = true;
    setVerification({ result, value: null });
    verifyOutput(output.doc, committed, phrases).then(
      (value) => {
        if (live) setVerification({ result, value });
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // `committed` and `phrases` are what was redacted; they cannot change while done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.phase, run.result, output.doc]);

  const resetAll = useCallback(() => {
    reset([]);
    invalidate();
    setPageIndex(0);
    setSelectedId(null);
    setConfirmed(false);
    setPhrases([]);
    setSearchNote('');
    setCompare('after');
    setVerification(null);
  }, [reset, invalidate]);

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      resetAll();
      setOptionsOpen(true);
      setFile(next);
    },
    [resetAll],
  );

  const removeFile = useCallback(() => {
    resetAll();
    setFile(null);
  }, [resetAll]);

  const goToPage = useCallback((next: number) => {
    setPageIndex(next);
    setSelectedId(null);
  }, []);

  const addMark = useCallback(
    (page: number, rect: RectNorm) => {
      const id = generateId();
      commit((current) => [...current, { id, pageIndex: page, rect }]);
      setSelectedId(id);
      setFreshId(id);
      setAnnouncement(`Mark added to page ${page + 1}.`);
    },
    [commit],
  );

  const addDefaultMark = useCallback(() => {
    const onPage = marks.filter((m) => m.pageIndex === pageIndex).length;
    addMark(pageIndex, defaultMarkRect(onPage));
  }, [marks, pageIndex, addMark]);

  const updateRect = useCallback(
    (id: string, rect: RectNorm) => (current: RedactMark[]) => current.map((m) => (m.id === id ? { ...m, rect } : m)),
    [],
  );

  const describe = useCallback(
    (rect: RectNorm) => {
      if (!geometry) return '';
      const mm = markRectToMm(rect, geometry);
      return `Mark at ${Math.round(mm.x)} millimetres from the left, ${Math.round(mm.y)} from the top, ${Math.round(mm.width)} wide and ${Math.round(mm.height)} high.`;
    },
    [geometry],
  );

  const onBoxChange = useCallback(
    (mark: RedactMark, rect: RectNorm, phase: OverlayChangePhase, source: 'pointer' | 'keyboard') => {
      if (phase === 'cancel') cancelPreview();
      else if (phase === 'preview') preview(updateRect(mark.id, rect));
      else {
        setFreshId(null);
        commit(updateRect(mark.id, rect), source === 'keyboard' ? { coalesce: `keys:${mark.id}` } : undefined);
        if (source === 'keyboard') setAnnouncement(describe(rect));
      }
    },
    [cancelPreview, preview, commit, updateRect, describe],
  );

  const removeMark = useCallback(
    (id: string) => {
      commit((current) => current.filter((m) => m.id !== id));
      setSelectedId((s) => (s === id ? null : s));
      setAnnouncement('Mark removed.');
    },
    [commit],
  );

  const resizeSelected = useCallback(
    (factor: number) => {
      if (!selected) return;
      commit(updateRect(selected.id, scaleRect(selected.rect, factor, { minWidth: MARK_MIN_WIDTH })), {
        coalesce: `size:${selected.id}`,
      });
    },
    [selected, commit, updateRect],
  );

  const editMm = useCallback(
    (edit: Partial<MarkMm>) => {
      if (!selected || !geometry) return;
      const rect = applyMarkMm(selected.rect, geometry, edit);
      commit(updateRect(selected.id, rect), { coalesce: `field:${selected.id}` });
      setAnnouncement(describe(rect));
    },
    [selected, geometry, commit, updateRect, describe],
  );

  /** Mark every run of text, on every page, that contains the phrase. */
  const findAndMark = useCallback(async () => {
    const phrase = query.trim();
    if (!doc || !phrase) return;
    setSearching(true);
    setSearchNote('');
    try {
      const found: RedactMark[] = [];
      for (let p = 0; p < doc.pageCount; p++) {
        const [geom, runs] = await Promise.all([doc.geometry(p), doc.textContent(p)]);
        for (const textRun of runs) {
          if (!runMatches(textRun.str, phrase)) continue;
          found.push({ id: generateId(), pageIndex: p, rect: textRunViewRect(geom, textRun) });
        }
      }
      if (found.length === 0) {
        setSearchNote(`No text found containing “${phrase}”.`);
        return;
      }
      commit((current) => [...current, ...found]);
      setPhrases((list) => (list.includes(phrase) ? list : [...list, phrase]));
      const pages = new Set(found.map((m) => m.pageIndex)).size;
      setSearchNote(`Marked ${plural(found.length, 'match', 'matches')} on ${plural(pages, 'page')}.`);
    } catch {
      setSearchNote('The text of this PDF could not be searched.');
    } finally {
      setSearching(false);
    }
  }, [doc, query, commit]);

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y — except while typing.
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

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-redacted.pdf`;

  const apply = useCallback(() => {
    if (!doc || !file || committed.length === 0 || !confirmed) return;
    const toRedact = committed;
    const strip = stripMetadata;
    setSelectedId(null);
    setCompare('after');
    setProgress(5);
    const controller = new AbortController();
    abortRef.current = controller;
    void start(async () => {
      const jobs: RedactJobMark[] = [];
      for (const mark of toRedact) jobs.push(markToJob(mark, await doc.geometry(mark.pageIndex)));
      const buffer = await file.arrayBuffer();
      setProgress(30);
      let bytes: ArrayBuffer;
      let method: RedactResult['method'] = 'mupdf';
      try {
        bytes = await redactWithMupdf(buffer, jobs, { stripMetadata: strip, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return null;
        // MuPDF could not read this file: rasterize every page so the marked
        // content is still destroyed (the text layer is lost).
        console.warn('MuPDF redaction failed, falling back to rasterization:', err);
        bytes = await rasterizeRedact(buffer, jobs, setProgress);
        method = 'raster';
      }
      if (controller.signal.aborted) return null;
      setProgress(95);
      let hashes: RedactResult['hashes'] = null;
      try {
        const [before, after] = await Promise.all([sha256Hex(buffer), sha256Hex(bytes)]);
        hashes = { before, after };
      } catch {
        // No SubtleCrypto (an insecure context): the panel is left out.
      }
      setProgress(100);
      return {
        file: new File([bytes], outputName, { type: 'application/pdf' }),
        method,
        hashes,
        markCount: toRedact.length,
        pageCount: new Set(toRedact.map((m) => m.pageIndex)).size,
      };
    });
  }, [doc, file, committed, confirmed, stripMetadata, start, outputName]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    run.cancel();
  }, [run]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result.file, run.result.file.name);
  }, [run.result]);

  const markCount = marks.length;
  const perPage = useMemo(() => marksPerPage(marks), [marks]);
  const pagesMarked = perPage.size;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const closed = phone && !optionsOpen;
  const beside = wide ? 'on the right' : 'below';
  const press = coarse ? 'tap' : 'click';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (run.phase === 'running') {
    prompt = 'Removing the marked content…';
  } else if (run.phase === 'done') {
    prompt = 'Check the redacted pages, then download your PDF.';
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be redacted. Try again.';
    promptTone = 'error';
  } else if (status !== 'ready') {
    prompt = 'Opening your PDF…';
  } else if (markCount === 0) {
    if (!drawMode) prompt = 'Turn on Draw marks to drag over what to remove, or press Add mark.';
    else if (coarse) prompt = 'Drag a finger over what you want to remove, or find it by its text in Options.';
    else prompt = `Drag across what you want to remove, or find it by its text ${beside}.`;
  } else if (selected) {
    prompt = 'Drag the mark to move it, pull a corner to resize it, or draw another.';
  } else if (!confirmed) {
    prompt = closed
      ? 'Check every page, then open Options and tick the confirmation.'
      : `Check every page, then tick the confirmation ${beside}.`;
  } else {
    prompt = `Press Redact PDF when every mark is in place, or ${press} a mark to change it.`;
  }

  const disabledReason =
    status !== 'ready'
      ? 'Opening your PDF…'
      : markCount === 0
        ? 'Mark at least one area to redact first'
        : !confirmed
          ? 'Tick the confirmation to redact'
          : null;
  const hint = `${plural(markCount, 'area')} on ${plural(pagesMarked, 'page')} will be removed for good.`;
  const summary = run.result
    ? `${run.result.file.name} · ${formatBytes(run.result.file.size)} · ${plural(pageCount, 'page')}`
    : undefined;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const showingOutput = run.phase === 'done' && compare === 'after';
  const viewerDoc = run.phase === 'done' ? (showingOutput ? output.doc : doc) : doc;

  const renderOverlay = (frame: PageFrame) => (
    <OverlayLayer
      onBackgroundClick={() => setSelectedId(null)}
      onDraw={drawMode && editing ? (rect) => addMark(frame.pageIndex, rect) : undefined}
      draftClassName="bg-red-600/30"
      disabled={!editing}
    >
      {marks.map((m, i) =>
        m.pageIndex !== frame.pageIndex ? null : (
          <OverlayBox
            key={m.id}
            kind="redaction"
            rect={m.rect}
            lockAspect={false}
            minWidth={MARK_MIN_WIDTH}
            label={`Redaction mark ${i + 1}, page ${m.pageIndex + 1}`}
            selected={m.id === selectedId}
            disabled={!editing}
            onSelect={() => setSelectedId(m.id)}
            onDeselect={() => setSelectedId(null)}
            onRemove={() => removeMark(m.id)}
            onChange={(rect, phase, source) => onBoxChange(m, rect, phase, source)}
            hint={m.id === freshId ? 'Drag to move · corners to resize' : undefined}
          >
            <span aria-hidden="true" data-testid="redact-mark" className="pointer-events-none block size-full bg-red-600/45" />
          </OverlayBox>
        ),
      )}
    </OverlayLayer>
  );

  const undoRedo = (
    <>
      {markCount > 0 && (
        <span data-testid="placed-count" className="mr-1 whitespace-nowrap text-xs font-medium text-[var(--color-text-secondary)] max-sm:hidden">
          {plural(markCount, 'mark')}
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
      <button
        type="button"
        onClick={() => setDrawMode((on) => !on)}
        aria-pressed={drawMode}
        data-testid="draw-toggle"
        title="When on, a drag on the page draws a mark. Turn it off to scroll a zoomed page with a finger."
        className={cn(
          barButton,
          drawMode && 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] sm:border-[var(--color-primary)]',
        )}
      >
        <PenLine className="size-4" aria-hidden="true" />
        Draw marks
      </button>
      {selected ? (
        <div role="toolbar" aria-label="Mark actions" className="ml-auto flex items-center gap-1 sm:gap-1.5">
          <span className="mr-1 text-xs font-medium text-[var(--color-text-primary)] max-lg:hidden">Mark selected</span>
          <button type="button" onClick={() => resizeSelected(1 / SIZE_STEP)} data-testid="mark-smaller" className={barButton}>
            <Minus className="size-4" aria-hidden="true" />
            Smaller
          </button>
          <button type="button" onClick={() => resizeSelected(SIZE_STEP)} data-testid="mark-larger" className={barButton}>
            <Plus className="size-4" aria-hidden="true" />
            Larger
          </button>
          <button type="button" onClick={() => removeMark(selected.id)} data-testid="overlay-remove" className={cn(barButton, 'text-[var(--color-error)]')}>
            <Trash2 className="size-4" aria-hidden="true" />
            Remove
          </button>
        </div>
      ) : (
        <>
          <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]" data-testid="selection-hint">
            {drawMode
              ? `Drag on the page to mark an area; ${press} a mark to change it.`
              : 'Drawing is off: a finger scrolls the page.'}
          </p>
          <button type="button" onClick={addDefaultMark} disabled={!editing || status !== 'ready'} data-testid="add-mark" className={barButton}>
            <SquarePlus className="size-4" aria-hidden="true" />
            Add mark
          </button>
        </>
      )}
    </div>
  );

  const compareBar = (
    <div className="flex h-14 items-center gap-3 px-2 sm:h-12 sm:px-3" data-testid="compare-bar">
      <p data-testid="output-caption" className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {compare === 'after' ? 'Redacted — this is your file' : 'Before — your original'}
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
      pageLabel={showingOutput ? 'Redacted page' : 'Page'}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={pageIndex}
      onSelect={goToPage}
      label={showingOutput ? 'Redacted pages' : 'Pages'}
      renderBadge={
        run.phase === 'done'
          ? undefined
          : (i) => {
              const count = perPage.get(i);
              if (!count) return null;
              return (
                <span
                  data-testid={`rail-badge-${i + 1}`}
                  title={`${plural(count, 'mark')} on this page`}
                  className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white"
                >
                  {count}
                </span>
              );
            }
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const mm = selected && geometry ? markRectToMm(selected.rect, geometry) : null;
  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start md:max-lg:gap-x-6" inert={!editing}>
      <section className="flex flex-col gap-2" aria-labelledby="redact-find-heading">
        <h3 id="redact-find-heading" className={heading}>
          Find text to remove
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void findAndMark();
            }}
            placeholder="A name or number"
            aria-label="Find text to redact"
            data-testid="redact-search"
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
          />
          <button type="button" onClick={() => void findAndMark()} disabled={searching || !query.trim() || status !== 'ready'} data-testid="redact-find" className={outlineButton}>
            <Search className="size-4" aria-hidden="true" />
            {searching ? 'Searching…' : 'Find & mark all'}
          </button>
        </div>
        <p data-testid="search-note" role="status" className="min-h-4 text-xs text-[var(--color-text-secondary)]">
          {searchNote || 'Marks every line of text, on every page, that contains it.'}
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="redact-marks-heading">
        <h3 id="redact-marks-heading" className={heading}>
          Marks
        </h3>
        <p data-testid="mark-count" className="text-sm text-[var(--color-text-secondary)]">
          {markCount === 0
            ? 'Nothing marked yet.'
            : `${plural(markCount, 'area')} marked for redaction on ${plural(pagesMarked, 'page')}`}
        </p>
        {markCount > 0 && (
          <ul data-testid="mark-list" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {marks.map((m, i) => (
              <li key={m.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setPageIndex(m.pageIndex);
                    setSelectedId(m.id);
                  }}
                  aria-pressed={m.id === selectedId}
                  data-testid="mark-list-item"
                  className={cn(
                    'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-xs',
                    m.id === selectedId
                      ? 'bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]'
                      : 'text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
                  )}
                >
                  Mark {i + 1} · page {m.pageIndex + 1}
                </button>
                <button
                  type="button"
                  onClick={() => removeMark(m.id)}
                  aria-label={`Remove mark ${i + 1} on page ${m.pageIndex + 1}`}
                  data-testid="mark-list-remove"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="From left (mm)" testId="mark-x" value={mm ? mm.x : null} onCommit={(x) => editMm({ x })} />
          <NumberField label="From top (mm)" testId="mark-y" value={mm ? mm.y : null} onCommit={(y) => editMm({ y })} />
          <NumberField label="Width (mm)" testId="mark-width" value={mm ? mm.width : null} onCommit={(width) => editMm({ width })} />
          <NumberField label="Height (mm)" testId="mark-height" value={mm ? mm.height : null} onCommit={(height) => editMm({ height })} />
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {selected
            ? 'Type exact values, or use the arrow keys on the mark.'
            : 'Select a mark on the page to set its position exactly.'}
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="redact-confirm-heading">
        <h3 id="redact-confirm-heading" className={heading}>
          Before you redact
        </h3>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-3">
          <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} data-testid="strip-metadata" className="mt-0.5" />
          <span className="text-sm text-[var(--color-text-secondary)]">
            Full metadata strip
            <span className="block text-xs text-[var(--color-text-muted)]">
              Also removes the XMP metadata packet and any embedded file attachments. Author, title and the other
              document-info fields are always cleared.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-3">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            data-testid="confirm-redaction"
            className="mt-0.5 accent-[var(--color-error)]"
          />
          <span className="text-sm text-[var(--color-text-secondary)]">
            I understand that redaction is permanent and cannot be undone. The marked content will be removed.
          </span>
        </label>
        <p className="text-xs text-[var(--color-text-secondary)]">
          The text and image pixels under each mark are removed from the file, not just covered, and so are shapes a
          mark covers completely. After redacting you see the redacted pages before you download.
        </p>
      </section>

      <p className="sr-only" role="status" aria-live="polite" data-testid="mark-announce">
        {announcement}
      </p>
    </div>
  );

  const check = verification && verification.result === run.result ? verification.value : null;
  const result =
    run.phase === 'done' && run.result ? (
      <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
        <h3 className={heading}>Redacted — check it before you download</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          The page shown is the redacted file itself. Switch to Before to compare it with your original.
        </p>
        <ul data-testid="redact-verify" className="flex flex-col gap-1 rounded-lg border border-[var(--color-border)] p-3 text-sm">
          <li data-testid="verify-under-marks" className={cn(check && check.leftUnderMarks > 0 && 'font-medium text-[var(--color-error)]')}>
            {!check
              ? 'Checking the redacted file…'
              : check.leftUnderMarks === 0
                ? `No text found under any of your ${plural(run.result.markCount, 'mark')} in the redacted file.`
                : `${plural(check.leftUnderMarks, 'piece')} of text still found under your marks.`}
          </li>
          {check?.phrases.map(({ phrase, remaining }) => (
            <li key={phrase} data-testid="verify-phrase" className={cn(remaining > 0 && 'font-medium text-[var(--color-error)]')}>
              {remaining === 0 ? `“${phrase}” no longer appears in the file.` : `“${phrase}” still appears ${plural(remaining, 'time')}.`}
            </li>
          ))}
        </ul>
        {run.result.method === 'raster' && (
          <p data-testid="raster-note" className="text-xs text-[var(--color-text-secondary)]">
            This PDF could not be redacted area by area, so every page was turned into an image with the marks
            painted black. Its text can no longer be selected.
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-secondary)]">File</dt>
          <dd className="truncate font-medium text-[var(--color-text-primary)]">{run.result.file.name}</dd>
          <dt className="text-[var(--color-text-secondary)]">Size</dt>
          <dd className="text-[var(--color-text-primary)]">{formatBytes(run.result.file.size)}</dd>
          <dt className="text-[var(--color-text-secondary)]">Marks</dt>
          <dd className="text-[var(--color-text-primary)]">
            {plural(run.result.markCount, 'area')} on {plural(run.result.pageCount, 'page')}
          </dd>
        </dl>
        {run.result.hashes && (
          <div className="border-t border-[var(--color-border)] pt-3" data-testid="sha-panel">
            <p className="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">SHA-256 integrity</p>
            <p className="break-all font-mono text-[10px] text-[var(--color-text-muted)]">
              <span className="font-sans font-medium">Original:</span> <span data-testid="sha-before">{run.result.hashes.before}</span>
            </p>
            <p className="break-all font-mono text-[10px] text-[var(--color-text-muted)]">
              <span className="font-sans font-medium">Redacted:</span> <span data-testid="sha-after">{run.result.hashes.after}</span>
            </p>
          </div>
        )}
        <p className="text-xs text-[var(--color-text-secondary)]">
          Something missed? Make changes takes you back to your marks.
        </p>
      </div>
    ) : undefined;

  return (
    <ToolWorkspace
      toolId="redact-pdf"
      active={active}
      empty={
        <>
          <SecurityNotice />
          <DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to redact" />
        </>
      }
      title="Redact this PDF"
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
          label="Redact PDF"
          runningLabel="Redacting…"
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={progress}
          progressLabel="Removing the marked content"
          onCancel={cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download redacted PDF: ${outputName}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
