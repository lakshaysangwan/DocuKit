import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import DropZone from '@/components/islands/shared/DropZone';
import MultiFileDownload, { useMultiFileDownload, type MultiFile } from '@/components/islands/shared/MultiFileDownload';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageGrid, { type PageGridSize, type PageMark } from '@/components/islands/workspace/PageGrid';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePageThumb } from '@/hooks/use-page-thumb';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import type { PdfDocHandle } from '@/lib/pdf/doc-handle';
import type { ImageFormat } from '@/lib/image-codec';
import { notifyPdfLoadError } from '@/lib/notify';
import { pageFileName, stripPdfExtension } from '@/lib/multi-download';
import { formatPageRange } from '@/lib/pdf-page-range';
import { loadPdfDocument } from '@/lib/pdfjs';
import { checkPages, describePages, plural } from '@/lib/split-plan';
import { cn, formatBytes } from '@/lib/utils';
import ExportPreview from './ExportPreview';
import { exportPixelSize, renderAsExported, type ExportDpi, type PageSizePt } from './export-render';

type OutputFormat = ImageFormat;

const ACCEPT = ['application/pdf'];
const FORMATS: OutputFormat[] = ['png', 'jpeg', 'webp', 'avif'];
const DPI_PRESETS: { value: ExportDpi; label: string }[] = [
  { value: 72, label: '72 DPI (screen)' },
  { value: 150, label: '150 DPI (print)' },
  { value: 300, label: '300 DPI (high quality)' },
  { value: 600, label: '600 DPI (archival)' },
];
/** US Letter, until the real page sizes are read. */
const DEFAULT_SIZE: PageSizePt = { widthPt: 612, heightPt: 792 };
/** Thumbnail long edge in device pixels, per grid size. */
const THUMB_PX: Record<PageGridSize, number> = { s: 320, m: 480, l: 800 };

const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-xs text-[var(--color-text-secondary)]';
const choice = (on: boolean) =>
  cn(
    'rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-primary)]/50',
  );

interface Result {
  files: MultiFile[];
  /** The pages converted, zero-based. */
  pages: number[];
}
const NO_FILES: MultiFile[] = [];

