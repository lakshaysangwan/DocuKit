import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageRail from '@/components/islands/workspace/PageRail';
import CompareView from '@/components/islands/workspace/CompareView';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useCompressPreview } from './use-compress-preview';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { usePageRender } from '@/hooks/use-page-render';
import { useMediaQuery } from '@/hooks/use-media-query';
import { buildFacts, pageBytesLine, scalePercent } from '@/lib/compress-facts';
import { comparePage, pagesByImageChange, pagesToCheck } from '@/lib/compress-check';
import { compressOptionsFor, LEVEL_PRESETS, type CompressLevel, type CompressSettings } from '@/lib/pdf-compress-presets';
import type { GridComparison } from '@/lib/render-compare';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import { downloadBlob } from '@/lib/download';
import { notifyPdfLoadError } from '@/lib/notify';
import { formatBytes, cn } from '@/lib/utils';
import { supportsOffscreenCanvas } from '@/lib/canvas-2d';
import type { ProcessingStats } from '@/types/worker-messages';

/**
 * Compress PDF, in the shared workspace.
 *
 * The page is shown large. After a run the stage compares the chosen page of
 * the original with the same page of the real output — any page, at Fit, 100%
 * or 200%, never cropped — and says what was done to that page's images, from
 * what the compression pass itself reported. Every page looked at, and a few
 * sampled in the background, are checked for having come out grossly wrong
 * (black, inverted, parts missing); when one has, the visitor is told and the
 * download becomes "Download anyway".
 */

type SizeUnit = 'KB' | 'MB';

