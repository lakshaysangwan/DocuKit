import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import MultiFileDownload, { useMultiFileDownload, type MultiFile } from '@/components/islands/shared/MultiFileDownload';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageGrid, { type PageGridSize, type PageMark } from '@/components/islands/workspace/PageGrid';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePageThumb } from '@/hooks/use-page-thumb';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import { formatPageRange } from '@/lib/pdf-page-range';
import {
  baseNameOf,
  checkEveryN,
  checkPages,
  checkRanges,
  describePages,
  planSplit,
  plural,
  type SplitMode,
  type SplitOutput,
} from '@/lib/split-plan';
import { cn, formatBytes } from '@/lib/utils';
import type { SplitOptions } from '@/types/worker-messages';

const ACCEPT = ['application/pdf'];
const A4_ASPECT = 210 / 297;
/** Thumbnail long edge in device pixels, per grid size; the enlarged view gets more. */
const THUMB_PX: Record<PageGridSize, number> = { s: 320, m: 480, l: 800 };
const LARGE_PX = 1600;
/** Dark enough for white text at AA contrast, distinct from each other. */
const GROUP_COLOURS = ['#1d4ed8', '#b91c1c', '#047857', '#7e22ce', '#b45309', '#0e7490', '#be185d', '#4d7c0f'];
/** Split Every N alternates two of them, so neighbouring parts always differ. */
const ALTERNATE = [GROUP_COLOURS[0], GROUP_COLOURS[4]];

const MODES: { value: SplitMode; label: string; description: string }[] = [
  { value: 'extract', label: 'Extract Pages', description: 'The pages you choose, as one PDF' },
  { value: 'remove', label: 'Remove Pages', description: 'Delete pages and keep the rest' },
  { value: 'ranges', label: 'Split by Range', description: 'One PDF for each range you type' },
  { value: 'every-n', label: 'Split Every N', description: 'Parts of N pages each' },
  { value: 'each', label: 'Extract Each Page', description: 'One PDF per page' },
];

interface SplitFile extends MultiFile {
  pages: number[];
}

interface Result {
  files: SplitFile[];
}

const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-xs text-[var(--color-text-secondary)]';
const NO_FILES: SplitFile[] = [];

/** One page, as a thumbnail from the open document. */
function PageThumb({ doc, pageIndex, longEdge, aspect, alt }: { doc: PdfDocHandle | null; pageIndex: number; longEdge: number; aspect: number; alt: string }) {
  const src = usePageThumb(doc, pageIndex, longEdge);
  return src ? (
    <img
      src={src}
      alt={alt}
      draggable={false}
      data-testid="split-page-image"
      className="block w-full select-none bg-white ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
    />
  ) : (
    <div
      className="flex w-full items-center justify-center bg-white text-xs text-[#52525b] ring-1 ring-black/15"
      style={{ aspectRatio: String(aspect) }}
    >
      Loading…
    </div>
  );
}

function Swatch({ colour }: { colour?: string }) {
  return (
    <span
      aria-hidden="true"
      className="mt-1 size-3 shrink-0 rounded-sm border border-[var(--color-border)]"
      style={colour ? { backgroundColor: colour, borderColor: colour } : undefined}
    />
  );
}

