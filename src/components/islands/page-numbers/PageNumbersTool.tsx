import { useCallback, useEffect, useMemo, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import PageNumbersPreview from './PageNumbersPreview';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useMediaQuery } from '@/hooks/use-media-query';
import { notifyPdfLoadError } from '@/lib/notify';
import { downloadBlob } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import {
  DEFAULT_PAGE_NUMBER_OPTIONS,
  PAGE_NUMBER_FONTS,
  PAGE_NUMBER_POSITIONS,
  layoutPageNumber,
  numberedPageCount,
  type PageNumberFont,
  type PageNumberFormat,
  type PageNumberLayoutOptions,
  type PageNumberPosition,
} from '@/lib/page-number-layout';
import type { PageNumberOptions } from '@/types/worker-messages';

/**
 * Add Page Numbers, in the shared workspace.
 *
 * Any page is shown large with its own number drawn on it from
 * `layoutPageNumber` — the function the worker writes with — so the preview is
 * the file: the same text in the same box, at the visual bottom (or top) of a
 * rotated scan too. Pages the options skip say "No number on this page", on
 * the stage and in the rail. After a run the stage shows the real output, with
 * Before / After.
 */

const ACCEPT = ['application/pdf'];

const POSITION_LABEL: Record<PageNumberPosition, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right',
};

const FORMATS: { value: PageNumberFormat; label: string }[] = [
  { value: 'n', label: '1, 2, 3…' },
  { value: 'page-n', label: 'Page 1, Page 2…' },
  { value: 'page-n-of-total', label: 'Page 1 of 10…' },
  { value: 'n-of-total', label: '1/10, 2/10…' },
  { value: 'roman', label: 'i, ii, iii…' },
  { value: 'alpha', label: 'a, b, c…' },
];

const NO_NUMBER = 'No number on this page';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const chip = (on: boolean) =>
  cn(
    'rounded-lg border px-2 py-2 text-xs transition-colors',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-primary)]/50',
  );
const sliderLabel = 'mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]';
const fieldLabel = 'mb-1 block text-xs text-[var(--color-text-secondary)]';
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const input =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-sm outline-none focus:border-[var(--color-primary)]';

