import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageGrid, { type PageGridSize, type PageGridView } from '@/components/islands/workspace/PageGrid';
import OutputPagePreview from '@/components/islands/workspace/OutputPagePreview';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useMediaQuery } from '@/hooks/use-media-query';
import { downloadBlob } from '@/lib/download';
import { prepareImageForPdf, type PreparedImage } from '@/lib/image-for-pdf';
import {
  PAGE_SIZES,
  PAGE_SIZE_LABEL,
  formatPageMm,
  hasRoomForImage,
  layoutImagePage,
  marginsFor,
  standardPageMm,
  type ImagePageLayout,
} from '@/lib/images-to-pdf-layout';
import { formatBytes, generateId, cn } from '@/lib/utils';
import type { ImagesToPdfOptions } from '@/types/worker-messages';

type PageSize = 'fit' | 'a4' | 'letter' | 'legal';
/**
 * "Center" used to be offered too; it ran the same code as "Fit", so it was a
 * name, not a choice, and has gone. The worker still accepts it.
 */
type Placement = 'fit' | 'stretch' | 'cover';
type Orientation = 'auto' | 'portrait' | 'landscape';

/**
 * What the dropzone takes. JPEG and PNG go into the PDF as they are; the rest
 * are decoded and re-encoded first (see lib/image-for-pdf.ts).
 */
const ACCEPTED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
];
const FORMATS_HINT = 'JPEG, PNG, WebP, GIF, BMP, HEIC · Drop multiple images';

type MarginUnit = 'mm' | 'in' | 'pt';

/** PDF user space is 72 points to the inch; everything else derives from that. */
const POINTS_PER: Record<MarginUnit, number> = { pt: 1, in: 72, mm: 72 / 25.4 };
const MARGIN_UNIT_LABEL: Record<MarginUnit, string> = {
  mm: 'millimetres', in: 'inches', pt: 'points',
};

const PAGE_SIZE_OPTIONS: PageSize[] = ['fit', 'a4', 'letter', 'legal'];
const PLACEMENT_OPTIONS: Placement[] = ['fit', 'stretch', 'cover'];
const ORIENTATION_OPTIONS: { value: Orientation; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];
const ORIENTATION_NOTE: Record<Orientation, string> = {
  auto: 'Each page is turned to match its image: landscape for a wide image, portrait otherwise.',
  portrait: 'Every page is upright, whatever the shape of its image.',
  landscape: 'Every page is turned on its side, whatever the shape of its image.',
};
const ORIENTATION_CAPTION: Record<Orientation, string> = {
  auto: 'turned to match each image',
  portrait: 'portrait',
  landscape: 'landscape',
};

/** What each placement does, said the way the preview shows it. */
const PLACEMENT_NOTE: Record<Placement, string> = {
  fit: 'The whole image, as large as fits inside the margins, in the middle of the page.',
  stretch: 'Stretched to fill the area inside the margins. The image’s proportions are not kept.',
  cover: 'Fills the area inside the margins and runs over them; whatever passes the page edge is cut off.',
};

const OUTPUT_NAME = 'images.pdf';

/** The shape shown for a page whose image has not been read yet. */
const A4_ASPECT = PAGE_SIZES.a4[0] / PAGE_SIZES.a4[1];

interface Item {
  id: string;
  file: File;
  status: 'reading' | 'ready' | 'error';
  /** The image as it will be embedded, once read. */
  image?: PreparedImage;
  /** Object URL of `image.blob`: the preview shows the very bytes that are embedded. */
  url?: string;
  error?: string;
}

