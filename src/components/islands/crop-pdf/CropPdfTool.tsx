import { useCallback, useEffect, useMemo, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import CropPreview from './CropPreview';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useMediaQuery } from '@/hooks/use-media-query';
import { notifyPdfLoadError } from '@/lib/notify';
import { downloadBlob } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import { flattenCrop } from '@/lib/pdf-flatten-crop';
import type { PageGeometry } from '@/lib/pdf/page-geometry';
import {
  CROP_SIDES,
  CROP_UNITS,
  NO_MARGINS,
  UNIT_NAME,
  contentBounds,
  cropTargets,
  croppedSize,
  formatLength,
  fromUnit,
  hasCrop,
  snapMargins,
  toUnit,
  type ApplyTo,
  type CropMargins,
  type CropUnit,
} from '@/lib/crop-layout';
import type { CropOptions } from '@/types/worker-messages';

/**
 * Crop PDF, in the shared workspace.
 *
 * Any page is shown large with the crop box over it; "Current page" is the page
 * shown. The margins are the visual top, right, bottom and left of that page
 * as displayed, held in points and shown in mm, inches or points. Both modes
 * write them through the page's real geometry (`writeCropBoxes`), so a rotated
 * scan or a page with an offset crop box is cut where the box was drawn.
 * After a run the stage shows the real output, with Before / After.
 */

const ACCEPT = ['application/pdf'];
type Mode = 'cropbox' | 'flatten';

const APPLY_LABEL: Record<ApplyTo, string> = { current: 'Current page', all: 'All pages', range: 'Page range' };
const NOT_CROPPED = 'Not cropped';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const chip = (on: boolean) =>
  cn(
    'rounded-lg border px-3 py-2 text-xs transition-colors',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-primary)]/50',
  );
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const input =
  'h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-sm outline-none focus:border-[var(--color-primary)]';