/** One page in the grid, as a thumbnail from the open document. */
function PageThumb({ doc, pageIndex, longEdge, aspect }: { doc: PdfDocHandle | null; pageIndex: number; longEdge: number; aspect: number }) {
  const src = usePageThumb(doc, pageIndex, longEdge);
  return src ? (
    <img
      src={src}
      alt=""
      draggable={false}
      data-testid="p2i-page-image"
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

export default function PdfToImageTool({ initialFormat = 'png' }: { initialFormat?: OutputFormat }) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<OutputFormat>(initialFormat);
  const [dpi, setDpi] = useState<ExportDpi>(150);
  const [quality, setQuality] = useState(85);
  // The range field is the source of truth for which pages are exported:
  // "All pages", or the text typed (or written by clicking pages). A typo is
  // flagged and changes nothing: the pages follow the last text that could be read.
  const [pageMode, setPageMode] = useState<'all' | 'range'>('all');
  const [text, setText] = useState('');
  const [goodText, setGoodText] = useState('');
  const [gridSize, setGridSize] = useState<PageGridSize>('m');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const anchor = useRef<number | null>(null);
  const job = useRef<AbortController | null>(null);

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

  // Every page's size, for the pixel sizes, the shapes in the grid and the export.
  const [sizes, setSizes] = useState<{ doc: PdfDocHandle; values: PageSizePt[] } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void Promise.all(
      Array.from({ length: doc.pageCount }, (_, i) =>
        doc.geometry(i).then(
          (g) => ({ widthPt: g.widthPt, heightPt: g.heightPt }),
          () => DEFAULT_SIZE,
        ),
      ),
    ).then((values) => {
      if (live) setSizes({ doc, values });
    });
    return () => {
      live = false;
    };
  }, [doc]);
  const sizesReady = !!sizes && sizes.doc === doc;
  const sizeOf = (i: number) => (sizesReady ? (sizes.values[i] ?? DEFAULT_SIZE) : DEFAULT_SIZE);
  const aspectOf = (i: number) => {
    const s = sizeOf(i);
    return s.widthPt / s.heightPt;
  };

  // The images are drawn from a pdf.js document of their own, opened on the
  // first preview or conversion, so the preview and the files share one path.
  const exportDoc = useRef<{ file: File; promise: Promise<PDFDocumentProxy> } | null>(null);
  const closeExportDoc = useCallback(() => {
    const open = exportDoc.current;
    exportDoc.current = null;
    if (open) void open.promise.then((d) => d.destroy(), () => {});
  }, []);
  const getExportDoc = useCallback(() => {
    if (!file) return Promise.reject(new Error('No PDF is open.'));
    if (exportDoc.current?.file !== file) {
      closeExportDoc();
      exportDoc.current = { file, promise: file.arrayBuffer().then((b) => loadPdfDocument(b)) };
    }
    return exportDoc.current.promise;
  }, [file, closeExportDoc]);
  useEffect(() => closeExportDoc, [file, closeExportDoc]);

  /** Every change makes a finished result stale, and stops a running one. */
  const stale = useCallback(() => {
    job.current?.abort();
    invalidate();
  }, [invalidate]);

  const accept = useCallback(
    (files: File[]) => {
      const f = files[0];
      if (!f) return;
      stale();
      setFile(f);
      setPageMode('all');
      setText('');
      setGoodText('');
      anchor.current = null;
      setGridSize(window.matchMedia('(min-width: 1536px)').matches ? 'm' : 's');
    },
    [stale],
  );

  const removeFile = useCallback(() => {
    stale();
    setFile(null);
    setPageMode('all');
    setText('');
    setGoodText('');
    setOptionsOpen(false);
  }, [stale]);

  /* ── Which pages, and what they become ────────────────────────────────── */

  const typed = total > 0 && pageMode === 'range' ? checkPages(text, total) : null;
  const fieldError = typed && !typed.ok ? typed.error : null;
  const effText = typed && typed.ok ? text : goodText;
  const pages = useMemo(() => {
    if (total === 0) return [];
    if (pageMode === 'all') return Array.from({ length: total }, (_, i) => i);
    const c = checkPages(effText, total);
    return c.ok ? c.pages : [];
  }, [pageMode, effText, total]);
  const selected = useMemo(() => new Set(pages), [pages]);

  const baseName = file ? stripPdfExtension(file.name) : 'document';
  const nameOf = (i: number) => pageFileName(baseName, i + 1, total, format);
  const outputs = pages.map((i) => ({ index: i, name: nameOf(i), ...exportPixelSize(sizeOf(i), dpi) }));

  /** Write the field from a set of pages (clicking rewrites it). */
  const writePages = (next: Iterable<number>) => {
    const value = formatPageRange([...next]);
    setPageMode('range');
    setText(value);
    setGoodText(value);
  };

  const togglePage = (index: number, shiftKey: boolean) => {
    stale();
    const next = new Set(pages);
    if (shiftKey && anchor.current !== null && anchor.current !== index) {
      const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
      for (let i = a; i <= b; i++) next.add(i);
    } else if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    anchor.current = index;
    writePages(next);
  };

  const chooseAll = () => {
    stale();
    setPageMode('all');
  };

  const chooseRange = () => {
    if (pageMode === 'range') return;
    stale();
    // Start from what is exported now, so the pages shown do not jump.
    if (!text.trim() && total > 0) writePages(pages);
    else setPageMode('range');
  };

  const changeText = (value: string) => {
    stale();
    setText(value);
    if (total > 0 && checkPages(value, total).ok) setGoodText(value);
  };

  /* ── The job ──────────────────────────────────────────────────────────── */

  const convert = useCallback(() => {
    if (!file || !sizes || sizes.doc !== doc || pages.length === 0) return;
    const plan = pages.map((i) => ({ index: i, name: pageFileName(baseName, i + 1, total, format), size: sizes.values[i] ?? DEFAULT_SIZE }));
    const settings = { format, dpi, quality };
    job.current?.abort();
    const controller = new AbortController();
    job.current = controller;
    setProgress(0);
    setProgressLabel(`Converting page ${plan[0].index + 1}…`);
    void start(async () => {
      const pdf = await getExportDoc();
      const files: MultiFile[] = [];
      for (let k = 0; k < plan.length; k++) {
        if (controller.signal.aborted) return null;
        const p = plan[k];
        setProgressLabel(`Converting page ${p.index + 1} (${k + 1} of ${plan.length})…`);
        const image = await renderAsExported(pdf, p.index, p.size, settings.dpi, settings.format, settings.quality, controller.signal).catch(
          (err: unknown) => {
            if (controller.signal.aborted) return null;
            throw err;
          },
        );
        if (!image) return null;
        files.push({ name: p.name, blob: image.blob, label: `Page ${p.index + 1}`, width: image.width, height: image.height });
        setProgress(Math.round(((k + 1) / plan.length) * 100));
      }
      return { files, pages: plan.map((p) => p.index) };
    });
  }, [file, sizes, doc, pages, baseName, total, format, dpi, quality, start, getExportDoc]);

  const cancel = () => {
    job.current?.abort();
    run.cancel();
  };

  const resultFiles = run.result?.files ?? NO_FILES;
  const downloads = useMultiFileDownload({
    files: resultFiles,
    zipName: `${baseName}-images.zip`,
    noun: { one: 'image', other: 'images' },
    folderStartIn: 'pictures',
  });

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const busy = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const ready = docStatus === 'ready' && total > 0 && sizesReady;
  const closed = phone && !optionsOpen;
  const beside = closed ? 'in Options' : wide ? 'on the right' : 'below';
  const formatName = format.toUpperCase();

  // On a phone the button shares its row with Options, so the count is left to the hint above it.
  const actionLabel =
    pages.length && !phone ? `Convert ${plural(pages.length, 'page')} to ${formatName}` : `Convert to ${formatName}`;

  const disabledReason = !ready
    ? 'Reading your PDF…'
    : fieldError
      ? 'Fix the page field first: it cannot be read as typed'
      : pages.length === 0
        ? 'Select at least one page to convert'
        : null;

  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (!ready) {
    prompt = 'Reading your PDF…';
  } else if (busy) {
    prompt = 'Converting your pages…';
  } else if (done) {
    prompt =
      resultFiles.length === 1
        ? 'Your image is ready. Download it, or make changes.'
        : `Your ${resultFiles.length} images are ready. Download them, or make changes.`;
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The pages could not be converted. The reason is shown above the button; try again.';
    promptTone = 'error';
  } else if (fieldError) {
    prompt = `The page field cannot be read: ${fieldError} The pages shown have not changed.`;
    promptTone = 'error';
  } else if (pages.length === 0) {
    prompt = `Click the pages you want as images, or type them ${beside}.`;
  } else {
    prompt = `You'll get ${plural(pages.length, `${formatName} image`)}. Click a page to leave it out; its magnifier shows the image as it will be saved.`;
  }

  const hint =
    outputs.length === 1
      ? `You'll get ${outputs[0].name}, ${outputs[0].width} × ${outputs[0].height} px.`
      : `You'll get ${plural(outputs.length, 'image')}: ${outputs[0]?.name} to ${outputs[outputs.length - 1]?.name}.`;

  /* ── Document pane ────────────────────────────────────────────────────── */

  const items = useMemo(() => Array.from({ length: total }, (_, i) => ({ id: `p${i}`, index: i })), [total]);

  const markOf = (i: number): PageMark =>
    selected.has(i) ? { label: 'Selected', state: 'selected' } : { label: 'Not exported', state: 'dimmed' };

  const detailOf = (i: number): string => {
    if (!selected.has(i)) return 'Not exported';
    const s = exportPixelSize(sizeOf(i), dpi);
    return `${nameOf(i)} · ${s.width} × ${s.height} px`;
  };

  const caption = ready
    ? `${pages.length} of ${plural(total, 'page')} will be exported · click a page to include or leave it out`
    : '';

  const stage = (
    <div data-testid="page-selector" className="absolute inset-0">
      {ready ? (
        <PageGrid
          items={items}
          getName={() => file?.name ?? ''}
          showNames={false}
          getAspect={(item) => aspectOf(item.index)}
          renderPage={(item, _index, view) =>
            view === 'large' ? (
              <ExportPreview
                getDoc={getExportDoc}
                pageIndex={item.index}
                size={sizeOf(item.index)}
                format={format}
                dpi={dpi}
                quality={quality}
                name={selected.has(item.index) ? nameOf(item.index) : null}
              />
            ) : (
              <PageThumb doc={doc} pageIndex={item.index} longEdge={THUMB_PX[gridSize]} aspect={aspectOf(item.index)} />
            )
          }
          previewFill
          getItemLabel={(item) => `page ${item.index + 1}`}
          getDetail={(item) => detailOf(item.index)}
          getMark={(item) => markOf(item.index)}
          selection={
            busy
              ? undefined
              : {
                  isSelected: (item) => selected.has(item.index),
                  onToggle: (item, _index, { shiftKey }) => togglePage(item.index, shiftKey),
                  getLabel: (item) => `Page ${item.index + 1}`,
                  getTestId: (item) => `page-select-${item.index}`,
                }
          }
          cardTestId="p2i-page"
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

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4">
      <section className="flex flex-col gap-2" aria-labelledby="p2i-format-title">
        <h3 id="p2i-format-title" className={heading}>
          Output format
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                if (f === format) return;
                stale();
                setFormat(f);
              }}
              aria-pressed={format === f}
              disabled={busy}
              className={cn(choice(format === f), 'font-medium uppercase')}
            >
              {f}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="p2i-dpi-title">
        <h3 id="p2i-dpi-title" className={heading}>
          Resolution
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {DPI_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                if (p.value === dpi) return;
                stale();
                setDpi(p.value);
              }}
              aria-pressed={dpi === p.value}
              disabled={busy}
              className={cn(choice(dpi === p.value), 'text-left')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {format !== 'png' && (
        <section className="flex flex-col gap-1">
          <label htmlFor="p2i-quality" className={cn(heading, 'flex justify-between')}>
            <span>Quality</span>
            <span className="font-normal tabular-nums text-[var(--color-text-secondary)]">{quality}%</span>
          </label>
          <input
            id="p2i-quality"
            type="range"
            min={1}
            max={100}
            value={quality}
            disabled={busy}
            onChange={(e) => {
              stale();
              setQuality(Number(e.target.value));
            }}
            className="w-full accent-[var(--color-primary)]"
          />
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="p2i-pages-title">
        <h3 id="p2i-pages-title" className={heading}>
          Pages
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={chooseAll} aria-pressed={pageMode === 'all'} disabled={busy} className={choice(pageMode === 'all')}>
            All {plural(total, 'page')}
          </button>
          <button type="button" onClick={chooseRange} aria-pressed={pageMode === 'range'} disabled={busy} className={choice(pageMode === 'range')}>
            Custom range
          </button>
        </div>
        {pageMode === 'range' && (
          <>
            <input
              id="p2i-range"
              type="text"
              value={text}
              onChange={(e) => changeText(e.target.value)}
              placeholder="1-5, 8, odd, last"
              aria-label="Page range to convert"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'p2i-range-error p2i-range-help' : 'p2i-range-help'}
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
              <p id="p2i-range-error" data-testid="p2i-range-error" className="text-xs font-medium text-[var(--color-error)]">
                {fieldError} The pages shown have not changed.
              </p>
            )}
          </>
        )}
        <p className={note} data-testid="p2i-count">
          {pages.length} of {plural(total, 'page')} selected
        </p>
        <p id="p2i-range-help" className={note}>
          Click pages (Shift-click for a run of pages), or type them: <code>1-5</code>, <code>8</code>, <code>odd</code>,{' '}
          <code>even</code>, <code>last</code>. Separate them with commas.
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="p2i-outputs-title">
        <h3 id="p2i-outputs-title" className={heading}>
          {outputs.length ? `You'll get ${plural(outputs.length, 'image')}` : "You'll get"}
        </h3>
        {outputs.length === 0 ? (
          <p className={note} data-testid="p2i-outputs-empty">
            One image for each page you choose.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5" data-testid="p2i-outputs" aria-label="Images that will be produced">
            {outputs.map((o) => (
              <li
                key={o.name}
                data-testid="p2i-output"
                data-name={o.name}
                data-width={o.width}
                data-height={o.height}
                className="flex min-w-0 items-baseline justify-between gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5"
              >
                <span data-testid="p2i-output-name" className="truncate text-sm font-medium text-[var(--color-text-primary)]" title={o.name}>
                  {o.name}
                </span>
                <span data-testid="p2i-output-size" className="shrink-0 text-xs tabular-nums text-[var(--color-text-secondary)]">
                  {o.width} × {o.height} px
                </span>
              </li>
            ))}
          </ol>
        )}
        {outputs.length > 0 && (
          <p className={note}>
            Pixel sizes at {dpi} DPI. Open a page with its magnifier to see it as the {formatName} image, with its file size.
          </p>
        )}
      </section>
    </div>
  );

  const resultSize = resultFiles.reduce((s, f) => s + f.blob.size, 0);
  const result = done ? (
    <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
      <h3 className={heading}>Conversion complete!</h3>
      <p className="text-sm text-[var(--color-text-secondary)]" data-testid="p2i-result-facts">
        {plural(resultFiles.length, 'image')} · {formatName} · {dpi} DPI · {formatBytes(resultSize)} · pages{' '}
        {describePages(run.result?.pages ?? [])}
      </p>
      <MultiFileDownload
        files={resultFiles}
        zipName={`${baseName}-images.zip`}
        noun={{ one: 'image', other: 'images' }}
        listLabel="Converted images"
        folderStartIn="pictures"
        controller={downloads}
        hidePrimary
        preview
      />
      <p className={note}>Something not right? Make changes takes you back to the pages and the options.</p>
      <NextStep href="/compress-image/" label="Compress Image">
        Exported images large at high DPI? Optimize with
      </NextStep>
    </div>
  ) : undefined;

  const single = resultFiles.length === 1 ? resultFiles[0] : null;
  const summary = done
    ? single
      ? `${single.name} · ${single.width} × ${single.height} px · ${formatBytes(single.blob.size)}`
      : `${plural(resultFiles.length, 'image')} · ${formatBytes(resultSize)}`
    : undefined;

  return (
    <ToolWorkspace
      toolId="pdf-to-image"
      active={!!file}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={accept} hint="Single PDF file" />}
      title="PDF to Image"
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
          runningLabel="Converting…"
          onRun={convert}
          disabledReason={disabledReason}
          hint={hint}
          progress={progress}
          progressLabel={progressLabel}
          onCancel={cancel}
          download={{
            label: downloads.primaryLabel,
            onDownload: downloads.handlePrimary,
            ariaLabel: downloads.primaryAriaLabel,
            busyLabel: downloads.primaryBusyLabel,
            doneLabel: downloads.primaryDoneLabel,
          }}
          summary={summary}
          onEditAgain={stale}
          error={run.error}
        />
      }
    />
  );
}