/** Sizes on this site are binary: 1 KB = 1024 bytes, as `formatBytes` shows them. */
const UNIT_BYTES: Record<SizeUnit, number> = { KB: 1024, MB: 1024 * 1024 };
/** Size limits people are commonly asked to meet by upload forms and email. */
const TARGET_PRESETS_KB = [100, 200, 500, 1024, 2048];
const formatTargetKb = (kb: number) => (kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`);
/** CSS pixels per PDF point at 100%. */
const CSS_PER_PT = 96 / 72;
/** Page shape assumed until the real one is known (A4). */
const DEFAULT_PAGE = { w: 595 * CSS_PER_PT, h: 842 * CSS_PER_PT };
const ACCEPT = ['application/pdf'];

const LEVELS: { value: CompressLevel; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Lossless — images untouched' },
  { value: 'medium', label: 'Medium', description: `Images at JPEG quality ${LEVEL_PRESETS.medium.jpegQuality}` },
  { value: 'high', label: 'High', description: `JPEG quality ${LEVEL_PRESETS.high.jpegQuality}, images scaled down` },
  { value: 'custom', label: 'Custom', description: 'Choose quality and scale' },
  { value: 'target', label: 'Target size', description: 'Fit under a size limit' },
];

const toolButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-40';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listPages = (pages: number[]) => {
  const n = pages.map((p) => p + 1);
  return n.length === 1 ? `${n[0]}` : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

interface CompressOutput {
  file: File;
  stats: ProcessingStats;
  settings: CompressSettings;
  /** Target size mode: the limit as the visitor typed it. */
  targetLabel?: string;
}

interface CompressPdfToolProps {
  /** Start in Target size mode at this many KB — set by the size-specific landing pages. */
  initialTargetKb?: number;
}

/** Page size at 100%, in CSS pixels. */
function usePageSize(doc: PdfDocHandle | null, pageIndex: number) {
  const [size, setSize] = useState<{ doc: PdfDocHandle; pageIndex: number; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!doc || doc.destroyed || pageIndex >= doc.pageCount) return;
    let live = true;
    doc.geometry(pageIndex).then(
      (g) => {
        if (live) setSize({ doc, pageIndex, w: g.widthPt * CSS_PER_PT, h: g.heightPt * CSS_PER_PT });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, pageIndex]);
  return size && size.doc === doc && size.pageIndex === pageIndex ? size : null;
}

/** Whether pdf.js finds any text on the page; undefined until known. */
function usePageHasText(doc: PdfDocHandle | null, pageIndex: number) {
  const [known, setKnown] = useState<{ doc: PdfDocHandle; pages: Map<number, boolean> } | null>(null);
  useEffect(() => {
    if (!doc || doc.destroyed || pageIndex >= doc.pageCount) return;
    if (known?.doc === doc && known.pages.has(pageIndex)) return;
    let live = true;
    doc.textContent(pageIndex).then(
      (items) => {
        if (!live) return;
        const hasText = items.some((item) => item.str.trim().length > 0);
        setKnown((prev) => {
          const pages = new Map(prev?.doc === doc ? prev.pages : []);
          pages.set(pageIndex, hasText);
          return { doc, pages };
        });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc, pageIndex, known]);
  return known?.doc === doc ? known.pages.get(pageIndex) : undefined;
}

export default function CompressPdfTool({ initialTargetKb }: CompressPdfToolProps) {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [pageIndex, setPageIndex] = useState(0);

  const [level, setLevel] = useState<CompressLevel>(initialTargetKb ? 'target' : 'medium');
  // The target is held as the number and unit the user sees, not as bytes, so
  // "2 MB" round-trips through the field instead of becoming "2048 KB".
  const [targetValue, setTargetValue] = useState(
    initialTargetKb && initialTargetKb >= 1024 ? initialTargetKb / 1024 : (initialTargetKb ?? 200),
  );
  const [targetUnit, setTargetUnit] = useState<SizeUnit>(initialTargetKb && initialTargetKb >= 1024 ? 'MB' : 'KB');
  const targetBytes = Math.round(targetValue * UNIT_BYTES[targetUnit]);
  const targetLabel = `${targetValue} ${targetUnit}`;
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(75);
  const [grayscale, setGrayscale] = useState(false);
  const [stripFonts, setStripFonts] = useState(false);
  const settings = useMemo<CompressSettings>(
    () => ({ level, dpi, jpegQuality, grayscale, stripFonts, targetBytes }),
    [level, dpi, jpegQuality, grayscale, stripFonts, targetBytes],
  );

  const run = useToolRun<CompressOutput>();
  const output = usePdfDocument(run.result?.file ?? null);
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [displayWidth, setDisplayWidth] = useState(0);

  const active = !!file;
  const done = run.phase === 'done' && !!run.result;
  const outDoc = done ? output.doc : null;
  const index = Math.min(pageIndex, Math.max(pageCount - 1, 0));

  // A file that cannot be opened: say so and go back to the dropzone.
  useEffect(() => {
    if (status === 'error' || status === 'locked') {
      notifyPdfLoadError();
      setFile(null);
    }
  }, [status]);

  const { invalidate } = run;
  /** Every settings change makes a result stale. */
  const change = useCallback(
    <T,>(set: (value: T) => void) =>
      (value: T) => {
        set(value);
        invalidate();
      },
    [invalidate],
  );

  // Whether the visitor has moved to a page: until then the preview may choose one.
  const moved = useRef(false);

  const acceptFile = useCallback(
    (files: File[]) => {
      const next = files[0];
      if (!next) return;
      invalidate();
      setFile(next);
      setPageIndex(0);
      moved.current = false;
    },
    [invalidate],
  );

  const removeFile = useCallback(() => {
    invalidate();
    setFile(null);
  }, [invalidate]);

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-compressed.pdf`;
  const targetInvalid = level === 'target' && !(targetBytes > 0);

  const compress = useCallback(() => {
    if (!file || targetInvalid) return;
    const used = settings;
    const label = level === 'target' ? targetLabel : undefined;
    void run.start(async (work) => {
      const buffer = await file.arrayBuffer();
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work(
          'pdf',
          { op: 'compress-pdf', buffer, options: compressOptionsFor(used), progressPort: port2 },
          [buffer, port2],
        );
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message || 'The PDF could not be compressed.');
        if (response.status !== 'success') throw new Error('The PDF could not be compressed.');
        return {
          file: new File([response.result], outputName, { type: 'application/pdf' }),
          stats: response.stats ?? {},
          settings: used,
          targetLabel: label,
        };
      } finally {
        port1.close();
      }
    });
  }, [file, targetInvalid, settings, level, targetLabel, run, outputName]);

  /* ── The corruption check, on the real output ─────────────────────────── */

  const [verdicts, setVerdicts] = useState<{ doc: PdfDocHandle; pages: Map<number, GridComparison> } | null>(null);
  const checked = verdicts && verdicts.doc === outDoc ? verdicts.pages : null;
  const imageOrder = useMemo(() => pagesByImageChange(run.result?.stats.images), [run.result]);

  useEffect(() => {
    if (!doc || !outDoc || outDoc.pageCount !== doc.pageCount) return;
    const controller = new AbortController();
    const order = pagesToCheck(index, doc.pageCount, imageOrder);
    (async () => {
      for (const p of order) {
        if (controller.signal.aborted) return;
        try {
          const result = await comparePage(doc, outDoc, p, controller.signal);
          if (controller.signal.aborted) return;
          setVerdicts((prev) => {
            const pages = new Map(prev?.doc === outDoc ? prev.pages : []);
            pages.set(p, result);
            return { doc: outDoc, pages };
          });
        } catch {
          // A page that cannot be drawn is not judged; the next one still is.
        }
      }
    })();
    return () => controller.abort();
    // Pages already judged are not judged again: `checked` is read, not depended on.
  }, [doc, outDoc, index, imageOrder]);

  const suspectPages = useMemo(
    () => (checked ? [...checked.entries()].filter(([, v]) => v.verdict === 'suspect').map(([p]) => p).sort((a, b) => a - b) : []),
    [checked],
  );
  const suspect = suspectPages.length > 0;

  /* ── What is on the stage ─────────────────────────────────────────────── */

  // The live preview: on desktop it follows every change; on a phone, or where a
  // worker cannot draw (compression would then block the page), it waits for
  // "Preview quality".
  const preview = useCompressPreview({
    file: status === 'ready' ? file : null,
    pageIndex: index,
    settings,
    auto: !phone && supportsOffscreenCanvas,
    paused: run.phase === 'running' || done,
    onPageChosen: useCallback((i: number) => {
      if (!moved.current) setPageIndex(i);
    }, []),
  });
  const previewShown = !done && preview.shown && preview.shown.pageIndex === index ? preview.shown : null;
  const previewDoc = usePdfDocument(previewShown?.pdf ?? null).doc;

  const pageSize = usePageSize(doc, index);
  // Rendered only once the page's own shape is known, so the first render is the right size.
  const renderWidth = pageSize ? displayWidth : 0;
  const beforeUrl = usePageRender(doc, index, renderWidth);
  // After a run, the page of the real output; before it, the one-page preview.
  const afterUrl = usePageRender(done ? outDoc : previewDoc, done ? index : 0, renderWidth);
  const pageHasText = usePageHasText(doc, index);
  const source: 'output' | 'preview' | null = done ? 'output' : previewShown ? 'preview' : null;
  const comparing = !!source && !!beforeUrl && !!afterUrl;
  const previewBusy = !done && preview.status === 'working';

  const previewFacts = useMemo(() => {
    const applied = previewShown?.stats.applied;
    if (!applied) return null;
    return buildFacts({
      phase: 'preview',
      pageIndex: index,
      reportPageIndex: 0,
      applied,
      images: previewShown.stats.images,
      pageHasText,
    });
  }, [previewShown, index, pageHasText]);

  const result = run.result;
  const facts = useMemo(() => {
    if (!result?.stats.applied) return null;
    return buildFacts({
      phase: 'result',
      pageIndex: index,
      applied: result.stats.applied,
      images: result.stats.images,
      returnedOriginal: result.stats.returnedOriginal,
      pageHasText,
      targetLabel: result.targetLabel,
      targetMissed: result.settings.level === 'target' && result.file.size > result.settings.targetBytes,
    });
  }, [result, index, pageHasText]);

  const goToPage = useCallback(
    (next: number) => {
      if (next < 0 || next >= pageCount) return;
      moved.current = true;
      setPageIndex(next);
    },
    [pageCount],
  );

  const pager = (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => goToPage(index - 1)}
        disabled={index <= 0}
        aria-label="Previous page"
        data-testid="page-prev"
        className={toolButton}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </button>
      <span
        data-testid="page-indicator"
        aria-live="polite"
        className="min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-[var(--color-text-primary)]"
      >
        {pageCount > 0 ? `Page ${index + 1} of ${pageCount}` : 'Page'}
      </span>
      <button
        type="button"
        onClick={() => goToPage(index + 1)}
        disabled={index >= pageCount - 1}
        aria-label="Next page"
        data-testid="page-next"
        className={toolButton}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
    </div>
  );

  const levelName = LEVELS.find((l) => l.value === level)?.label ?? 'this level';
  const factsLine = (f: { heading: string; pageImageBytes?: { before: number; after: number } }) =>
    f.pageImageBytes ? `${f.heading} · ${pageBytesLine(f.pageImageBytes)}` : f.heading;
  let stageStatus: string;
  if (status !== 'ready') stageStatus = 'Opening your PDF…';
  else if (run.phase === 'running') stageStatus = 'Compressing your PDF…';
  else if (done && facts) {
    stageStatus = factsLine(facts);
    if (!comparing) stageStatus += ' · drawing the compressed page…';
  } else if (done) stageStatus = `Result for page ${index + 1}`;
  else if (level === 'target')
    stageStatus = `Page ${index + 1}, your original. Target size shows its result after compressing: what it takes depends on the whole file.`;
  else if (preview.status === 'error') stageStatus = `The preview of page ${index + 1} could not be made. Compressing still works.`;
  else if (preview.status === 'waiting')
    stageStatus = `Page ${index + 1}, your original. Press Preview quality to see it at ${levelName}.`;
  else if (previewBusy) stageStatus = `Making the preview of page ${index + 1} at ${levelName}…`;
  else if (previewFacts) stageStatus = factsLine(previewFacts);
  else stageStatus = `Page ${index + 1}, your original.`;

  const showPreviewButton = !done && run.phase !== 'running' && level !== 'target' && !preview.live && preview.status !== 'off';

  const corruptionWarning = suspect
    ? `${suspectPages.length === 1 ? 'Page' : 'Pages'} ${listPages(suspectPages)} ${suspectPages.length === 1 ? 'looks' : 'look'} badly wrong after compressing — for example dark, inverted or with parts missing. Look before you download; the file can still be downloaded.`
    : null;

  const stage = (
    <div className="absolute inset-0 flex flex-col">
      <div
        className="relative min-h-0 flex-1"
        data-testid={comparing ? 'compress-preview' : 'compress-page'}
        data-source={comparing ? source : undefined}
        data-busy={previewBusy ? 'true' : 'false'}
        data-live={preview.live ? 'true' : 'false'}
      >
        <CompareView
          before={beforeUrl ? { src: beforeUrl, alt: `Before image, page ${index + 1}` } : null}
          after={comparing ? { src: afterUrl, alt: `After image, page ${index + 1}` } : null}
          naturalWidth={(pageSize ?? DEFAULT_PAGE).w}
          naturalHeight={(pageSize ?? DEFAULT_PAGE).h}
          beforeLabel="Original"
          afterLabel="Compressed"
          onDisplayWidth={setDisplayWidth}
          toolbarStart={pager}
          busy={(done && !comparing) || previewBusy}
        />
      </div>
      <div className="flex min-h-12 shrink-0 flex-col justify-center gap-0.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <p data-testid="preview-status" aria-live="polite" className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]">
            {stageStatus}
          </p>
          {showPreviewButton && (
            <button
              type="button"
              onClick={preview.request}
              disabled={preview.status === 'working' || preview.current}
              data-testid="preview-quality"
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preview.status === 'working' ? 'Making preview…' : 'Preview quality'}
            </button>
          )}
        </div>
        {corruptionWarning && (
          <p data-testid="corruption-warning" role="alert" className="text-xs font-medium text-[var(--color-error)]">
            {corruptionWarning}
          </p>
        )}
      </div>
    </div>
  );

  const rail = (
    <PageRail
      doc={doc}
      current={index}
      onSelect={goToPage}
      renderBadge={(i) =>
        suspectPages.includes(i) ? (
          <span
            data-testid={`rail-warning-${i + 1}`}
            title="Looks badly wrong after compressing"
            className="flex size-5 items-center justify-center rounded-full bg-[var(--color-error)] text-[11px] font-bold text-white"
          >
            !
          </span>
        ) : null
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const customScale = dpi < 150 ? dpi / 150 : 1;

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      <section className="flex flex-col gap-2" aria-labelledby="cp-level-heading">
        <h3 id="cp-level-heading" className={heading}>
          Compression level
        </h3>
        <div className="grid grid-cols-2 gap-2" data-testid="compress-levels">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => change(setLevel)(l.value)}
              aria-pressed={level === l.value}
              className={cn(
                'rounded-lg border p-2.5 text-left transition-colors',
                l.value === 'target' && 'col-span-2',
                level === l.value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                  : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50',
              )}
            >
              <p className={cn('text-sm font-medium', level === l.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]')}>
                {l.label}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{l.description}</p>
            </button>
          ))}
        </div>
      </section>

      {previewFacts && level !== 'target' && (
        <section data-testid="quality-facts" aria-labelledby="cp-preview-heading" className="flex flex-col gap-1.5">
          <h3 id="cp-preview-heading" className={heading}>
            {previewFacts.heading}
          </h3>
          {previewFacts.lines.map((line) => (
            <p key={line} className="text-sm text-[var(--color-text-secondary)]">
              {line}
            </p>
          ))}
          {previewFacts.pageImageBytes && (
            <p data-testid="preview-page-size" className="text-sm text-[var(--color-text-secondary)]">
              {pageBytesLine(previewFacts.pageImageBytes)}
            </p>
          )}
          <p className="text-xs text-[var(--color-text-secondary)]">
            The whole file's size is known only after compressing.
          </p>
        </section>
      )}

      {level === 'target' && (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <label htmlFor="cp-target-size" className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
            Make the PDF no larger than
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="cp-target-size"
              type="number"
              min={1}
              step="any"
              value={targetValue}
              onChange={(e) => change(setTargetValue)(Math.max(0, Number(e.target.value)))}
              className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none"
            />
            <select
              aria-label="Size unit"
              value={targetUnit}
              onChange={(e) => change(setTargetUnit)(e.target.value as SizeUnit)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none"
            >
              <option value="KB">KB</option>
              <option value="MB">MB</option>
            </select>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TARGET_PRESETS_KB.map((kb) => (
              <button
                key={kb}
                type="button"
                onClick={() => {
                  change(setTargetValue)(kb >= 1024 ? kb / 1024 : kb);
                  setTargetUnit(kb >= 1024 ? 'MB' : 'KB');
                }}
                aria-pressed={targetBytes === kb * 1024}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  targetBytes === kb * 1024
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/50',
                )}
              >
                {formatTargetKb(kb)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--color-text-secondary)]">
            Images are compressed only as much as needed to fit; text and vector graphics are not changed. The result
            and what it took are shown after compressing. 1 KB = 1024 bytes, as sizes are shown everywhere on this site.
          </p>
        </section>
      )}

      {level === 'custom' && (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3" aria-labelledby="cp-custom-heading">
          <p id="cp-custom-heading" className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">
            Custom settings
          </p>
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="cp-dpi" className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>Image DPI</span>
                <span className="font-medium tabular-nums">{dpi}</span>
              </label>
              <input
                id="cp-dpi"
                type="range"
                min={36}
                max={300}
                value={dpi}
                aria-describedby="cp-dpi-note"
                onChange={(e) => change(setDpi)(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />
              <p id="cp-dpi-note" className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {customScale < 1
                  ? `Images are scaled to ${scalePercent(customScale)} of their width and height (this value ÷ 150).`
                  : 'From 150 up, images keep their width and height.'}
              </p>
            </div>
            <div>
              <label htmlFor="cp-jpeg-quality" className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>JPEG Quality</span>
                <span className="font-medium tabular-nums">{jpegQuality}%</span>
              </label>
              <input
                id="cp-jpeg-quality"
                type="range"
                min={1}
                max={100}
                value={jpegQuality}
                onChange={(e) => change(setJpegQuality)(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={grayscale}
                onChange={(e) => change(setGrayscale)(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Convert images to grayscale
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={stripFonts}
                onChange={(e) => change(setStripFonts)(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Strip embedded fonts (text may stop displaying)
            </label>
          </div>
        </section>
      )}
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const missedTarget = !!result && result.settings.level === 'target' && result.file.size > result.settings.targetBytes;
  const savedPct = file && result ? Math.round(((file.size - result.file.size) / file.size) * 100) : 0;
  const checkedPages = checked ? [...checked.keys()].sort((a, b) => a - b) : [];

  const resultPanel =
    done && result && file ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-3">
          <p className="text-sm font-medium text-[var(--color-success)]">
            {savedPct > 0 ? `Reduced by ${savedPct}%` : 'No smaller than your original'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <span>Before: {formatBytes(file.size)}</span>
            <span aria-hidden="true">→</span>
            <span>After: {formatBytes(result.file.size)}</span>
          </div>
        </div>

        {missedTarget && result.targetLabel && (
          <div
            role="status"
            data-testid="target-missed"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text-primary)]"
          >
            <p className="font-medium">
              This PDF could not be brought under {result.targetLabel} — the smallest it gets is {formatBytes(result.file.size)}.
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              Only images can be compressed further. What remains is mostly text, fonts or vector graphics, which are
              already compact. Splitting the document into parts is the reliable way under a strict limit.
            </p>
          </div>
        )}

        {facts && (
          <section data-testid="quality-facts" aria-labelledby="cp-facts-heading" className="flex flex-col gap-1.5">
            <h3 id="cp-facts-heading" className={heading}>
              {facts.heading}
            </h3>
            {facts.targetApplied && (
              <p data-testid="target-applied" className="text-sm text-[var(--color-text-primary)]">
                {facts.targetApplied}
              </p>
            )}
            {facts.qualityWarning && (
              <p data-testid="quality-warning" className="text-sm font-medium text-[var(--color-error)]">
                {facts.qualityWarning}
              </p>
            )}
            {facts.lines.map((line) => (
              <p key={line} className="text-sm text-[var(--color-text-secondary)]">
                {line}
              </p>
            ))}
            {facts.pageImageBytes && (
              <p data-testid="page-image-bytes" className="text-sm text-[var(--color-text-secondary)]">
                {pageBytesLine(facts.pageImageBytes)}
              </p>
            )}
          </section>
        )}

        {checkedPages.length > 0 && (
          <p data-testid="check-summary" className="text-xs text-[var(--color-text-secondary)]">
            {suspect
              ? `Checked against your original for pages that came out badly wrong (dark, inverted or with parts missing): ${plural(checkedPages.length, 'page')}, and page${suspectPages.length === 1 ? '' : 's'} ${listPages(suspectPages)} did.`
              : `Checked against your original for pages that came out badly wrong (dark, inverted or with parts missing): page${checkedPages.length === 1 ? '' : 's'} ${listPages(checkedPages)} — none did.`}
          </p>
        )}

        {missedTarget && (
          <NextStep href="/split-pdf/" label="Split PDF">
            Still too large? Divide it into smaller files with
          </NextStep>
        )}
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (status !== 'ready') {
    prompt = 'Opening your PDF…';
  } else if (run.phase === 'running') {
    prompt = 'Compressing your PDF…';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be compressed. Try again.';
    promptTone = 'error';
  } else if (done) {
    if (suspect) {
      prompt = `Page ${suspectPages[0] + 1} looks badly wrong after compressing. Look at it before you download.`;
      promptTone = 'error';
    } else {
      prompt = 'Compare any page with your original, then download the compressed PDF.';
      promptTone = 'success';
    }
  } else if (phone && !optionsOpen) {
    prompt = 'Open Options to choose a compression level, then press Compress PDF.';
  } else {
    prompt = `Choose a compression level ${beside}, then press Compress PDF.`;
  }

  let hint: string;
  if (level === 'low') hint = 'Low keeps every image as it is and only tightens the file.';
  else if (level === 'medium') hint = `Medium re-encodes images at JPEG quality ${LEVEL_PRESETS.medium.jpegQuality}, at full size.`;
  else if (level === 'high')
    hint = `High re-encodes images at JPEG quality ${LEVEL_PRESETS.high.jpegQuality}, scaled to ${scalePercent(LEVEL_PRESETS.high.dpi / 150)} of their width and height.`;
  else if (level === 'custom')
    hint = `Custom: images re-encoded at JPEG quality ${jpegQuality}, ${customScale < 1 ? `scaled to ${scalePercent(customScale)}` : 'at full size'}.`;
  else hint = `Images are compressed only as far as needed to fit under ${targetLabel}.`;

  const disabledReason = status !== 'ready' ? 'Opening your PDF…' : targetInvalid ? 'Enter a target size' : null;
  const summary = result ? `${result.file.name} · ${formatBytes(result.file.size)} · ${plural(pageCount, 'page')}` : undefined;

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result.file, run.result.file.name);
  }, [run.result]);

  return (
    <ToolWorkspace
      toolId="compress-pdf"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="Single PDF file" />}
      title="Compress this PDF"
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
      result={resultPanel}
      action={
        <ActionBar
          phase={run.phase}
          label="Compress PDF"
          runningLabel="Compressing…"
          onRun={compress}
          disabledReason={disabledReason}
          hint={hint}
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{
            label: suspect ? 'Download anyway' : 'Download PDF',
            onDownload: download,
            ariaLabel: `${suspect ? 'Download anyway' : 'Download PDF'}: ${outputName}`,
            variant: suspect ? 'outline' : 'primary',
          }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