export default function CropPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [pageIndex, setPageIndex] = useState(0);

  const [margins, setMargins] = useState<CropMargins>(NO_MARGINS);
  const [unit, setUnit] = useState<CropUnit>('mm');
  const [applyTo, setApplyTo] = useState<ApplyTo>('all');
  const [range, setRange] = useState('');
  const [mode, setMode] = useState<Mode>('cropbox');
  const [compare, setCompare] = useState<'before' | 'after'>('after');
  const [flattenProgress, setFlattenProgress] = useState(0);
  const [autoNote, setAutoNote] = useState<string | null>(null);

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

  // The shown page's geometry, for the size readout and Auto-crop.
  const [shown, setShown] = useState<{ index: number; geom: PageGeometry } | null>(null);
  useEffect(() => {
    if (!doc || doc.destroyed || index >= doc.pageCount) return;
    let live = true;
    doc.geometry(index).then(
      (geom) => {
        if (live) setShown({ index, geom });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, index]);
  const geom = shown && shown.index === index && doc ? shown.geom : null;

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
  const changeMargins = useMemo(() => change(setMargins), [change]);

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setPageIndex(0);
      setMargins(NO_MARGINS);
      setAutoNote(null);
      setCompare('after');
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
  }, [invalidate]);

  /* ── Which pages ──────────────────────────────────────────────────────── */

  const targets = useMemo(() => cropTargets(applyTo, index, range, pageCount), [applyTo, index, range, pageCount]);
  const targetSet = useMemo(() => new Set(targets), [targets]);

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-cropped.pdf`;

  let disabledReason: string | null = null;
  if (status !== 'ready') disabledReason = 'Opening your PDF…';
  else if (!hasCrop(margins)) disabledReason = 'Drag an edge of the crop box, or type a margin, to choose what to keep.';
  else if (targets.length === 0) disabledReason = 'Type the pages to crop, such as 1-3, 5.';

  const apply = useCallback(() => {
    if (!file || !doc || disabledReason) return;
    const used = margins;
    const chosen = targets;
    const flatten = mode === 'flatten';
    setFlattenProgress(0);
    void run.start(async (work) => {
      const geometries = await Promise.all(chosen.map((i) => doc.geometry(i)));
      const pages = chosen.map((pageIndex, i) => ({ pageIndex, geometry: geometries[i] }));
      const buffer = await file.arrayBuffer();
      let bytes: ArrayBuffer;
      if (flatten) {
        // Flatten rasterises, which needs pdf.js and a 2D surface — both
        // main-thread only here, so it does not go through the worker.
        bytes = await flattenCrop(buffer, pages, used, setFlattenProgress);
      } else {
        const options: CropOptions = { margins: used, pages };
        const { port1, port2 } = new MessageChannel();
        try {
          const response = await work('pdf', { op: 'crop', buffer, options, progressPort: port2 }, [buffer, port2]);
          if (!response) throw new Error('The PDF could not be cropped: the PDF worker stopped. Try again.');
          if (response.status === 'error') throw new Error(response.message || 'The PDF could not be cropped.');
          if (response.status !== 'success') throw new Error('The PDF could not be cropped.');
          bytes = response.result;
        } finally {
          port1.close();
        }
      }
      setCompare('after');
      return new File([bytes], outputName, { type: 'application/pdf' });
    });
  }, [file, doc, disabledReason, margins, targets, mode, run, outputName]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result, run.result.name);
  }, [run.result]);

  /* ── Auto-crop ────────────────────────────────────────────────────────── */

  const [autoBusy, setAutoBusy] = useState(false);
  const autoCrop = useCallback(async () => {
    if (!doc || !geom || doc.destroyed) return;
    const at = index;
    setAutoBusy(true);
    try {
      const rendered = await doc.renderPage(at, { cssWidth: 600, dpr: 1, pixels: true, format: 'png' });
      doc.releasePage(rendered.url);
      const img = rendered.imageData;
      const bounds = img ? contentBounds(img.data, img.width, img.height) : null;
      if (!bounds) {
        setAutoNote(`Page ${at + 1} looks blank, so there is no border to trim.`);
        return;
      }
      changeMargins(
        snapMargins(
          {
            top: bounds.top * geom.heightPt,
            right: bounds.right * geom.widthPt,
            bottom: bounds.bottom * geom.heightPt,
            left: bounds.left * geom.widthPt,
          },
          unit,
        ),
      );
      setAutoNote(`Set to the white border around page ${at + 1}'s content.`);
    } catch {
      setAutoNote(`Page ${at + 1} could not be read for Auto-crop.`);
    } finally {
      setAutoBusy(false);
    }
  }, [doc, geom, index, unit, changeMargins]);

  /* ── The stage ────────────────────────────────────────────────────────── */

  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= pageCount) return;
      setPageIndex(next);
      setAutoNote(null);
    },
    [pageCount],
  );

  const showingOutput = done && compare === 'after' && !!output.doc;
  const viewerDoc = showingOutput ? output.doc : doc;
  const pageCropped = targetSet.has(index);

  const renderOverlay = useCallback(
    (frame: PageFrame) =>
      targetSet.has(frame.pageIndex) ? (
        <CropPreview frame={frame} margins={margins} onChange={changeMargins} unit={unit} />
      ) : null,
    [targetSet, margins, changeMargins, unit],
  );

  let readout = '';
  if (geom) {
    const size = croppedSize({ width: geom.widthPt, height: geom.heightPt }, margins);
    readout = pageCropped
      ? `Page ${index + 1} after crop: ${formatLength(size.width, unit)} × ${formatLength(size.height, unit)} ${unit}`
      : `Page ${index + 1} is not cropped: it is outside the pages chosen.`;
  }

  const previewBar = (
    <div className="flex h-14 items-center px-2 sm:h-12 sm:px-3">
      <p
        data-testid="crop-size-readout"
        data-cropped={pageCropped ? 'true' : 'false'}
        aria-live="polite"
        className="line-clamp-2 min-h-4 min-w-0 text-xs text-[var(--color-text-secondary)]"
      >
        {readout}
      </p>
    </div>
  );

  const compareBar = (
    <div className="flex h-14 items-center gap-3 px-2 sm:h-12 sm:px-3" data-testid="compare-bar">
      <p data-testid="output-caption" className="min-w-0 truncate text-xs font-medium text-[var(--color-text-primary)] sm:text-sm">
        {compare === 'after' ? 'Cropped — this is your file' : 'Before — your original'}
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
      pageLabel={showingOutput ? 'Cropped page' : 'Page'}
      // Room for the handles on the page's edges (44px on touch).
      padding={24}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={index}
      onSelect={goToPage}
      label={showingOutput ? 'Cropped pages' : 'Pages'}
      renderBadge={(i) =>
        targetSet.has(i) ? null : (
          <span
            data-testid={`rail-badge-${i + 1}`}
            className="rounded-md bg-[var(--color-surface)] px-1.5 py-0.5 text-center text-[9px] font-semibold leading-tight text-[var(--color-text-secondary)] shadow-sm ring-1 ring-[var(--color-border)]"
          >
            {NOT_CROPPED}
          </span>
        )
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const step = unit === 'in' ? 0.1 : 1;
  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      <section className="flex flex-col gap-3" aria-labelledby="crop-area-label">
        <div className="flex items-center justify-between gap-3">
          <h3 id="crop-area-label" className={heading}>
            Crop margins
          </h3>
          <div className="flex gap-1 rounded-lg bg-[var(--color-background)] p-0.5" role="group" aria-label="Margin units" data-testid="crop-unit">
            {CROP_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                aria-pressed={unit === u}
                title={UNIT_NAME[u]}
                data-testid={`crop-unit-${u}`}
                className={cn(
                  'h-8 min-w-10 rounded-md px-3 text-xs font-medium transition-colors',
                  unit === u
                    ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                    : 'text-[var(--color-text-muted)]',
                )}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]" data-testid="crop-hint">
          Drag the handles to crop, or type the margins. Arrow keys nudge a focused handle. Top is the top of the page as shown.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {CROP_SIDES.map((side) => (
            <div key={side}>
              <label htmlFor={`crop-margin-${side}`} className="mb-1 block text-xs capitalize text-[var(--color-text-secondary)]">
                {side}
              </label>
              <input
                id={`crop-margin-${side}`}
                type="number"
                inputMode="decimal"
                min={0}
                step={step}
                value={toUnit(margins[side], unit)}
                aria-label={`${side} margin in ${UNIT_NAME[unit]}`}
                onChange={(e) => changeMargins({ ...margins, [side]: fromUnit(Number(e.target.value), unit) })}
                className={input}
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => void autoCrop()}
            disabled={!geom || autoBusy}
            data-testid="crop-autocrop"
            className="h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium hover:border-[var(--color-primary)] disabled:opacity-50"
          >
            Auto-crop whitespace
          </button>
          <span className="text-xs text-[var(--color-text-muted)]">Trims the white border around page {index + 1}.</span>
        </div>
        {autoNote && (
          <p className="text-xs text-[var(--color-text-secondary)]" role="status" data-testid="crop-auto-note">
            {autoNote}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="crop-apply-label">
        <h3 id="crop-apply-label" className={heading}>
          Apply to
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="crop-apply-label">
          {(['current', 'all', 'range'] as ApplyTo[]).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => change(setApplyTo)(a)}
              data-testid={`apply-to-${a}`}
              aria-pressed={applyTo === a}
              className={chip(applyTo === a)}
            >
              {APPLY_LABEL[a]}
            </button>
          ))}
        </div>
        {applyTo === 'range' && (
          <input
            type="text"
            placeholder="e.g. 1-5, 8, 11-13"
            value={range}
            onChange={(e) => change(setRange)(e.target.value)}
            aria-label="Page range to crop"
            data-testid="crop-range"
            className={input}
          />
        )}
        <p className="text-xs text-[var(--color-text-secondary)]" data-testid="crop-targets">
          {applyTo === 'current'
            ? `Crops page ${index + 1}, the page shown.`
            : targets.length === 0
              ? 'No pages chosen yet.'
              : targets.length === pageCount
                ? `Crops all ${plural(pageCount, 'page')}.`
                : `Crops ${plural(targets.length, 'page')} of ${pageCount}; the others are marked “${NOT_CROPPED}”.`}
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="crop-mode-label" data-testid="crop-mode">
        <h3 id="crop-mode-label" className={heading}>
          Crop mode
        </h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => change(setMode)('cropbox')}
            data-testid="crop-mode-cropbox"
            aria-pressed={mode === 'cropbox'}
            className={chip(mode === 'cropbox')}
          >
            CropBox (reversible)
          </button>
          <button
            type="button"
            onClick={() => change(setMode)('flatten')}
            data-testid="crop-mode-flatten"
            aria-pressed={mode === 'flatten'}
            className={chip(mode === 'flatten')}
          >
            Flatten (permanent)
          </button>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {mode === 'cropbox'
            ? 'Hides content outside the crop area. The data stays in the file and the crop can be undone.'
            : 'Turns each cropped page into an image of the area kept, so the trimmed-away content is removed for good. Text on those pages stops being selectable.'}
        </p>
      </section>
    </div>
  );

  const result =
    done && run.result && file ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="crop-result">
        <section className="flex flex-col gap-1.5" aria-labelledby="crop-result-heading">
          <h3 id="crop-result-heading" className={heading}>
            PDF cropped
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {targets.length === pageCount ? `All ${plural(pageCount, 'page')} cropped` : `${plural(targets.length, 'page')} of ${pageCount} cropped`}
            {mode === 'cropbox' ? ' with a CropBox: the trimmed content is hidden, not removed.' : ' and flattened: the trimmed content is gone.'}
          </p>
          <p className="text-sm text-[var(--color-text-secondary)]" data-testid="crop-result-size">
            {formatBytes(file.size)} before, {formatBytes(run.result.size)} after.
          </p>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Look through any page with Before and After; press Make changes to adjust the crop.
          </p>
        </section>
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (status !== 'ready') prompt = 'Opening your PDF…';
  else if (run.phase === 'running') prompt = mode === 'flatten' ? 'Cropping and flattening your PDF…' : 'Cropping your PDF…';
  else if (run.phase === 'error') {
    prompt = 'The PDF could not be cropped. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Check any page, then download your cropped PDF.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Drag the crop box on the page, or open Options to type margins; then press Crop PDF.';
  else prompt = `Drag the crop box on the page or type the margins ${beside}, then press Crop PDF.`;

  const which =
    applyTo === 'current'
      ? `page ${index + 1}`
      : targets.length === pageCount
        ? `all ${plural(pageCount, 'page')}`
        : plural(targets.length, 'page');
  const hint =
    mode === 'cropbox'
      ? `Crops ${which}; the trimmed content stays in the file, hidden.`
      : `Crops ${which} and flattens them; the trimmed content is removed.`;

  const summary = run.result ? `${run.result.name} · ${formatBytes(run.result.size)} · ${plural(pageCount, 'page')}` : undefined;

  return (
    <ToolWorkspace
      toolId="crop-pdf"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to crop" />}
      title="Crop this PDF"
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
          label="Crop PDF"
          runningLabel={mode === 'flatten' ? 'Flattening…' : 'Cropping…'}
          onRun={apply}
          disabledReason={disabledReason}
          hint={hint}
          progress={mode === 'flatten' ? flattenProgress : run.progress}
          progressLabel={mode === 'flatten' ? 'Rasterising cropped pages…' : run.progressLabel}
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
