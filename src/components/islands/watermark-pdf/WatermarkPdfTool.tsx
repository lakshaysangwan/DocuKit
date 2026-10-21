import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import PageViewer, { type PageFrame } from '@/components/islands/workspace/PageViewer';
import PageRail from '@/components/islands/workspace/PageRail';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import WatermarkPreview from './WatermarkPreview';
import { usePdfDocument } from '@/hooks/use-pdf-document';
import { useMediaQuery } from '@/hooks/use-media-query';
import { prepareImageForPdf, type EmbedMime } from '@/lib/image-for-pdf';
import { parsePageRange } from '@/lib/pdf-page-range';
import { notifyPdfLoadError } from '@/lib/notify';
import { downloadBlob } from '@/lib/download';
import { formatBytes, cn } from '@/lib/utils';
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_MARGIN,
  DEFAULT_SPACING,
  WATERMARK_POSITIONS,
  layoutWatermark,
  watermarkedPages,
  type WatermarkApplyTo,
  type WatermarkLayoutOptions,
  type WatermarkPosition,
} from '@/lib/watermark-layout';
import { WATERMARK_FONTS, unsupportedChars, type WatermarkFont } from '@/lib/watermark-fonts';
import type { WatermarkOptions } from '@/types/worker-messages';

/**
 * Watermark PDF, in the shared workspace.
 *
 * Any page is shown large with the watermark drawn on it from
 * `layoutWatermark` — the function the worker writes with — so the preview is
 * the file: the same boxes, the same turn about the same centre, on rotated
 * and cropped pages too. Pages outside "Apply to" are shown without it and
 * badged "Not watermarked". After a run the stage shows the real output, with
 * Before / After.
 */

type WatermarkType = 'text' | 'image';
type Placement = 'single' | 'tiled';

const ACCEPT = ['application/pdf'];
/** What the image picker takes. PNG and JPEG are embedded as they are; WebP is re-encoded to one of them first. */
const IMAGE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];

const POSITION_LABEL: Record<WatermarkPosition, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  center: 'Centre',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right',
};

const APPLY_LABEL: Record<WatermarkApplyTo, string> = {
  all: 'All pages',
  odd: 'Odd pages',
  even: 'Even pages',
  range: 'Specific pages',
};

interface WatermarkImage {
  name: string;
  url: string;
  bytes: ArrayBuffer;
  mime: EmbedMime;
  width: number;
  height: number;
  reencoded: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listPages = (pages: number[]) => {
  const n = pages.map((p) => p + 1);
  if (n.length <= 1) return `${n[0] ?? ''}`;
  if (n.length > 6) return `${n.slice(0, 5).join(', ')} and ${n.length - 5} more`;
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

const chip = (on: boolean) =>
  cn(
    'rounded-lg border px-3 py-1.5 text-xs transition-colors',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-primary)]/50',
  );
const sliderLabel = 'mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]';
const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';