export default function PageNumbersTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [pageIndex, setPageIndex] = useState(0);

  const [position, setPosition] = useState<PageNumberPosition>(DEFAULT_PAGE_NUMBER_OPTIONS.position);
  const [format, setFormat] = useState<PageNumberFormat>(DEFAULT_PAGE_NUMBER_OPTIONS.format);
  const [startNumber, setStartNumber] = useState(DEFAULT_PAGE_NUMBER_OPTIONS.startNumber);
  const [skipFirstN, setSkipFirstN] = useState(DEFAULT_PAGE_NUMBER_OPTIONS.skipFirstN);
  const [font, setFont] = useState<PageNumberFont>(DEFAULT_PAGE_NUMBER_OPTIONS.font);
  const [fontSize, setFontSize] = useState(DEFAULT_PAGE_NUMBER_OPTIONS.fontSize);
  const [color, setColor] = useState('#333333');
  const [marginX, setMarginX] = useState(DEFAULT_PAGE_NUMBER_OPTIONS.marginX);
  const [marginY, setMarginY] = useState(DEFAULT_PAGE_NUMBER_OPTIONS.marginY);
  const [compare, setCompare] = useState<'before' | 'after'>('after');

  const run = useToolRun<File>();
  const output = usePdfDocument(run.result);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const [optionsOpen, setOptionsOpen] = useState(false);

  const active = !!file;
  const done = run.phase === 'done' && !!run.result;
  const index = Math.min(pageIndex, Math.max(pageCount - 1, 0));

  useEffect(() => {
    if (status === 'error' || status === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  const { invalidate } = run;
  /** Every change makes a result stale. */
  const change = useCallback(
    <T,>(set: (value: T) => void) =>
      (value: T) => {
        set(value);
        invalidate();
      },
    [invalidate],
  );

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setPageIndex(0);
      setCompare('after');
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
  }, [invalidate]);

  /* ── What gets numbered ──────────────────────────────────────────────── */

  const layoutOptions = useMemo<PageNumberLayoutOptions>(
    () => ({ position, format, startNumber, skipFirstN, font, fontSize, marginX, marginY }),
    [position, format, startNumber, skipFirstN, font, fontSize, marginX, marginY],
  );
  const skipped = Math.min(Math.max(0, Math.floor(skipFirstN)), pageCount);
  const numbered = numberedPageCount(pageCount, layoutOptions);
  const isNumbered = (i: number) => i >= skipped;

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-numbered.pdf`;

  let disabledReason: string | null = null;
  if (status !== 'ready') disabledReason = 'Opening your PDF…';
  else if (numbered === 0) disabledReason = 'Every page is skipped. Lower “Skip first N pages” to number some.';

  const apply = useCallback(() => {
    if (!file || !doc || disabledReason) return;
    const used = layoutOptions;
    const count = pageCount;
    void run.start(async (work) => {
      const indices = Array.from({ length: count }, (_, i) => i).filter((i) => i >= skipped);
      const geometries = await Promise.all(indices.map((i) => doc.geometry(i)));
      const buffer = await file.arrayBuffer();
      const options: PageNumberOptions = {
        ...used,
        color,
        pages: indices.map((pageIndex, i) => ({ pageIndex, geometry: geometries[i] })),
      };
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work('pdf', { op: 'add-page-numbers', buffer, options, progressPort: port2 }, [buffer, port2]);
        // No response without a cancel (a cancel makes the run ignore this)
        // means the worker itself failed: say so rather than going back to idle.
        if (!response) throw new Error('The page numbers could not be added: the PDF worker stopped. Try again.');
        if (response.status === 'error') throw new Error(response.message || 'The page numbers could not be added.');
        if (response.status !== 'success') throw new Error('The page numbers could not be added.');
        setCompare('after');
        return new File([response.result], outputName, { type: 'application/pdf' });
      } finally {
        port1.close();
      }
    });
  }, [file, doc, disabledReason, layoutOptions, pageCount, skipped, color, run, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result, run.result.name);
  }, [run.result]);

  /* ── The stage ────────────────────────────────────────────────────────── */

  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= pageCount) return;
      setPageIndex(next);
    },
    [pageCount],
  );

  const showingOutput = done && compare === 'after' && !!output.doc;
  const viewerDoc = showingOutput ? output.doc : doc;

  const renderOverlay = useCallback(
    (frame: PageFrame) => {
      const placement = layoutPageNumber(frame.geometry, frame.pageIndex, pageCount, layoutOptions);
      if (!placement) return null;
      return <PageNumbersPreview frame={frame} placement={placement} font={font} fontSize={fontSize} color={color} />;
    },
    [pageCount, layoutOptions, font, fontSize, color],
  );

  // The text page `index` will carry: the layout's, without needing the page's geometry.
  const thisText = isNumbered(index) ? layoutPageNumber({ widthPt: 1, heightPt: 1 }, index, pageCount, layoutOptions)?.text : null;
  const pageNote = thisText
    ? `Page ${index + 1} will read “${thisText}”.`
    : `${NO_NUMBER} — ${skipped === 1 ? 'the first page is skipped' : `the first ${skipped} pages are skipped`}.`;

  const previewBar = (
    <div className="flex h-14 items-center px-2 sm:h-12 sm:px-3">
      <p
        data-testid="pn-page-note"
        data-numbered={thisText ? 'true' : 'false'}
        aria-live="polite"
        className="line-clamp-2 min-w-0 text-xs text-[var(--color-text-secondary)]"
      >
        {pageNote}
      </p>
    </div>
  );

  const compareBar = (
    <div className="flex h-14 items-center gap-3 px-2 sm:h-12 sm:px-3" data-testid="compare-bar">
      <p data-testid="output-caption" className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {compare === 'after' ? 'Numbered — this is your file' : 'Before — your original'}
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
      pageIndex={index}
      onPageChange={goToPage}
      overlay={done ? undefined : renderOverlay}
      footer={done ? compareBar : previewBar}
      pageLabel={showingOutput ? 'Numbered page' : 'Page'}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={index}
      onSelect={goToPage}
      label={showingOutput ? 'Numbered pages' : 'Pages'}
      renderBadge={(i) =>
        isNumbered(i) ? null : (
          <span
            data-testid={`rail-badge-${i + 1}`}
            className="rounded-md bg-[var(--color-surface)] px-1.5 py-0.5 text-center text-[9px] font-semibold leading-tight text-[var(--color-text-secondary)] shadow-sm ring-1 ring-[var(--color-border)]"
          >
            {NO_NUMBER}
          </span>
        )
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const [row, col] = position.split('-');
  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      <section className="flex flex-col gap-2" aria-labelledby="pn-position-label">
        <h3 id="pn-position-label" className={heading}>
          Position
        </h3>
        <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="pn-position-label">
          {PAGE_NUMBER_POSITIONS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => change(setPosition)(p)}
              aria-pressed={position === p}
              data-testid={`pn-position-${p}`}
              className={chip(position === p)}
            >
              {POSITION_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {col !== 'center' && (
            <div>
              <label htmlFor="pn-margin-x" className={sliderLabel}>
                <span>From {col} edge</span>
                <span>{marginX} mm</span>
              </label>
              <input
                id="pn-margin-x"
                data-testid="pn-margin-x"
                type="range"
                min={0}
                max={60}
                value={marginX}
                onChange={(e) => change(setMarginX)(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />
            </div>
          )}
          <div className={col === 'center' ? 'col-span-2' : undefined}>
            <label htmlFor="pn-margin-y" className={sliderLabel}>
              <span>From {row} edge</span>
              <span>{marginY} mm</span>
            </label>
            <input
              id="pn-margin-y"
              data-testid="pn-margin-y"
              type="range"
              min={0}
              max={60}
              value={marginY}
              onChange={(e) => change(setMarginY)(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="pn-format-label">
        <h3 id="pn-format-label" className={heading}>
          Format
        </h3>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="pn-format-label">
          {FORMATS.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="pn-format"
                value={f.value}
                checked={format === f.value}
                onChange={() => change(setFormat)(f.value)}
                className="accent-[var(--color-primary)]"
              />
              <span className="text-[var(--color-text-secondary)]">{f.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4" aria-label="Numbering">
        <div>
          <label htmlFor="pn-start" className={fieldLabel}>
            Start number
          </label>
          <input
            id="pn-start"
            type="number"
            min={1}
            value={startNumber}
            onChange={(e) => change(setStartNumber)(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
            className={input}
          />
        </div>
        <div>
          <label htmlFor="pn-skip" className={fieldLabel}>
            Skip first N pages
          </label>
          <input
            id="pn-skip"
            type="number"
            min={0}
            max={pageCount || undefined}
            value={skipFirstN}
            onChange={(e) => change(setSkipFirstN)(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
            className={input}
          />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4" aria-label="Look">
        <div>
          <label htmlFor="pn-font" className={fieldLabel}>
            Font
          </label>
          <select
            id="pn-font"
            data-testid="pn-font"
            value={font}
            onChange={(e) => change(setFont)(e.target.value as PageNumberFont)}
            className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-sm outline-none"
          >
            {PAGE_NUMBER_FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pn-color" className={fieldLabel}>
            Color
          </label>
          <input
            id="pn-color"
            type="color"
            value={color}
            onChange={(e) => change(setColor)(e.target.value)}
            className="h-9 w-full cursor-pointer rounded-lg border border-[var(--color-border)]"
          />
        </div>
        <div className="col-span-2">
          <label htmlFor="pn-font-size" className={sliderLabel}>
            <span>Font size</span>
            <span>{fontSize}pt</span>
          </label>
          <input
            id="pn-font-size"
            type="range"
            min={6}
            max={24}
            value={fontSize}
            onChange={(e) => change(setFontSize)(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)]"
          />
        </div>
      </section>
    </div>
  );

  const coverage =
    numbered === pageCount
      ? `On all ${plural(pageCount, 'page')}.`
      : `On pages ${skipped + 1}–${pageCount}; the first ${plural(skipped, 'page')} ${skipped === 1 ? 'has' : 'have'} no number.`;

  const result = done && run.result ? (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="page-numbers-result">
      <section className="flex flex-col gap-1.5" aria-labelledby="pn-result-heading">
        <h3 id="pn-result-heading" className={heading}>
          Page numbers added
        </h3>
        <p className="text-sm text-[var(--color-text-secondary)]">{coverage}</p>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Look through any page with Before and After; press Make changes to adjust them.
        </p>
      </section>
    </div>
  ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (status !== 'ready') prompt = 'Opening your PDF…';
  else if (run.phase === 'running') prompt = 'Adding page numbers…';
  else if (run.phase === 'error') {
    prompt = 'The page numbers could not be added. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Check any page, then download your numbered PDF.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Open Options to set up your page numbers, then press Add page numbers.';
  else prompt = `Set up your page numbers ${beside}, then press Add page numbers.`;

  const hint =
    numbered === pageCount
      ? `Numbers all ${plural(pageCount, 'page')}.`
      : `Numbers pages ${skipped + 1}–${pageCount}; the first ${plural(skipped, 'page')} ${skipped === 1 ? 'gets' : 'get'} no number.`;

  const summary = run.result ? `${run.result.name} · ${formatBytes(run.result.size)} · ${plural(pageCount, 'page')}` : undefined;

  return (
    <ToolWorkspace
      toolId="add-page-numbers"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to number" />}
      title="Number this PDF"
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
          label="Add page numbers"
          runningLabel="Adding page numbers…"
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download PDF: ${outputName}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
