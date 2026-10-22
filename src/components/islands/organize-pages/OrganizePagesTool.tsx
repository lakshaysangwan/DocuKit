import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Redo2, RotateCcw, RotateCw, Undo2 } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageGrid, { type PageGridSize } from '@/components/islands/workspace/PageGrid';
import { pageCardButtonClass } from '@/components/islands/workspace/PageCard';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useHistory } from '@/hooks/use-history';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePageThumb } from '@/hooks/use-page-thumb';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import {
  BLANK,
  blankInsertPosition,
  blankSizeSource,
  duplicatePage,
  initialPages,
  insertBlank,
  isUnchanged,
  movePage,
  pruneSelection,
  removePages,
  rotatePages,
  selectRange,
  toReorderOptions,
  toggleSelected,
  turnedAspect,
  type OrganizePage,
  type QuarterTurn,
  type TurnDirection,
} from '@/lib/organize-pages';
import { cn, formatBytes, generateId } from '@/lib/utils';

const ACCEPT = ['application/pdf'];
const A4_ASPECT = 210 / 297;
/** Thumbnail long edge in device pixels, per grid size; the enlarged view gets more. */
const THUMB_PX: Record<PageGridSize, number> = { s: 320, m: 480, l: 800 };
const LARGE_PX = 1600;
const NO_PAGES: OrganizePage[] = [];

const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-xs text-[var(--color-text-secondary)]';
const controlButton =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11';
const toolbarButton =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function turnWords(turn: QuarterTurn): string {
  return turn === 90 ? 'turned right' : turn === 180 ? 'upside down' : turn === 270 ? 'turned left' : '';
}

/**
 * A page drawn as it will come out: the original's own thumbnail (its
 * `/Rotate` already applied by pdf.js) turned by the visitor's quarter turns.
 * It fills the width of a box of the turned page's proportions.
 */