export default function WatermarkPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const { status, doc, pageCount } = usePdfDocument(file);
  const [pageIndex, setPageIndex] = useState(0);

  const [type, setType] = useState<WatermarkType>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [font, setFont] = useState<WatermarkFont>('Helvetica-Bold');
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [color, setColor] = useState('#000000');
  const [opacity, setOpacity] = useState(30);
  const [rotation, setRotation] = useState(-45);
  const [placement, setPlacement] = useState<Placement>('single');
  const [position, setPosition] = useState<WatermarkPosition>('center');
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const [spacing, setSpacing] = useState(DEFAULT_SPACING);
  const [imageScale, setImageScale] = useState(50);
  const [image, setImage] = useState<WatermarkImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [applyTo, setApplyTo] = useState<WatermarkApplyTo>('all');
  const [pageRangeText, setPageRangeText] = useState('');
  const [layer, setLayer] = useState<'front' | 'behind'>('front');
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

  // The image's object URL lives as long as the image is chosen.
  useEffect(() => () => {
    if (image) URL.revokeObjectURL(image.url);
  }, [image]);

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
    setApplyTo('all');
    setPageRangeText('');
  }, [invalidate]);

  const imageInput = useRef<HTMLInputElement>(null);
  const chooseImage = useCallback(
    async (chosen: File | undefined) => {
      if (!chosen) return;
      setImageError(null);
      try {
        const prepared = await prepareImageForPdf(chosen);
        const bytes = await prepared.blob.arrayBuffer();
        setImage({
          name: chosen.name,
          url: URL.createObjectURL(prepared.blob),
          bytes,
          mime: prepared.mime,
          width: prepared.width,
          height: prepared.height,
          reencoded: prepared.reencoded,
        });
        invalidate();
      } catch (err) {
        setImageError(err instanceof Error ? err.message : 'This image could not be read.');
      }
    },
    [invalidate],
  );

  /* ── What gets watermarked ───────────────────────────────────────────── */

  const range = useMemo(
    () => (applyTo === 'range' && pageCount > 0 ? parsePageRange(pageRangeText, pageCount) : []),
    [applyTo, pageRangeText, pageCount],
  );
  const targets = useMemo(() => watermarkedPages(applyTo, pageCount, range), [applyTo, pageCount, range]);
  const targetSet = useMemo(() => new Set(targets), [targets]);
  const onThisPage = targetSet.has(index);

  const layoutOptions = useMemo<WatermarkLayoutOptions>(
    () => ({
      type,
      text,
      font,
      fontSize,
      imageWidthPx: image?.width,
      imageHeightPx: image?.height,
      imageScale: imageScale / 100,
      rotation,
      placement,
      position,
      margin,
      spacing,
    }),
    [type, text, font, fontSize, image, imageScale, rotation, placement, position, margin, spacing],
  );

  const badChars = type === 'text' ? unsupportedChars(text) : [];

  /* ── The run ──────────────────────────────────────────────────────────── */

  const outputName = `${(file?.name ?? 'document').replace(/\.pdf$/i, '')}-watermarked.pdf`;

  let disabledReason: string | null = null;
  if (status !== 'ready') disabledReason = 'Opening your PDF…';
  else if (type === 'text' && !text.trim()) disabledReason = 'Enter watermark text';
  else if (badChars.length > 0)
    disabledReason = `${badChars.slice(0, 3).join(' ')} cannot be written with the standard PDF fonts. Use Latin letters, numbers and punctuation.`;
  else if (type === 'image' && !image) disabledReason = 'Choose an image for the watermark';
  else if (targets.length === 0) disabledReason = 'Enter which pages to watermark, e.g. "1-3, 5"';

  const apply = useCallback(() => {
    if (!file || !doc || disabledReason) return;
    const used = layoutOptions;
    const pages = targets;
    const imageUsed = type === 'image' ? image : null;
    void run.start(async (work) => {
      const geometries = await Promise.all(pages.map((i) => doc.geometry(i)));
      const buffer = await file.arrayBuffer();
      const imageBytes = imageUsed ? imageUsed.bytes.slice(0) : undefined;
      const options: WatermarkOptions = {
        ...used,
        color,
        opacity: opacity / 100,
        layer,
        imageBytes,
        imageMime: imageUsed?.mime,
        pages: pages.map((pageIndex, i) => ({ pageIndex, geometry: geometries[i] })),
      };
      const { port1, port2 } = new MessageChannel();
      try {
        const transfer: Transferable[] = [buffer, port2];
        if (imageBytes) transfer.push(imageBytes);
        const response = await work('pdf', { op: 'watermark', buffer, options, progressPort: port2 }, transfer);
        if (!response) return null;
        if (response.status === 'error') throw new Error(response.message || 'The watermark could not be added.');
        if (response.status !== 'success') throw new Error('The watermark could not be added.');
        setCompare('after');
        return new File([response.result], outputName, { type: 'application/pdf' });
      } finally {
        port1.close();
      }
    });
  }, [file, doc, disabledReason, layoutOptions, targets, type, image, color, opacity, layer, run, outputName]);

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
      if (!targetSet.has(frame.pageIndex)) return null;
      return (
        <WatermarkPreview
          frame={frame}
          layout={layoutWatermark(frame.geometry, layoutOptions)}
          type={type}
          text={text}
          font={font}
          fontSize={fontSize}
          color={color}
          opacity={opacity / 100}
          imageUrl={image?.url ?? null}
          layer={layer}
        />
      );
    },
    [targetSet, layoutOptions, type, text, font, fontSize, color, opacity, image, layer],
  );

  let pageNote: string;
  if (!onThisPage) {
    pageNote =
      applyTo === 'range'
        ? `Page ${index + 1} is not watermarked — it is not in the pages you entered.`
        : `Page ${index + 1} is not watermarked — “${APPLY_LABEL[applyTo]}” leaves it out.`;
  } else if (layer === 'behind') {
    pageNote =
      'Behind content: in the file the page paints over the watermark, so it is hidden under anything opaque, such as a scanned page. Add it to see the real result.';
  } else if (type === 'image' && !image) {
    pageNote = `Page ${index + 1}: choose an image to see it here.`;
  } else {
    pageNote = `Page ${index + 1}, as it will be watermarked.`;
  }

  const previewBar = (
    <div className="flex h-14 items-center px-2 sm:h-12 sm:px-3">
      <p
        data-testid="watermark-page-note"
        data-watermarked={onThisPage ? 'true' : 'false'}
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
        {compare === 'after' ? 'Watermarked — this is your file' : 'Before — your original'}
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
      pageLabel={showingOutput ? 'Watermarked page' : 'Page'}
    />
  );

  const rail = (
    <PageRail
      doc={viewerDoc}
      current={index}
      onSelect={goToPage}
      label={showingOutput ? 'Watermarked pages' : 'Pages'}
      renderBadge={(i) =>
        targetSet.has(i) ? null : (
          <span
            data-testid={`rail-badge-${i + 1}`}
            className="rounded-full bg-[var(--color-surface)] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[var(--color-text-secondary)] shadow-sm ring-1 ring-[var(--color-border)]"
          >
            Not watermarked
          </span>
        )
      }
    />
  );

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={run.phase === 'running'}>
      <div className="flex gap-1 rounded-lg bg-[var(--color-background)] p-1" role="group" aria-label="Watermark type">
        {(['text', 'image'] as WatermarkType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => change(setType)(t)}
            aria-pressed={type === t}
            data-testid={`wm-type-${t}`}
            className={cn(
              'flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
              type === t
                ? 'bg-white text-[var(--color-primary)] shadow-sm dark:bg-[var(--color-surface)]'
                : 'text-[var(--color-text-secondary)]',
            )}
          >
            {t === 'text' ? 'Text watermark' : 'Image watermark'}
          </button>
        ))}
      </div>

      {type === 'text' ? (
        <section className="flex flex-col gap-4" aria-label="Text">
          <div>
            <label htmlFor="wm-text" className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Watermark Text
            </label>
            <input
              id="wm-text"
              type="text"
              value={text}
              onChange={(e) => change(setText)(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="wm-font" className="mb-1 block text-xs text-[var(--color-text-secondary)]">
                Font
              </label>
              <select
                id="wm-font"
                data-testid="wm-font"
                value={font}
                onChange={(e) => change(setFont)(e.target.value as WatermarkFont)}
                className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-sm outline-none"
              >
                {WATERMARK_FONTS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label} Bold
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="wm-color" className="mb-1 block text-xs text-[var(--color-text-secondary)]">
                Color
              </label>
              <input
                id="wm-color"
                type="color"
                value={color}
                onChange={(e) => change(setColor)(e.target.value)}
                className="h-9 w-full cursor-pointer rounded-lg border border-[var(--color-border)]"
              />
            </div>
            <div className="col-span-2">
              <label htmlFor="wm-font-size" className={sliderLabel}>
                <span>Font Size</span>
                <span>{fontSize}pt</span>
              </label>
              <input
                id="wm-font-size"
                type="range"
                min={12}
                max={120}
                value={fontSize}
                onChange={(e) => change(setFontSize)(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />
            </div>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-3" aria-labelledby="wm-image-heading">
          <h3 id="wm-image-heading" className={heading}>
            Image
          </h3>
          <input
            ref={imageInput}
            id="wm-image-input"
            data-testid="wm-image-input"
            type="file"
            accept={IMAGE_ACCEPT.join(',')}
            aria-label="Watermark image"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              void chooseImage(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="flex items-center gap-3">
            {image && (
              <img
                src={image.url}
                alt=""
                className="size-12 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-background)] object-contain"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[var(--color-text-primary)]" data-testid="wm-image-name">
                {image ? image.name : 'No image chosen'}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {image?.reencoded ? `Converted to ${image.mime === 'image/png' ? 'PNG' : 'JPEG'} for the PDF.` : 'PNG, JPEG or WebP. PNG keeps transparency.'}
              </p>
            </div>
            <button
              type="button"
              data-testid="wm-image-choose"
              onClick={() => imageInput.current?.click()}
              className="h-9 shrink-0 rounded-lg border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-background)]"
            >
              {image ? 'Change image' : 'Choose image'}
            </button>
          </div>
          {imageError && (
            <p role="alert" className="text-xs text-[var(--color-error)]">
              {imageError}
            </p>
          )}
          <div>
            <label htmlFor="wm-image-size" className={sliderLabel}>
              <span>Image width</span>
              <span>{imageScale}% of the page</span>
            </label>
            <input
              id="wm-image-size"
              data-testid="wm-image-size"
              type="range"
              min={10}
              max={100}
              value={imageScale}
              onChange={(e) => change(setImageScale)(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-4" aria-label="Look">
        <div>
          <label htmlFor="wm-opacity" className={sliderLabel}>
            <span>Opacity</span>
            <span>{opacity}%</span>
          </label>
          <input
            id="wm-opacity"
            type="range"
            min={5}
            max={100}
            value={opacity}
            onChange={(e) => change(setOpacity)(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)]"
          />
        </div>
        <div>
          <label htmlFor="wm-rotation" className={sliderLabel}>
            <span>Rotation</span>
            <span>{rotation}°</span>
          </label>
          <input
            id="wm-rotation"
            type="range"
            min={-90}
            max={90}
            value={rotation}
            onChange={(e) => change(setRotation)(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)]"
          />
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="wm-placement-label">
        <h3 id="wm-placement-label" className={heading}>
          Placement
        </h3>
        <div className="flex gap-2" role="group" aria-labelledby="wm-placement-label">
          {(['single', 'tiled'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => change(setPlacement)(p)}
              aria-pressed={placement === p}
              data-testid={`wm-placement-${p}`}
              className={chip(placement === p)}
            >
              {p === 'single' ? 'Single' : 'Tiled'}
            </button>
          ))}
        </div>
        {placement === 'single' ? (
          <div className="flex items-start gap-4">
            <div className="grid shrink-0 grid-cols-3 gap-1" role="group" aria-label="Position">
              {WATERMARK_POSITIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => change(setPosition)(p)}
                  aria-pressed={position === p}
                  aria-label={POSITION_LABEL[p]}
                  title={POSITION_LABEL[p]}
                  data-testid={`wm-position-${p}`}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-md border transition-colors',
                    position === p
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', position === p ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-text-muted)]')}
                  />
                </button>
              ))}
            </div>
            {position !== 'center' && (
              <div className="min-w-0 flex-1">
                <label htmlFor="wm-margin" className={sliderLabel}>
                  <span>Distance from edge</span>
                  <span>{margin}pt</span>
                </label>
                <input
                  id="wm-margin"
                  data-testid="wm-margin"
                  type="range"
                  min={0}
                  max={144}
                  value={margin}
                  onChange={(e) => change(setMargin)(Number(e.target.value))}
                  className="w-full accent-[var(--color-primary)]"
                />
              </div>
            )}
          </div>
        ) : (
          <div>
            <label htmlFor="wm-spacing" className={sliderLabel}>
              <span>Spacing</span>
              <span>{spacing}pt</span>
            </label>
            <input
              id="wm-spacing"
              data-testid="wm-spacing"
              type="range"
              min={0}
              max={200}
              value={spacing}
              onChange={(e) => change(setSpacing)(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="wm-apply-label">
        <h3 id="wm-apply-label" className={heading}>
          Apply to
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="wm-apply-label">
          {(['all', 'odd', 'even', 'range'] as WatermarkApplyTo[]).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => change(setApplyTo)(a)}
              data-testid={`wm-apply-${a}`}
              aria-pressed={applyTo === a}
              className={chip(applyTo === a)}
            >
              {APPLY_LABEL[a]}
            </button>
          ))}
        </div>
        {applyTo === 'range' && (
          <div>
            <label htmlFor="wm-page-range" className="mb-1 block text-xs text-[var(--color-text-secondary)]">
              Pages{pageCount > 0 ? ` (1-${pageCount})` : ''}
            </label>
            <input
              id="wm-page-range"
              data-testid="wm-page-range"
              type="text"
              value={pageRangeText}
              onChange={(e) => change(setPageRangeText)(e.target.value)}
              placeholder="e.g. 1-3, 5, last"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="wm-layer-label">
        <h3 id="wm-layer-label" className={heading}>
          Layer
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="wm-layer-label">
          {([['front', 'On top'], ['behind', 'Behind content']] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => change(setLayer)(v)}
              data-testid={`wm-layer-${v}`}
              aria-pressed={layer === v}
              className={chip(layer === v)}
            >
              {label}
            </button>
          ))}
        </div>
        {layer === 'behind' && (
          <p className="text-xs leading-snug text-[var(--color-text-secondary)]">
            Hidden on pages with an opaque background, such as scans.
          </p>
        )}
      </section>
    </div>
  );

  const result = done && run.result ? (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="watermark-result">
      <section className="flex flex-col gap-1.5" aria-labelledby="wm-result-heading">
        <h3 id="wm-result-heading" className={heading}>
          Watermark added
        </h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {targets.length === pageCount
            ? `On all ${plural(pageCount, 'page')}.`
            : `On ${plural(targets.length, 'page')} of ${pageCount}: ${listPages(targets)}.`}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Look through any page with Before and After; press Make changes to adjust it.
        </p>
      </section>
      <NextStep href="/protect-pdf/" label="Protect PDF">
        Keep it private? Add a password with
      </NextStep>
    </div>
  ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const beside = wide ? 'on the right' : 'below';
  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (status !== 'ready') prompt = 'Opening your PDF…';
  else if (run.phase === 'running') prompt = 'Adding your watermark…';
  else if (run.phase === 'error') {
    prompt = 'The watermark could not be added. Try again.';
    promptTone = 'error';
  } else if (done) {
    prompt = 'Check any page, then download your watermarked PDF.';
    promptTone = 'success';
  } else if (phone && !optionsOpen) prompt = 'Open Options to set up your watermark, then press Add watermark.';
  else if (type === 'image' && !image) prompt = `Choose an image for your watermark ${beside}.`;
  else prompt = `Set up your watermark ${beside}, then press Add watermark.`;

  const hint =
    targets.length === pageCount
      ? `Adds the watermark to all ${plural(pageCount, 'page')}.`
      : `Adds the watermark to ${plural(targets.length, 'page')}: ${listPages(targets)}.`;

  const summary = run.result ? `${run.result.name} · ${formatBytes(run.result.size)} · ${plural(pageCount, 'page')}` : undefined;

  return (
    <ToolWorkspace
      toolId="watermark-pdf"
      active={active}
      empty={<DropZone accept={ACCEPT} multiple={false} onFiles={acceptFile} hint="PDF to watermark" />}
      title="Watermark this PDF"
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
          label="Add watermark"
          runningLabel="Adding watermark…"
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