export default function SplitPdfTool({ initialMode = 'extract' }: { initialMode?: SplitMode }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<SplitMode>(initialMode);
  // The page field, as typed, and the last text that could be read. The grid,
  // the output list and the job all follow the last readable text, so a typo
  // is flagged and changes nothing.
  const [text, setText] = useState('');
  const [goodText, setGoodText] = useState('');
  const [nText, setNText] = useState('2');
  const [goodN, setGoodN] = useState(2);
  const [gridSize, setGridSize] = useState<PageGridSize>('m');
  const [optionsOpen, setOptionsOpen] = useState(false);

  const run = useToolRun<Result>();
  const { invalidate, start } = run;

  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');

  const { doc, pageCount: total, status: docStatus } = usePdfDocument(file);

  // A file pdf.js cannot open (damaged, or locked with a password) goes back to the dropzone.
  useEffect(() => {
    if (docStatus === 'error' || docStatus === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [docStatus]);

  // Page shapes, so portrait and landscape pages are drawn as they are.
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
  const aspectOf = (i: number) => (aspects && aspects.doc === doc ? (aspects.values[i] ?? A4_ASPECT) : A4_ASPECT);

  const accept = useCallback(
    (files: File[]) => {
      const f = files[0];
      if (!f) return;
      invalidate();
      setFile(f);
      setText('');
      setGoodText('');
      setGridSize(window.matchMedia('(min-width: 1536px)').matches ? 'm' : 's');
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
    setText('');
    setGoodText('');
    setOptionsOpen(false);
  }, [invalidate]);

  /* ── The plan: what will be produced ──────────────────────────────────── */

  const usesText = mode === 'extract' || mode === 'remove' || mode === 'ranges';
  const read = useCallback(
    (value: string, m: SplitMode) => (m === 'ranges' ? checkRanges(value, total) : checkPages(value, total)),
    [total],
  );
  const typed = total > 0 && usesText ? read(text, mode) : null;
  const fieldError = typed && !typed.ok ? typed.error : null;
  // What the field says when it can be read; otherwise the last text that could.
  const effText = typed && typed.ok ? text : goodText;
  const applied = total > 0 && usesText ? read(effText, mode) : null;
  const pages = applied && applied.ok && 'pages' in applied ? applied.pages : [];
  const ranges = applied && applied.ok && 'ranges' in applied ? applied.ranges : [];
  const nCheck = checkEveryN(nText);
  const nError = mode === 'every-n' && !nCheck.ok ? nCheck.error : null;

  const baseName = file ? baseNameOf(file.name) : 'document';
  const outputs: SplitOutput[] = useMemo(
    () => (total > 0 ? planSplit({ mode, total, baseName, pages, ranges, n: goodN }) : []),
    // `pages` and `ranges` are derived from effText; list what they come from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, total, baseName, effText, goodN],
  );
  const selected = useMemo(() => new Set(mode === 'extract' || mode === 'remove' ? pages : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, effText, total]);

  /* ── Changes (every one invalidates a finished result) ────────────────── */

  const changeMode = (m: SplitMode) => {
    if (m === mode) return;
    invalidate();
    setMode(m);
    // The field is shared: keep it if it reads in the new mode, else keep the
    // last text that did, so the grid never shows something the field does not say.
    if (total > 0 && (m === 'extract' || m === 'remove' || m === 'ranges') && read(text, m).ok) setGoodText(text);
  };

  const changeText = (value: string) => {
    invalidate();
    setText(value);
    if (total > 0 && read(value, mode).ok) setGoodText(value);
  };

  const changeN = (value: string) => {
    invalidate();
    setNText(value);
    const c = checkEveryN(value);
    if (c.ok) setGoodN(c.n);
  };

  /** Clicking a page in Extract or Remove rewrites the field. */
  const togglePage = (index: number) => {
    invalidate();
    const next = new Set(pages);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    const value = formatPageRange([...next]);
    setText(value);
    setGoodText(value);
  };

  /* ── The job ──────────────────────────────────────────────────────────── */

  const split = useCallback(() => {
    if (!file || outputs.length === 0) return;
    const plan = outputs;
    const options: SplitOptions =
      mode === 'extract' || mode === 'remove'
        ? { mode, pages }
        : mode === 'ranges'
          ? { mode, ranges }
          : mode === 'every-n'
            ? { mode, n: goodN }
            : { mode: 'each' };
    void start(async (work) => {
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work('pdf', { op: 'split', buffer, options, progressPort: port2 }, [buffer, port2]);
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message);
        const buffers =
          response.status === 'success-multi' ? response.results : response.status === 'success' ? [response.result] : null;
        if (!buffers || buffers.length !== plan.length) throw new Error('The PDF could not be split.');
        return {
          files: plan.map((o, i) => ({
            name: o.name,
            blob: new Blob([buffers[i]], { type: 'application/pdf' }),
            pages: o.pages,
            label: `Pages ${describePages(o.pages)}`,
          })),
        };
      } finally {
        port1.close();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, outputs, mode, effText, goodN, start]);

  const resultFiles = run.result?.files ?? NO_FILES;
  const downloads = useMultiFileDownload({
    files: resultFiles,
    zipName: `${baseName}-split.zip`,
    noun: { one: 'PDF', other: 'PDFs' },
    folderStartIn: 'downloads',
  });

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const busy = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const ready = docStatus === 'ready' && total > 0;
  const closed = phone && !optionsOpen;
  const beside = closed ? 'in Options' : wide ? 'on the right' : 'below';
  const outPages = outputs.reduce((n, o) => n + o.pages.length, 0);

  const actionLabel = (() => {
    if (mode === 'extract') return pages.length ? `Extract ${plural(pages.length, 'page')}` : 'Extract pages';
    if (mode === 'remove') return pages.length ? `Remove ${plural(pages.length, 'page')}` : 'Remove pages';
    return outputs.length ? `Split into ${plural(outputs.length, 'PDF')}` : 'Split PDF';
  })();

  const disabledReason = !ready
    ? 'Reading your PDF…'
    : fieldError
      ? 'Fix the page field first: it cannot be read as typed'
      : nError
        ? 'Fix the number of pages per PDF first'
        : mode === 'extract' && pages.length === 0
          ? 'Choose at least one page to extract'
          : mode === 'remove' && pages.length === 0
            ? 'Choose the pages to remove'
            : mode === 'remove' && outputs.length === 0
              ? 'That removes every page. Leave at least one'
              : mode === 'ranges' && outputs.length === 0
                ? 'Type at least one range, like 1-3'
                : null;

  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (!ready) {
    prompt = 'Reading your PDF…';
  } else if (busy) {
    prompt = 'Splitting your PDF…';
  } else if (done) {
    prompt =
      resultFiles.length === 1
        ? 'Your PDF is ready. Download it, or make changes.'
        : `Your ${resultFiles.length} PDFs are ready. Download them, or make changes.`;
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be split. The reason is shown above the button; try again.';
    promptTone = 'error';
  } else if (fieldError) {
    prompt = `The page field cannot be read: ${fieldError} The pages shown have not changed.`;
    promptTone = 'error';
  } else if (nError) {
    prompt = `${nError} The pages shown have not changed.`;
    promptTone = 'error';
  } else if (mode === 'extract') {
    prompt = pages.length
      ? `You'll get 1 PDF with ${plural(pages.length, 'page')}. Click pages to add or remove them.`
      : `Click the pages you want in your new PDF, or type them ${beside}.`;
  } else if (mode === 'remove') {
    const kept = outputs[0]?.pages.length ?? 0;
    prompt = !pages.length
      ? `Click the pages to remove, or type them ${beside}.`
      : kept === 0
        ? 'Every page is marked Removed. Click a page to keep it.'
        : `${plural(pages.length, 'page')} marked Removed. You'll get 1 PDF with the other ${plural(kept, 'page')}.`;
  } else if (mode === 'ranges') {
    prompt = outputs.length
      ? `You'll get ${plural(outputs.length, 'PDF')}, labelled on the pages. Type ranges ${beside}; clicking a page shows it larger.`
      : `Type one range per PDF ${beside}, like 1-3, 4-6. Clicking a page shows it larger.`;
  } else if (mode === 'every-n') {
    const last = outputs[outputs.length - 1]?.pages.length ?? 0;
    prompt =
      outputs.length > 1 && last !== goodN
        ? `You'll get ${plural(outputs.length, 'PDF')} of ${plural(goodN, 'page')}; the last has ${plural(last, 'page')}.`
        : `You'll get ${plural(outputs.length, 'PDF')} of ${plural(outputs[0]?.pages.length ?? 0, 'page')}.`;
  } else {
    prompt = `You'll get ${plural(total, 'PDF')}, one for each page.`;
  }

  const hint =
    outputs.length === 1
      ? `You'll get ${outputs[0].name} with ${plural(outputs[0].pages.length, 'page')}.`
      : `You'll get ${plural(outputs.length, 'PDF')}: ${outputs[0]?.name} to ${outputs[outputs.length - 1]?.name}.`;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const items = useMemo(() => Array.from({ length: total }, (_, i) => ({ id: `p${i}`, index: i })), [total]);

  // For each page, the outputs it goes into.
  const destinations = useMemo(() => {
    const map = new Map<number, number[]>();
    outputs.forEach((o, k) => {
      for (const p of o.pages) map.set(p, [...(map.get(p) ?? []), k]);
    });
    return map;
  }, [outputs]);

  const markOf = (i: number): PageMark | undefined => {
    const into = destinations.get(i) ?? [];
    switch (mode) {
      case 'extract':
        if (selected.size === 0) return undefined;
        return selected.has(i) ? { label: 'Selected', state: 'selected' } : { label: 'Not included', state: 'dimmed' };
      case 'remove':
        if (selected.size === 0) return undefined;
        return selected.has(i) ? { label: 'Removed', state: 'removed' } : { label: 'Kept' };
      case 'ranges':
        if (outputs.length === 0) return undefined;
        if (into.length === 0) return { label: 'Not included', state: 'dimmed' };
        return {
          label: `PDF ${into.map((k) => k + 1).join(', ')}`,
          colour: GROUP_COLOURS[into[0] % GROUP_COLOURS.length],
        };
      case 'every-n':
        if (into.length === 0) return undefined;
        return { label: `PDF ${into[0] + 1}`, colour: ALTERNATE[into[0] % 2] };
      case 'each':
        return { label: `PDF ${i + 1}` };
    }
  };

  const detailOf = (i: number): string => {
    const into = destinations.get(i) ?? [];
    if (mode === 'remove' && selected.has(i)) return 'Removed';
    if (into.length === 0) return outputs.length ? 'Not in any file' : '';
    return `In ${into.map((k) => outputs[k].name).join(', ')}`;
  };

  const dividerOf = (i: number): ReactNode => {
    if (mode !== 'every-n' || goodN < 1 || i % goodN !== 0) return null;
    const k = i / goodN;
    const o = outputs[k];
    if (!o) return null;
    return (
      <div className="flex items-center gap-2 pt-1 text-xs font-semibold text-[var(--color-text-primary)]">
        <span className="h-1.5 w-6 shrink-0 rounded-full" style={{ backgroundColor: ALTERNATE[k % 2] }} />
        <span className="shrink-0">
          PDF {k + 1} · pages {describePages(o.pages)}
        </span>
        <span className="truncate font-normal text-[var(--color-text-secondary)]">{o.name}</span>
        <span className="h-px min-w-4 flex-1 bg-[var(--color-border)]" />
      </div>
    );
  };

  const caption = !ready
    ? ''
    : mode === 'extract' || mode === 'remove'
      ? `Click a page to ${mode === 'extract' ? 'choose' : 'remove'} it · ${pages.length} of ${total} selected`
      : mode === 'ranges'
        ? 'Clicking a page shows it larger · ranges are typed in the page field'
        : `${plural(total, 'page')} · clicking a page shows it larger`;

  const picking = (mode === 'extract' || mode === 'remove') && !busy;

  const stage = (
    <div data-testid="page-selector" className="absolute inset-0">
      {ready ? (
        <PageGrid
          items={items}
          getName={() => file?.name ?? ''}
          showNames={false}
          getAspect={(item) => aspectOf(item.index)}
          renderPage={(item, index, view) => (
            <PageThumb
              doc={doc}
              pageIndex={item.index}
              longEdge={view === 'large' ? LARGE_PX : THUMB_PX[gridSize]}
              aspect={aspectOf(item.index)}
              alt={view === 'large' ? `Page ${index + 1} of ${total}` : ''}
            />
          )}
          getItemLabel={(item) => `page ${item.index + 1}`}
          getDetail={(item) => detailOf(item.index)}
          getMark={(item) => markOf(item.index)}
          renderDivider={(item) => dividerOf(item.index)}
          selection={
            picking
              ? {
                  isSelected: (item) => selected.has(item.index),
                  onToggle: (item) => togglePage(item.index),
                  getLabel: (item) => `Page ${item.index + 1}`,
                  getTestId: (item) => `page-select-${item.index}`,
                }
              : undefined
          }
          cardTestId="split-page"
          size={gridSize}
          onSizeChange={setGridSize}
          caption={caption}
          disabled={busy}
          label={`Pages of ${file?.name ?? 'the PDF'}`}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
          Reading your PDF…
        </div>
      )}
    </div>
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const fieldLabel =
    mode === 'extract' ? 'Pages to extract' : mode === 'remove' ? 'Pages to remove' : 'Page ranges, one per PDF';

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4">
      <section className="flex flex-col gap-2" aria-labelledby="split-mode-title">
        <h3 id="split-mode-title" className={heading}>
          Split mode
        </h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-1" data-testid="split-modes">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => changeMode(m.value)}
              aria-pressed={mode === m.value}
              disabled={busy}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                mode === m.value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-primary)]/50',
              )}
            >
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="block text-xs text-[var(--color-text-secondary)] max-md:hidden">{m.description}</span>
            </button>
          ))}
        </div>
      </section>

      {usesText && (
        <section className="flex flex-col gap-1.5">
          <label htmlFor="split-range" className={heading}>
            {fieldLabel}
          </label>
          <input
            id="split-range"
            type="text"
            value={text}
            onChange={(e) => changeText(e.target.value)}
            placeholder={mode === 'ranges' ? '1-3, 4-6, 7-last' : '1-5, 8, odd, last'}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'split-range-error split-range-help' : 'split-range-help'}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'w-full rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:ring-2',
              fieldError
                ? 'border-[var(--color-error)] focus:ring-[var(--color-error)]/20'
                : 'border-[var(--color-border)] focus:border-[var(--color-primary)] focus:ring-[var(--color-primary)]/20',
            )}
          />
          {fieldError && (
            <p id="split-range-error" data-testid="split-range-error" className="text-xs font-medium text-[var(--color-error)]">
              {fieldError} The pages shown have not changed.
            </p>
          )}
          {(mode === 'extract' || mode === 'remove') && ready && (
            <p className={note} data-testid="split-count">
              {pages.length} of {total} pages selected
            </p>
          )}
          <p id="split-range-help" className={note}>
            {mode === 'ranges' ? (
              <>
                Each range becomes its own PDF: <code>1-3, 4-6, 7-last</code> makes 3. A range can also be one page
                (<code>8</code>) or <code>odd</code>, <code>even</code>, <code>last</code>.
              </>
            ) : (
              <>
                Click pages, or type them: <code>1-5</code>, <code>8</code>, <code>odd</code>, <code>even</code>,{' '}
                <code>last</code>. Separate them with commas.
              </>
            )}
          </p>
        </section>
      )}

      {mode === 'every-n' && (
        <section className="flex flex-col gap-1.5">
          <label htmlFor="split-every-n" className={heading}>
            Pages per PDF
          </label>
          <input
            id="split-every-n"
            type="number"
            inputMode="numeric"
            min={1}
            max={total || undefined}
            value={nText}
            onChange={(e) => changeN(e.target.value)}
            aria-invalid={nError ? true : undefined}
            aria-describedby={nError ? 'split-n-error split-n-help' : 'split-n-help'}
            disabled={busy}
            className={cn(
              'w-28 rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:ring-2',
              nError ? 'border-[var(--color-error)]' : 'border-[var(--color-border)] focus:border-[var(--color-primary)]',
            )}
          />
          {nError && (
            <p id="split-n-error" data-testid="split-n-error" className="text-xs font-medium text-[var(--color-error)]">
              {nError}
            </p>
          )}
          <p id="split-n-help" className={note}>
            For example, <code>2</code> cuts a 5-page PDF into pages 1–2, 3–4 and 5.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="split-outputs-title">
        <h3 id="split-outputs-title" className={heading}>
          {outputs.length ? `You'll get ${plural(outputs.length, 'PDF')}` : "You'll get"}
        </h3>
        {outputs.length === 0 ? (
          <p className={note} data-testid="split-outputs-empty">
            {mode === 'remove'
              ? pages.length
                ? 'Nothing: every page is marked to be removed.'
                : 'One PDF without the pages you choose.'
              : mode === 'extract'
                ? 'One PDF of the pages you choose.'
                : 'One PDF for each range you type.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5" data-testid="split-outputs" aria-label="Files that will be produced">
            {outputs.map((o, k) => (
              <li
                key={o.name}
                data-testid="split-output"
                data-name={o.name}
                className="flex min-w-0 items-start gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5"
              >
                <Swatch
                  colour={
                    mode === 'ranges' ? GROUP_COLOURS[k % GROUP_COLOURS.length] : mode === 'every-n' ? ALTERNATE[k % 2] : undefined
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--color-text-primary)]" title={o.name}>
                    {outputs.length > 1 && <span className="text-[var(--color-text-secondary)]">PDF {k + 1} · </span>}
                    <span data-testid="split-output-name">{o.name}</span>
                  </p>
                  <p className={note} data-testid="split-output-pages">
                    {o.pages.length === 1 ? 'Page' : 'Pages'} {describePages(o.pages)} · {plural(o.pages.length, 'page')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {outputs.length > 1 && (
          <p className={note}>
            {outputs.length <= 10
              ? 'Each PDF downloads as its own file. A ZIP of them all is offered too.'
              : `${outputs.length} files are more than browsers reliably save one by one, so the main download is a ZIP; each PDF also has its own Download button.`}
          </p>
        )}
      </section>
    </div>
  );

  const resultSize = resultFiles.reduce((s, f) => s + f.blob.size, 0);
  const result = done ? (
    <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
      <h3 className={heading}>Split complete!</h3>
      <p className="text-sm text-[var(--color-text-secondary)]" data-testid="split-result-facts">
        {plural(resultFiles.length, 'file')} · {formatBytes(resultSize)} · {plural(outPages, 'page')} in all
      </p>
      {resultFiles.length > 1 ? (
        <MultiFileDownload
          files={resultFiles}
          zipName={`${baseName}-split.zip`}
          noun={{ one: 'PDF', other: 'PDFs' }}
          listLabel="Your PDFs"
          folderStartIn="downloads"
          controller={downloads}
          hidePrimary
        />
      ) : (
        <p className={note}>
          {resultFiles[0]?.name}: {resultFiles[0]?.pages.length === 1 ? 'page' : 'pages'}{' '}
          {describePages(resultFiles[0]?.pages ?? [])} of the original. The button below downloads it.
        </p>
      )}
      <p className={note}>Something not right? Make changes takes you back to the pages and the options.</p>
    </div>
  ) : undefined;

  const single = resultFiles.length === 1 ? resultFiles[0] : null;
  const download = single
    ? {
        label: 'Download PDF',
        onDownload: () => downloadBlob(single.blob, single.name),
        ariaLabel: `Download PDF: ${single.name}`,
      }
    : {
        label: downloads.primaryLabel,
        onDownload: downloads.handlePrimary,
        ariaLabel: downloads.primaryAriaLabel,
        busyLabel: downloads.primaryBusyLabel,
        doneLabel: downloads.primaryDoneLabel,
      };
  const summary = done
    ? single
      ? `${single.name} · ${formatBytes(single.blob.size)} · ${plural(single.pages.length, 'page')}`
      : `${plural(resultFiles.length, 'PDF')} · ${formatBytes(resultSize)}`
    : undefined;

  return (
    <ToolWorkspace
      toolId="split-pdf"
      active={!!file}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={accept} hint="Single PDF file · Every page shown" />}
      title="Split PDF"
      prompt={prompt}
      promptTone={promptTone}
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
          label={actionLabel}
          runningLabel="Splitting…"
          onRun={split}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={download}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