function TurnedPage({
  doc,
  pageIndex,
  longEdge,
  baseAspect,
  turn,
  alt,
  testId,
}: {
  doc: PdfDocHandle | null;
  pageIndex: number;
  longEdge: number;
  /** Width ÷ height of the page as the original shows it. */
  baseAspect: number;
  turn: QuarterTurn;
  alt: string;
  testId: string;
}) {
  const src = usePageThumb(doc, pageIndex, longEdge);
  const aspect = turnedAspect(baseAspect, turn);
  const sideways = turn === 90 || turn === 270;
  return (
    <div
      className="relative w-full overflow-hidden bg-white ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
      data-turn={turn}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          data-testid={testId}
          className="absolute left-1/2 top-1/2 block max-w-none select-none motion-safe:transition-transform"
          style={{
            // Sideways, the picture's width is the box's height: the box's width ÷ aspect.
            width: sideways ? `${100 / aspect}%` : '100%',
            aspectRatio: String(baseAspect),
            transform: `translate(-50%, -50%) rotate(${turn}deg)`,
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[#52525b]">Loading…</div>
      )}
    </div>
  );
}

function BlankPage({ aspect }: { aspect: number }) {
  return (
    <div
      data-testid="blank-page"
      className="flex w-full items-center justify-center bg-white text-[11px] font-medium uppercase tracking-wide text-[#52525b] ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
    >
      Blank
    </div>
  );
}

export default function OrganizePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [gridSize, setGridSize] = useState<PageGridSize>('m');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Where a Shift-click range starts: the page last clicked on its own.
  const anchor = useRef<string | null>(null);

  const history = useHistory<OrganizePage[]>(NO_PAGES);
  const pages = history.value;

  const run = useToolRun<File>();
  const { invalidate, start } = run;
  const phone = useMediaQuery('(max-width: 767px)');

  const { doc, pageCount: total, status: docStatus } = usePdfDocument(file);
  const output = usePdfDocument(run.result);

  // A file pdf.js cannot open (damaged, or locked with a password) goes back to the dropzone.
  useEffect(() => {
    if (docStatus === 'error' || docStatus === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [docStatus]);

  // A newly opened file: every page, in order, and nothing to undo.
  const { reset } = history;
  useEffect(() => {
    if (!doc) return;
    reset(initialPages(doc.pageCount, generateId));
    setSelected(new Set());
    anchor.current = null;
  }, [doc, reset]);

  // Page shapes as the original shows them, so portrait and landscape pages are drawn as they are.
  const [aspects, setAspects] = useState<{ doc: PdfDocHandle; values: number[] } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void Promise.all(
      Array.from({ length: doc.pageCount }, (_, i) =>
        doc.geometry(i).then(
          (g) => g.widthPt / g.heightPt,
          () => A4_ASPECT,
        ),
      ),
    ).then((values) => {
      if (live) setAspects({ doc, values });
    });
    return () => {
      live = false;
    };
  }, [doc]);
  const baseAspectOf = (source: number) =>
    aspects && aspects.doc === doc ? (aspects.values[source] ?? A4_ASPECT) : A4_ASPECT;

  // The same for the saved file, read back once it is done.
  const [outAspects, setOutAspects] = useState<{ doc: PdfDocHandle; values: number[] } | null>(null);
  useEffect(() => {
    const d = output.doc;
    if (!d) return;
    let live = true;
    void Promise.all(
      Array.from({ length: d.pageCount }, (_, i) =>
        d.geometry(i).then(
          (g) => g.widthPt / g.heightPt,
          () => A4_ASPECT,
        ),
      ),
    ).then((values) => {
      if (live) setOutAspects({ doc: d, values });
    });
    return () => {
      live = false;
    };
  }, [output.doc]);

  /* ── File in, file out ─────────────────────────────────────────────────── */

  const accept = useCallback(
    (files: File[]) => {
      const f = files[0];
      if (!f) return;
      invalidate();
      reset(NO_PAGES);
      setSelected(new Set());
      setFile(f);
    },
    [invalidate, reset],
  );

  const removeFile = useCallback(() => {
    invalidate();
    reset(NO_PAGES);
    setSelected(new Set());
    setFile(null);
    setOptionsOpen(false);
  }, [invalidate, reset]);

  /* ── Changes (every one is an undo step and invalidates a finished result) ── */

  const { set: setPages, undo: undoPages, redo: redoPages } = history;
  const change = useCallback(
    (next: (current: OrganizePage[]) => OrganizePage[]) => {
      setPages(next);
      invalidate();
    },
    [setPages, invalidate],
  );
  const undo = useCallback(() => {
    undoPages();
    invalidate();
  }, [undoPages, invalidate]);
  const redo = useCallback(() => {
    redoPages();
    invalidate();
  }, [redoPages, invalidate]);

  // The selection never names a page that is gone (after a delete or an undo).
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(pages, prev);
      return next.size === prev.size ? prev : next;
    });
  }, [pages]);

  const busy = run.phase === 'running';
  const done = run.phase === 'done';
  // Open, and its pages listed (all of them deleted still counts: undo brings them back).
  const ready = docStatus === 'ready' && (pages.length > 0 || history.canUndo);

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo — except while typing.
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (busy) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, busy, undo, redo]);

  const rotate = useCallback(
    (ids: Set<string>, direction: TurnDirection) => change((cur) => rotatePages(cur, ids, direction)),
    [change],
  );
  const remove = useCallback(
    (ids: Set<string>) => change((cur) => removePages(cur, ids)),
    [change],
  );
  const duplicate = useCallback((id: string) => change((cur) => duplicatePage(cur, id, generateId())), [change]);
  const reorder = useCallback((fromId: string, toId: string) => change((cur) => movePage(cur, fromId, toId)), [change]);

  const toggle = useCallback(
    (id: string, shiftKey: boolean) => {
      setSelected((prev) => (shiftKey ? selectRange(pages, prev, anchor.current, id) : toggleSelected(prev, id)));
      if (!shiftKey) anchor.current = id;
    },
    [pages],
  );

  const allIds = () => new Set(pages.map((p) => p.id));
  const selectedCount = selected.size;
  const blankAt = blankInsertPosition(pages, selected);
  const unchanged = isUnchanged(pages, total);

  /* ── The grid ──────────────────────────────────────────────────────────── */

  const aspectOf = (page: OrganizePage, index: number) =>
    page.source === BLANK
      ? turnedAspect(baseAspectOf(blankSizeSource(pages, index)), page.turn)
      : turnedAspect(baseAspectOf(page.source), page.turn);

  const labelOf = (page: OrganizePage, index: number) =>
    page.source === BLANK ? `page ${index + 1} (blank)` : `page ${index + 1}`;

  const detailOf = (page: OrganizePage) => {
    const what = page.source === BLANK ? 'Blank page' : `Original page ${page.source + 1}`;
    const turned = turnWords(page.turn);
    return turned ? `${what} · ${turned}` : what;
  };

  const cardActions = (page: OrganizePage, index: number) => {
    const name = labelOf(page, index);
    const size = cn(gridSize === 's' ? 'size-7' : 'size-8', 'pointer-coarse:size-11');
    return (
      <>
        <button
          type="button"
          onClick={() => rotate(new Set([page.id]), 'left')}
          disabled={busy}
          data-testid="page-rotate-left"
          aria-label={`Rotate ${name} left`}
          title="Rotate left"
          className={cn(pageCardButtonClass, size)}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => rotate(new Set([page.id]), 'right')}
          disabled={busy}
          data-testid="page-rotate-right"
          aria-label={`Rotate ${name} right`}
          title="Rotate right"
          className={cn(pageCardButtonClass, size)}
        >
          <RotateCw className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => duplicate(page.id)}
          disabled={busy}
          data-testid="page-duplicate"
          aria-label={`Duplicate ${name}`}
          title="Duplicate"
          className={cn(pageCardButtonClass, size)}
        >
          <Copy className="size-4" aria-hidden="true" />
        </button>
      </>
    );
  };

  const undoRedo = (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        onClick={undo}
        disabled={!history.canUndo || busy}
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        data-testid="undo"
        className={toolbarButton}
      >
        <Undo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Undo</span>
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!history.canRedo || busy}
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        data-testid="redo"
        className={toolbarButton}
      >
        <Redo2 className="size-4" aria-hidden="true" />
        <span className="max-md:hidden">Redo</span>
      </button>
    </div>
  );

  const outCount = output.doc?.pageCount ?? 0;
  const outAspectOf = (i: number) =>
    outAspects && outAspects.doc === output.doc ? (outAspects.values[i] ?? A4_ASPECT) : A4_ASPECT;
  const outItems = Array.from({ length: outCount }, (_, i) => ({ id: `out-${i}`, index: i }));

  const stage = (
    <div data-testid="organize-stage" className="absolute inset-0">
      {done && run.result ? (
        outCount > 0 ? (
          <PageGrid
            items={outItems}
            getName={() => run.result?.name ?? ''}
            showNames={false}
            getAspect={(item) => outAspectOf(item.index)}
            renderPage={(item, index, view) => (
              <TurnedPage
                doc={output.doc}
                pageIndex={item.index}
                longEdge={view === 'large' ? LARGE_PX : THUMB_PX[gridSize]}
                baseAspect={outAspectOf(item.index)}
                turn={0}
                alt={view === 'large' ? `Page ${index + 1} of ${outCount} of the saved PDF` : ''}
                testId="organize-output-image"
              />
            )}
            getItemLabel={(_, index) => `page ${index + 1} of the saved PDF`}
            cardTestId="organize-output-page"
            size={gridSize}
            onSizeChange={setGridSize}
            caption={`Your new PDF, read back from the saved file · ${plural(outCount, 'page')}`}
            label="Pages of the saved PDF"
            largeTouchTargets
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
            Reading the saved PDF…
          </div>
        )
      ) : ready ? (
        pages.length > 0 ? (
          <PageGrid
            items={pages}
            getName={() => file?.name ?? ''}
            showNames={false}
            getAspect={aspectOf}
            renderPage={(page, index, view) =>
              page.source === BLANK ? (
                <BlankPage aspect={aspectOf(page, index)} />
              ) : (
                <TurnedPage
                  doc={doc}
                  pageIndex={page.source}
                  longEdge={view === 'large' ? LARGE_PX : THUMB_PX[gridSize]}
                  baseAspect={baseAspectOf(page.source)}
                  turn={page.turn}
                  alt={view === 'large' ? `Page ${index + 1} of ${pages.length}: ${detailOf(page)}` : ''}
                  testId="organize-page-image"
                />
              )
            }
            getItemLabel={labelOf}
            getDetail={detailOf}
            getMark={(page) => (selected.has(page.id) ? { state: 'selected' } : undefined)}
            selection={{
              isSelected: (page) => selected.has(page.id),
              onToggle: (page, _index, { shiftKey }) => toggle(page.id, shiftKey),
              getLabel: (page, index) => `Select ${labelOf(page, index)}`,
              getTestId: (_page, index) => `page-select-${index}`,
            }}
            renderActions={cardActions}
            removeVerb="Delete"
            onRemove={(id) => remove(new Set([id]))}
            onReorder={reorder}
            cardTestId="organize-page"
            size={gridSize}
            onSizeChange={setGridSize}
            caption={`${plural(pages.length, 'page')} · ${selectedCount} selected`}
            toolbarExtra={undoRedo}
            disabled={busy}
            label={`Pages of ${file?.name ?? 'the PDF'}`}
            largeTouchTargets
          />
        ) : (
          <div className="absolute inset-0 flex flex-col">
            <div className="flex h-11 shrink-0 items-center justify-end gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4">
              <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">0 pages</p>
              {undoRedo}
            </div>
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-[var(--color-text-secondary)]">
              Every page has been deleted. Undo, or reset to the original, to get them back.
            </div>
          </div>
        )
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
          Reading your PDF…
        </div>
      )}
    </div>
  );

  /* ── Controls ──────────────────────────────────────────────────────────── */

  const controls = (
    <div className="flex flex-col gap-5 p-4" data-testid="organize-controls">
      <section className="flex flex-col gap-2" aria-labelledby="organize-selected-heading">
        <h3 id="organize-selected-heading" className={heading}>
          Selected pages
        </h3>
        <p className={note} data-testid="selection-summary">
          {selectedCount > 0
            ? `${selectedCount} of ${plural(pages.length, 'page')} selected.`
            : 'None selected. Click a page to select it; Shift-click selects every page between.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => rotate(selected, 'left')}
            disabled={busy || selectedCount === 0}
            data-testid="rotate-selected-left"
            className={controlButton}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Rotate selected left
          </button>
          <button
            type="button"
            onClick={() => rotate(selected, 'right')}
            disabled={busy || selectedCount === 0}
            data-testid="rotate-selected-right"
            className={controlButton}
          >
            <RotateCw className="size-4" aria-hidden="true" />
            Rotate selected right
          </button>
          <button
            type="button"
            onClick={() => remove(selected)}
            disabled={busy || selectedCount === 0}
            data-testid="delete-selected"
            className={cn(controlButton, 'col-span-2')}
          >
            Delete selected
          </button>
          <button
            type="button"
            onClick={() => setSelected(allIds())}
            disabled={busy || pages.length === 0 || selectedCount === pages.length}
            data-testid="select-all"
            className={controlButton}
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={busy || selectedCount === 0}
            data-testid="clear-selection"
            className={controlButton}
          >
            Clear selection
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="organize-all-heading">
        <h3 id="organize-all-heading" className={heading}>
          All pages
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => rotate(allIds(), 'left')}
            disabled={busy || pages.length === 0}
            data-testid="rotate-all-left"
            className={controlButton}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Rotate all left
          </button>
          <button
            type="button"
            onClick={() => rotate(allIds(), 'right')}
            disabled={busy || pages.length === 0}
            data-testid="rotate-all-right"
            className={controlButton}
          >
            <RotateCw className="size-4" aria-hidden="true" />
            Rotate all right
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="organize-blank-heading">
        <h3 id="organize-blank-heading" className={heading}>
          Blank page
        </h3>
        <button
          type="button"
          onClick={() => change((cur) => insertBlank(cur, blankInsertPosition(cur, selected), generateId()))}
          disabled={busy}
          data-testid="insert-blank"
          data-position={blankAt}
          className={controlButton}
        >
          {pages.length === 0
            ? 'Add a blank page'
            : blankAt === pages.length
              ? 'Add a blank page at the end'
              : `Add a blank page after page ${blankAt}`}
        </button>
        <p className={note}>
          It goes after the last selected page, or at the end. It takes the size of the page before it; drag it to
          move it.
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="organize-reset-heading">
        <h3 id="organize-reset-heading" className={heading}>
          Start again
        </h3>
        <button
          type="button"
          onClick={() => {
            change(() => initialPages(total, generateId));
            setSelected(new Set());
          }}
          disabled={busy || unchanged}
          data-testid="organize-reset"
          className={controlButton}
        >
          Reset to the original
        </button>
        <p className={note}>Every page back in its first order and turn. Undo brings your changes back.</p>
      </section>
    </div>
  );

  /* ── Result ────────────────────────────────────────────────────────────── */

  const outName = file ? `${file.name.replace(/\.pdf$/i, '')}-organized.pdf` : 'organized.pdf';
  const result =
    done && run.result ? (
      <div className="flex flex-col gap-3 p-4" data-testid="organize-result">
        <h3 className={heading}>Your PDF is ready</h3>
        <p className="text-sm text-[var(--color-text-secondary)]" data-testid="organize-result-facts">
          {outCount > 0 ? `${plural(outCount, 'page')} · ` : ''}
          {formatBytes(run.result.size)}
        </p>
        <p className={note}>
          The pages shown are read back from the saved file, so they are exactly what you will download.
        </p>
        <p className={note}>Something not right? Make changes takes you back to the pages.</p>
      </div>
    ) : undefined;

  /* ── The action ────────────────────────────────────────────────────────── */

  const save = () =>
    start(async (work) => {
      if (!file) return null;
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work(
          'pdf',
          { op: 'reorder', buffer, options: toReorderOptions(pages), progressPort: port2 },
          [buffer, port2],
        );
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message);
        if (response.status !== 'success') throw new Error('Something went wrong. Try again.');
        return new File([response.result], outName, { type: 'application/pdf' });
      } finally {
        port1.close();
      }
    });

  const disabledReason = !ready
    ? 'Reading your PDF…'
    : pages.length === 0
      ? 'Every page has been deleted. Undo or reset to get pages back.'
      : null;
  const where = phone ? 'in Options' : 'on the right';
  const prompt =
    run.phase === 'running'
      ? 'Saving your PDF…'
      : done
        ? 'Done. These are the pages of your new PDF: download it, or make changes.'
        : run.phase === 'error'
          ? 'That did not work. Try saving again.'
          : !ready
            ? 'Reading your PDF…'
            : pages.length === 0
              ? 'Every page has been deleted. Undo, or reset to the original.'
              : selectedCount > 0
                ? `${plural(selectedCount, 'page')} selected. Rotate or delete ${selectedCount === 1 ? 'it' : 'them'} with the buttons ${where}.`
                : 'Drag pages to reorder, or use the buttons on each page to rotate, duplicate or delete it.';

  return (
    <ToolWorkspace
      toolId="rearrange-pdf-pages"
      active={!!file}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={accept} hint="Single PDF file" />}
      title="Rearrange and rotate pages"
      prompt={prompt}
      promptTone={done ? 'success' : run.phase === 'error' ? 'error' : 'info'}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        file ? (
          <WorkspaceFileBar
            file={file}
            extra={total ? plural(total, 'page') : undefined}
            onRemove={removeFile}
            onReplace={accept}
            accept={ACCEPT}
            disabled={busy}
          />
        ) : null
      }
      stage={stage}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label={`Save PDF (${plural(pages.length, 'page')})`}
          runningLabel="Saving…"
          onRun={save}
          disabledReason={disabledReason}
          hint={unchanged ? 'Nothing changed yet: saving gives a copy of the original pages.' : 'Saves the pages as shown, in this order.'}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={
            run.result
              ? {
                  label: 'Download PDF',
                  onDownload: () => downloadBlob(run.result!, run.result!.name),
                  ariaLabel: `Download PDF: ${run.result.name}`,
                }
              : undefined
          }
          summary={
            run.result
              ? `${run.result.name} · ${formatBytes(run.result.size)}${outCount ? ` · ${plural(outCount, 'page')}` : ''}`
              : undefined
          }
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