interface Result {
  file: File;
  pages: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round2 = (v: number) => Math.round(v * 100) / 100;

const optionButton = (selected: boolean) =>
  cn(
    'rounded-lg border px-3 py-2 text-sm transition-colors',
    selected
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
  );
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
const note = 'text-xs text-[var(--color-text-secondary)]';

export default function ImageToPdfTool() {
  const [items, setItems] = useState<Item[]>([]);
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [placement, setPlacement] = useState<Placement>('fit');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  // Margins are held in points — the only unit the worker's ImagesToPdfOptions
  // take — and shown in the chosen unit. Switching units therefore re-displays
  // the same physical margin: "10 mm" becomes "0.39 in", never "10 in", and going
  // back gives 10 mm again rather than a value rounded twice.
  const [marginUnit, setMarginUnit] = useState<MarginUnit>('mm');
  const [marginsPt, setMarginsPt] = useState(() => {
    const m = 10 * POINTS_PER.mm;
    return { top: m, right: m, bottom: m, left: m };
  });
  const [gridSize, setGridSize] = useState<PageGridSize>('l');
  const [optionsOpen, setOptionsOpen] = useState(false);
  // "Files added" in the options' dropzone, wherever the files came in.
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useToolRun<Result>();
  const { invalidate, start } = run;

  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const coarse = useMediaQuery('(pointer: coarse)');

  // Ids still in the list, and the object URLs made for them — both needed from
  // the asynchronous reader, which outlives the render that started it.
  const alive = useRef(new Set<string>());
  const urls = useRef(new Map<string, string>());

  useEffect(() => {
    const live = alive.current;
    const made = urls.current;
    return () => {
      live.clear();
      for (const url of made.values()) URL.revokeObjectURL(url);
      made.clear();
      if (addedTimer.current) clearTimeout(addedTimer.current);
    };
  }, []);

  const forget = useCallback((id: string) => {
    alive.current.delete(id);
    const url = urls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.current.delete(id);
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const batch: Item[] = files.map((file) => ({ id: generateId(), file, status: 'reading' }));
      // Start at the largest size at which a whole page fits in the document
      // pane without scrolling: large on a big desktop, medium below that.
      if (alive.current.size === 0) setGridSize(window.matchMedia('(min-width: 1536px)').matches ? 'l' : 'm');
      for (const item of batch) alive.current.add(item.id);
      invalidate();
      setItems((prev) => [...prev, ...batch]);

      setJustAdded(true);
      if (addedTimer.current) clearTimeout(addedTimer.current);
      addedTimer.current = setTimeout(() => setJustAdded(false), 1500);

      // One at a time: decoding thirty phone photos at once would exhaust memory.
      void (async () => {
        for (const { id, file } of batch) {
          if (!alive.current.has(id)) continue;
          try {
            const image = await prepareImageForPdf(file);
            if (!alive.current.has(id)) continue;
            const url = URL.createObjectURL(image.blob);
            urls.current.set(id, url);
            setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'ready', image, url } : i)));
          } catch (err) {
            const error = err instanceof Error ? err.message : 'This image could not be read.';
            setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error } : i)));
          }
        }
      })();
    },
    [invalidate],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      invalidate();
      setItems((prev) => {
        const from = prev.findIndex((i) => i.id === fromId);
        const to = prev.findIndex((i) => i.id === toId);
        return from !== -1 && to !== -1 ? arrayMove(prev, from, to) : prev;
      });
    },
    [invalidate],
  );

  const remove = useCallback(
    (id: string) => {
      invalidate();
      forget(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    },
    [invalidate, forget],
  );

  const removeAll = useCallback(() => {
    invalidate();
    for (const id of [...alive.current]) forget(id);
    setItems([]);
    setOptionsOpen(false);
  }, [invalidate, forget]);

  // The options exactly as the worker gets them — and as the preview uses them.
  const options = useMemo<ImagesToPdfOptions>(
    () => ({
      pageSize,
      placement,
      orientation,
      margins: {
        top: round2(marginsPt.top),
        right: round2(marginsPt.right),
        bottom: round2(marginsPt.bottom),
        left: round2(marginsPt.left),
      },
      backgroundColor: '#FFFFFF',
    }),
    [pageSize, placement, orientation, marginsPt],
  );

  const layouts = useMemo(() => {
    const map = new Map<string, ImagePageLayout>();
    for (const item of items) {
      if (item.status === 'ready' && item.image) map.set(item.id, layoutImagePage(item.image, options));
    }
    return map;
  }, [items, options]);

  const create = useCallback(() => {
    const pages = items.filter((i) => i.status === 'ready' && i.image);
    if (pages.length === 0 || pages.length !== items.length) return;
    const sent = options;
    void start(async (work) => {
      const buffers = await Promise.all(pages.map((i) => i.image!.blob.arrayBuffer()));
      const mimeTypes = pages.map((i) => i.image!.mime);
      const { port1, port2 } = new MessageChannel();
      try {
        const response = await work(
          'pdf',
          { op: 'images-to-pdf', buffers, mimeTypes, options: sent, progressPort: port2 },
          [...buffers, port2],
        );
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message);
        if (response.status !== 'success') throw new Error('The PDF could not be created.');
        return {
          file: new File([response.result], OUTPUT_NAME, { type: 'application/pdf' }),
          pages: pages.length,
        };
      } finally {
        port1.close();
      }
    });
  }, [items, options, start]);

  const download = useCallback(() => {
    if (run.result) downloadBlob(run.result.file, run.result.file.name);
  }, [run.result]);

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const count = items.length;
  const reading = items.filter((i) => i.status === 'reading').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const noRoom = [...layouts.values()].some((l) => !hasRoomForImage(l));
  const busy = run.phase === 'running';
  const done = run.phase === 'done';

  const closed = phone && !optionsOpen;
  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (busy) {
    prompt = 'Creating your PDF…';
  } else if (done) {
    prompt = 'Your PDF is ready. Download it, or make changes.';
    promptTone = 'success';
  } else if (run.phase === 'error') {
    prompt = 'The PDF could not be created. Try again.';
    promptTone = 'error';
  } else if (failed > 0) {
    prompt = `${plural(failed, 'image')} could not be read. Remove ${failed === 1 ? 'it' : 'them'} to continue.`;
    promptTone = 'error';
  } else if (reading > 0) {
    prompt = `Reading your ${count === 1 ? 'image' : 'images'}…`;
  } else if (noRoom) {
    prompt = closed
      ? 'The margins leave no room for the image. Open Options and make them smaller.'
      : 'The margins leave no room for the image. Make them smaller.';
    promptTone = 'error';
  } else if (count === 1) {
    prompt = closed
      ? 'This is the page your PDF will have. Open Options to change its size or margins, or press Create PDF.'
      : `This is the page your PDF will have. Change its size or margins ${beside}, or press Create PDF.`;
  } else {
    const drag = coarse ? 'Drag a page by its handle to move it' : 'Drag a page to move it';
    prompt = `These are the ${count} pages your PDF will have, in this order. ${drag}, or press Create PDF.`;
  }

  const disabledReason =
    reading > 0
      ? `Reading your ${count === 1 ? 'image' : 'images'}…`
      : failed > 0
        ? `Remove the ${failed === 1 ? 'image' : 'images'} that could not be read`
        : noRoom
          ? 'The margins leave no room for the image'
          : null;

  const sizeCaption =
    pageSize === 'fit'
      ? 'Fit Image · each page is exactly its image'
      : `${PAGE_SIZE_LABEL[pageSize]} · ${standardPageMm(pageSize)} · ${ORIENTATION_CAPTION[orientation]}`;

  const summary = run.result
    ? `${run.result.file.name} · ${formatBytes(run.result.file.size)} · ${plural(run.result.pages, 'page')}`
    : undefined;

  /* ── Document pane ────────────────────────────────────────────────────── */

  // Guides while the layout can still be changed; the finished pages are shown clean.
  const guides = done ? undefined : marginsFor(options);

  const renderPage = (item: Item, index: number, view: PageGridView) => {
    const layout = layouts.get(item.id);
    if (!layout || !item.url) {
      return (
        <div
          data-testid={item.status === 'error' ? 'page-unreadable' : 'page-reading'}
          role={item.status === 'error' ? 'alert' : undefined}
          className={cn(
            'flex w-full items-center justify-center bg-white p-2 text-center text-xs ring-1 ring-black/15',
            item.status === 'error' ? 'font-medium text-[#b91c1c]' : 'text-[#52525b]',
          )}
          style={{ aspectRatio: String(A4_ASPECT) }}
        >
          {item.status === 'error' ? (item.error ?? 'This image could not be read.') : 'Reading…'}
        </div>
      );
    }
    return (
      <OutputPagePreview
        pageW={layout.pageW}
        pageH={layout.pageH}
        draw={layout.draw}
        margins={guides}
        className="w-full"
      >
        <img
          src={item.url}
          alt={view === 'large' ? `Page ${index + 1}: ${item.file.name}` : ''}
          draggable={false}
          data-testid="output-image"
          className="block size-full select-none"
        />
      </OutputPagePreview>
    );
  };

  const pageDetail = (item: Item) => {
    const layout = layouts.get(item.id);
    if (!layout || !item.image) return undefined;
    const parts: string[] = [];
    if (pageSize === 'fit') parts.push(formatPageMm(layout.pageW, layout.pageH));
    else if (orientation === 'auto') parts.push(layout.pageW > layout.pageH ? 'landscape' : 'portrait');
    if (item.image.reencoded) {
      parts.push(item.image.turned ? 'turned upright' : `saved as ${item.image.mime === 'image/png' ? 'PNG' : 'JPEG'}`);
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
  };

  const stage = (
    <PageGrid
      items={items}
      getName={(item) => item.file.name}
      getAspect={(item) => {
        const layout = layouts.get(item.id);
        return layout ? layout.pageW / layout.pageH : A4_ASPECT;
      }}
      renderPage={renderPage}
      getDetail={pageDetail}
      size={gridSize}
      onSizeChange={setGridSize}
      caption={sizeCaption}
      onReorder={reorder}
      onRemove={remove}
      disabled={busy}
      label="Pages of the PDF, in order"
    />
  );

  /* ── Options ──────────────────────────────────────────────────────────── */

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4">
      <section className="flex flex-col gap-2" aria-labelledby="i2p-add">
        <h3 id="i2p-add" className={heading}>
          Images
        </h3>
        <DropZone
          accept={ACCEPTED_MIMES}
          multiple
          onFiles={addFiles}
          hint={FORMATS_HINT}
          compact
          compactLabel="Add images"
          showAccepted={justAdded}
        />
        <p className={note}>Each image becomes one page. JPEG, PNG, WebP, GIF, BMP or HEIC.</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="i2p-size">
        <h3 id="i2p-size" className={heading}>
          Page Size
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="i2p-size">
          {PAGE_SIZE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                invalidate();
                setPageSize(s);
              }}
              aria-pressed={pageSize === s}
              data-testid={`i2p-size-${s}`}
              className={optionButton(pageSize === s)}
            >
              {s === 'fit' ? 'Fit Image' : PAGE_SIZE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className={note} data-testid="i2p-size-note">
          {pageSize === 'fit'
            ? 'Each page is exactly the size of its image, with no margin.'
            : `Every page is ${PAGE_SIZE_LABEL[pageSize]}, ${standardPageMm(pageSize)}.`}
        </p>
      </section>

      {pageSize !== 'fit' && (
        <section className="flex flex-col gap-2" aria-labelledby="i2p-orientation">
          <h3 id="i2p-orientation" className={heading}>
            Orientation
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="i2p-orientation">
            {ORIENTATION_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  invalidate();
                  setOrientation(o.value);
                }}
                aria-pressed={orientation === o.value}
                data-testid={`i2p-orientation-${o.value}`}
                className={optionButton(orientation === o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className={note} data-testid="i2p-orientation-note">
            {ORIENTATION_NOTE[orientation]}
          </p>
        </section>
      )}

      {pageSize !== 'fit' && (
        <section className="flex flex-col gap-2" aria-labelledby="i2p-placement">
          <h3 id="i2p-placement" className={heading}>
            Image Placement
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="i2p-placement">
            {PLACEMENT_OPTIONS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  invalidate();
                  setPlacement(p);
                }}
                aria-pressed={placement === p}
                data-testid={`i2p-placement-${p}`}
                className={cn(optionButton(placement === p), 'capitalize')}
              >
                {p}
              </button>
            ))}
          </div>
          <p className={note} data-testid="i2p-placement-note">
            {PLACEMENT_NOTE[placement]}
          </p>
        </section>
      )}

      {pageSize !== 'fit' && (
        <section className="flex flex-col gap-2" aria-labelledby="i2p-margins">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id="i2p-margins" className={heading}>
              Margins
            </h3>
            <div className="flex gap-1" role="group" aria-label="Margin units" data-testid="i2p-margin-unit">
              {(['mm', 'in', 'pt'] as MarginUnit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setMarginUnit(u)}
                  data-testid={`i2p-unit-${u}`}
                  aria-pressed={marginUnit === u}
                  title={MARGIN_UNIT_LABEL[u]}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                    marginUnit === u
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-primary)]',
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <div key={side}>
                <label htmlFor={`i2p-margin-${side}`} className="mb-1 block text-xs capitalize text-[var(--color-text-secondary)]">
                  {side}
                </label>
                <input
                  id={`i2p-margin-${side}`}
                  type="number"
                  min={0}
                  step={marginUnit === 'in' ? 0.25 : 1}
                  value={round2(marginsPt[side] / POINTS_PER[marginUnit])}
                  aria-label={`${side} margin in ${MARGIN_UNIT_LABEL[marginUnit]}`}
                  onChange={(e) => {
                    invalidate();
                    const points = Math.max(0, Number(e.target.value)) * POINTS_PER[marginUnit];
                    setMarginsPt((p) => ({ ...p, [side]: points }));
                  }}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
                />
              </div>
            ))}
          </div>
          <p className={note}>The dashed line on each page shows the margins.</p>
        </section>
      )}
    </div>
  );

  const result =
    done && run.result ? (
      <div className="flex flex-col gap-3 p-3 sm:p-4" data-testid="result-panel">
        <h3 className={heading}>PDF created!</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {plural(run.result.pages, 'image')} on {plural(run.result.pages, 'page')}. The pages shown are laid out
          exactly as they are in the file.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-secondary)]">File</dt>
          <dd className="truncate font-medium text-[var(--color-text-primary)]">{run.result.file.name}</dd>
          <dt className="text-[var(--color-text-secondary)]">Size</dt>
          <dd className="text-[var(--color-text-primary)]">{formatBytes(run.result.file.size)}</dd>
          <dt className="text-[var(--color-text-secondary)]">Pages</dt>
          <dd className="text-[var(--color-text-primary)]">{run.result.pages}</dd>
          <dt className="text-[var(--color-text-secondary)]">Page size</dt>
          <dd className="text-[var(--color-text-primary)]">
            {pageSize === 'fit'
              ? 'Fit Image'
              : `${PAGE_SIZE_LABEL[pageSize]}, ${standardPageMm(pageSize)}, ${ORIENTATION_CAPTION[orientation]}`}
          </dd>
        </dl>
        <NextStep href="/compress-pdf/" label="Compress PDF">Large file? Shrink it with</NextStep>
        <p className={note}>
          Something not right? Make changes takes you back to the page size, placement and margins.
        </p>
      </div>
    ) : undefined;

  return (
    <ToolWorkspace
      toolId="image-to-pdf"
      active={count > 0}
      empty={<DropZone accept={ACCEPTED_MIMES} multiple onFiles={addFiles} hint={FORMATS_HINT} />}
      title="Images to PDF"
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        <WorkspaceFileBar
          files={items.map((i) => i.file)}
          noun="image"
          onAdd={addFiles}
          onRemove={removeAll}
          accept={ACCEPTED_MIMES}
          disabled={busy}
        />
      }
      stage={stage}
      controls={controls}
      result={result}
      action={
        <ActionBar
          phase={run.phase}
          label={`Create PDF (${plural(count, 'page')})`}
          runningLabel="Creating…"
          onRun={create}
          disabledReason={disabledReason}
          hint="One page for each image, in the order shown."
          progress={run.progress}
          progressLabel={run.progressLabel}
          onCancel={run.cancel}
          download={{ label: 'Download PDF', onDownload: download, ariaLabel: `Download PDF: ${OUTPUT_NAME}` }}
          summary={summary}
          onEditAgain={run.invalidate}
          error={run.error}
        />
      }
    />
  );
}
