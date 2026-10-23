import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import DropZone from '@/components/islands/shared/DropZone';
import NextStep from '@/components/islands/shared/NextStep';
import MultiFileDownload, { useMultiFileDownload, type MultiFile } from '@/components/islands/shared/MultiFileDownload';
import ToolWorkspace from '@/components/islands/workspace/ToolWorkspace';
import ActionBar from '@/components/islands/workspace/ActionBar';
import WorkspaceFileBar from '@/components/islands/workspace/WorkspaceFileBar';
import ImageStage from '@/components/islands/workspace/ImageStage';
import { useToolRun } from '@/components/islands/workspace/use-tool-run';
import { useMediaQuery } from '@/hooks/use-media-query';
import { downloadBlob } from '@/lib/download';
import { formatBytes, generateId, cn } from '@/lib/utils';
import {
  TARGET_MAX_QUALITY,
  TARGET_MIN_QUALITY,
  buildImageFacts,
  canPreviewLive,
  formatLabel,
  formatName,
  hasQuality,
  outputFileName,
  savedPercent,
  targetLabel,
  uniqueNames,
  type ImageFacts,
} from '@/lib/compress-image';
import type { CompressImageFormat, CompressImageOptions, CompressImageStats } from '@/types/worker-messages';
import { useImagePreview } from './use-image-preview';
import { loadImage, type LoadedImage } from './load-image';

/**
 * Compress Image, in the shared workspace.
 *
 * The image is shown large on a checkerboard, at Fit, 100% or 200%. For JPEG
 * and WebP at a normal size, moving the quality slider compresses the shown
 * image (debounced, latest wins) so Original vs Compressed updates as you go;
 * AVIF, PNG and large images wait for "Preview". Target size shows its result
 * after the run. Facts under the comparison come from the real output.
 *
 * Several images: a strip above the stage chooses which is shown; the run
 * compresses them all with the same settings and hands them over with
 * `MultiFileDownload`.
 */

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heic', 'image/heif'];
const FORMATS: CompressImageFormat[] = ['jpeg', 'webp', 'avif', 'png'];
const NO_FILES: MultiFile[] = [];

interface Item {
  id: string;
  file: File;
  info: LoadedImage | null;
  failed: boolean;
}

interface Output {
  itemId: string;
  name: string;
  blob: Blob;
  url: string;
  stats: CompressImageStats;
  originalBytes: number;
  facts: ImageFacts;
}

interface RunResult {
  outputs: Output[];
  files: MultiFile[];
}

interface CompressImageToolProps {
  /** Start in Target size mode at this many KB — set by the size-specific landing pages. */
  initialTargetKb?: number;
  /** Pre-selected output format. Upload forms with a size limit usually want a JPG. */
  initialFormat?: CompressImageFormat;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const choice = (on: boolean) =>
  cn(
    'h-9 rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    on
      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]'
      : 'border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background)]',
  );

function FactList({ facts, testId }: { facts: ImageFacts; testId: string }) {
  return (
    <ul data-testid={testId} className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
      {facts.facts.map((f) => (
        <li
          key={f.key}
          data-testid={`fact-${f.key}`}
          className={cn(
            (f.key === 'target-missed' || f.key === 'original') && 'font-medium text-[var(--color-text-primary)]',
          )}
        >
          {f.text}
        </li>
      ))}
    </ul>
  );
}

export default function CompressImageTool({ initialTargetKb, initialFormat = 'webp' }: CompressImageToolProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState(0);
  const [format, setFormat] = useState<CompressImageFormat>(initialFormat);
  const [mode, setMode] = useState<'quality' | 'target-size'>(initialTargetKb ? 'target-size' : 'quality');
  const [quality, setQuality] = useState(75);
  const [targetKb, setTargetKb] = useState<number>(initialTargetKb ?? 200);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [step, setStep] = useState({ index: 0, count: 1 });
  const wide = useMediaQuery('(min-width: 1024px)');
  const phone = useMediaQuery('(max-width: 767px)');
  const run = useToolRun<RunResult>();
  const { invalidate } = run;

  const active = items.length > 0;
  const batch = items.length > 1;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const item = items[index] ?? null;
  const targetBytes = Math.round(targetKb * 1024);
  const targetInvalid = mode === 'target-size' && !(targetBytes >= 1024);
  const effectiveFormat: CompressImageFormat = mode === 'target-size' && format === 'png' ? 'webp' : format;

  const options = useMemo<CompressImageOptions>(
    () =>
      mode === 'target-size'
        ? { format: effectiveFormat, mode, targetBytes }
        : { format: effectiveFormat, mode, quality: hasQuality(effectiveFormat) ? quality : undefined },
    [effectiveFormat, mode, quality, targetBytes],
  );

  /* ── Files ────────────────────────────────────────────────────────────── */

  // Object URLs of the images on screen, revoked when an image leaves.
  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const read = useCallback((added: Item[]) => {
    for (const it of added) {
      loadImage(it.file).then(
        (info) => {
          urls.current.set(it.id, info.url);
          setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, info } : p)));
        },
        () => setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, failed: true } : p))),
      );
    }
  }, []);

  const drop = useCallback((gone: Item[]) => {
    for (const it of gone) {
      const url = urls.current.get(it.id);
      if (url) URL.revokeObjectURL(url);
      urls.current.delete(it.id);
    }
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = files.map((file) => ({ id: generateId(), file, info: null, failed: false }));
      setItems((prev) => {
        if (prev.length === 0) setSelected(0);
        return [...prev, ...added];
      });
      read(added);
    },
    [invalidate, read],
  );

  const replaceFile = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      invalidate();
      const added = files.map((file) => ({ id: generateId(), file, info: null, failed: false }));
      setItems((prev) => {
        drop(prev);
        return added;
      });
      setSelected(0);
      read(added);
    },
    [invalidate, read, drop],
  );

  const removeAll = useCallback(() => {
    invalidate();
    setItems((prev) => {
      drop(prev);
      return [];
    });
    setSelected(0);
  }, [invalidate, drop]);

  const removeOne = useCallback(
    (id: string) => {
      invalidate();
      setItems((prev) => {
        drop(prev.filter((p) => p.id === id));
        return prev.filter((p) => p.id !== id);
      });
    },
    [invalidate, drop],
  );

  /** Wrap a setter so any change makes the result stale. */
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      invalidate();
      set(value);
    };

  /* ── Preview ──────────────────────────────────────────────────────────── */

  const pixels = item?.info ? item.info.width * item.info.height : 0;
  const live = canPreviewLive(effectiveFormat, pixels);
  const running = run.phase === 'running';
  const done = run.phase === 'done' && !!run.result;
  const preview = useImagePreview({
    item: item?.info ? { id: item.id, file: item.file } : null,
    options: mode === 'quality' ? options : null,
    live,
    paused: running || done,
  });
  const previewFacts = preview.shown ? buildImageFacts(item!.file.size, preview.shown.blob.size, preview.shown.stats) : null;

  /* ── The run ──────────────────────────────────────────────────────────── */

  const compress = useCallback(() => {
    if (!active || targetInvalid) return;
    const used = options;
    const list = items;
    void run.start(async (work) => {
      // Let "Compressing…" paint, even when every image's preview can be reused.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const outputs: Output[] = [];
      for (const [i, it] of list.entries()) {
        setStep({ index: i, count: list.length });
        let blob: Blob;
        let stats: CompressImageStats;
        // The preview of this image at these settings is the same pass: reuse its bytes.
        const cached = used.mode === 'quality' ? preview.lookup(it.id, used) : undefined;
        if (cached) {
          blob = cached.blob;
          stats = cached.stats;
        } else {
          const buffer = await it.file.arrayBuffer();
          const response = await work(
            'image',
            { op: 'compress-image', buffer, options: used, progressPort: undefined as never },
            [buffer],
          );
          if (!response) return null;
          if (response.status === 'error') throw new Error(`${it.file.name} could not be compressed: ${response.message}`);
          if (response.status !== 'success' || !response.stats?.image) throw new Error(`${it.file.name} could not be compressed.`);
          stats = response.stats.image;
          blob = new Blob([response.result], { type: stats.mime });
        }
        outputs.push({
          itemId: it.id,
          name: outputFileName(it.file.name, stats.mime),
          blob,
          url: URL.createObjectURL(blob),
          stats,
          originalBytes: it.file.size,
          facts: buildImageFacts(it.file.size, blob.size, stats),
        });
      }
      const names = uniqueNames(outputs.map((o) => o.name));
      outputs.forEach((o, i) => (o.name = names[i]));
      return {
        outputs,
        files: outputs.map((o) => ({ name: o.name, blob: o.blob, width: o.stats.width, height: o.stats.height })),
      };
    });
  }, [active, targetInvalid, options, items, run, preview]);

  // The outputs' object URLs live as long as the result.
  const result = run.result;
  useEffect(() => {
    if (!result) return;
    return () => {
      for (const o of result.outputs) URL.revokeObjectURL(o.url);
    };
  }, [result]);

  const resultFiles = result?.files ?? NO_FILES;
  const downloads = useMultiFileDownload({
    files: resultFiles,
    zipName: 'compressed-images.zip',
    noun: { one: 'image', other: 'images' },
    folderStartIn: 'pictures',
  });

  const output = done ? result!.outputs.find((o) => o.itemId === item?.id) ?? null : null;

  /* ── Stage ────────────────────────────────────────────────────────────── */

  const tried =
    effectiveFormat === 'png' ? 'a lossless PNG' : `${formatLabel(effectiveFormat)} at quality ${quality}`;
  let source: 'original' | 'preview' | 'output' = 'original';
  let stageStatus: string;
  if (!item) stageStatus = '';
  else if (item.failed) stageStatus = `${item.file.name} could not be read as an image.`;
  else if (!item.info) stageStatus = 'Reading the image…';
  else if (running) stageStatus = batch ? `Compressing ${step.index + 1} of ${step.count}…` : 'Compressing…';
  else if (output) {
    source = 'output';
    stageStatus = `${output.name}: ${formatName(output.stats.mime)} · ${formatBytes(output.originalBytes)} → ${formatBytes(output.blob.size)} · ${output.facts.outcome}`;
  } else if (mode === 'target-size')
    stageStatus = `Your original. Target size shows the result after you press ${batch ? `Compress ${items.length} images` : 'Compress image'}.`;
  else if (preview.status === 'ready' && previewFacts) {
    source = 'preview';
    stageStatus = `Preview, ${tried}: ${formatBytes(item.file.size)} → ${formatBytes(preview.shown!.blob.size)} · ${previewFacts.outcome}`;
  } else if (preview.status === 'working') {
    source = preview.shown ? 'preview' : 'original';
    stageStatus = `Making the preview as ${tried}…`;
  } else if (preview.status === 'error') stageStatus = `The preview could not be made: ${preview.error}`;
  else
    stageStatus = `Your original. Press Preview to see it as ${tried}${live ? '' : effectiveFormat === 'avif' ? ' (AVIF is slow to encode, so it waits to be asked)' : pixels > 12_000_000 ? ' (a large image, so it waits to be asked)' : ''}.`;

  const showPreviewButton = !!item?.info && !done && !running && mode === 'quality' && !live;
  const afterSrc = output ? output.url : source === 'preview' ? (preview.shown?.url ?? null) : null;

  const stage = item ? (
    <ImageStage
      src={item.info?.url ?? null}
      alt={`Original: ${item.file.name}`}
      naturalWidth={item.info?.width ?? 0}
      naturalHeight={item.info?.height ?? 0}
      resultSrc={afterSrc}
      resultAlt={`Compressed: ${item.file.name}`}
      beforeLabel="Original"
      afterLabel="Compressed"
      busy={!done && preview.status === 'working'}
      placeholder={item.failed ? 'This file could not be read as an image' : 'Reading the image…'}
      items={items.map((it, i) => ({
        id: it.id,
        name: it.file.name,
        thumbSrc: it.info?.url ?? null,
        badge:
          done && result!.outputs[i]?.facts.warning ? (
            <span
              title="Not what was asked for — see the facts"
              className="flex size-4 items-center justify-center rounded-full bg-[var(--color-warning)] text-[10px] font-bold text-white"
            >
              !
            </span>
          ) : null,
      }))}
      selected={index}
      onSelect={setSelected}
      footer={
        <div className="flex items-center gap-2">
          <p
            data-testid="stage-status"
            data-source={source}
            data-live={live && mode === 'quality' ? 'true' : 'false'}
            data-preview={preview.status}
            aria-live="polite"
            className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]"
          >
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
              {preview.status === 'working' ? 'Making preview…' : 'Preview'}
            </button>
          )}
        </div>
      }
    />
  ) : null;

  /* ── Controls ─────────────────────────────────────────────────────────── */

  const heading = 'text-sm font-semibold text-[var(--color-text-primary)]';
  const note = 'text-xs leading-5 text-[var(--color-text-secondary)]';

  const controls = (
    <div className="flex flex-col gap-5 p-3 sm:p-4" inert={running}>
      <section className="flex flex-col gap-2" aria-labelledby="ci-format-heading">
        <h3 id="ci-format-heading" className={heading}>
          Output format
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Output format">
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={effectiveFormat === f}
              disabled={f === 'png' && mode === 'target-size'}
              data-testid={`format-${f}`}
              onClick={() => change(setFormat)(f)}
              className={choice(effectiveFormat === f)}
            >
              {formatLabel(f)}
            </button>
          ))}
        </div>
        {effectiveFormat === 'jpeg' && (
          <p data-testid="jpeg-background-note" className={note}>
            JPEG cannot store transparency: transparent areas become white.
          </p>
        )}
        {effectiveFormat === 'png' && (
          <p data-testid="png-note" className={note}>
            PNG is lossless: every pixel is kept, so there is no quality to choose. The image is saved again as PNG, which
            for photos is usually larger than JPEG or WebP. If it does not come out smaller, your original is kept.
          </p>
        )}
        {effectiveFormat === 'avif' && <p className={note}>AVIF is often the smallest at a given quality, but slow to encode.</p>}
        {mode === 'target-size' && <p className={note}>PNG has no quality to lower, so it cannot aim at a size.</p>}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="ci-mode-heading">
        <h3 id="ci-mode-heading" className={heading}>
          Compression
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Compression mode">
          <button type="button" aria-pressed={mode === 'quality'} onClick={() => change(setMode)('quality')} className={choice(mode === 'quality')}>
            By quality
          </button>
          <button
            type="button"
            aria-pressed={mode === 'target-size'}
            onClick={() => change(setMode)('target-size')}
            className={choice(mode === 'target-size')}
          >
            Target size
          </button>
        </div>
        {mode === 'quality' ? (
          hasQuality(effectiveFormat) ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                <label htmlFor="ci-quality">Quality</label>
                <output htmlFor="ci-quality" className="tabular-nums" data-testid="quality-value">
                  {quality}
                </output>
              </div>
              <input
                id="ci-quality"
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(e) => change(setQuality)(Number(e.target.value))}
                className="w-full accent-[var(--color-primary)]"
              />
              <p className={note}>
                {live
                  ? 'Lower is smaller with more visible loss. The comparison updates as you move it.'
                  : 'Lower is smaller with more visible loss. Press Preview under the image to see it.'}
              </p>
            </div>
          ) : null
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="ci-target-kb" className="text-xs text-[var(--color-text-secondary)]">
              Target size (KB)
            </label>
            <input
              id="ci-target-kb"
              type="number"
              min={1}
              value={Number.isFinite(targetKb) ? targetKb : ''}
              onChange={(e) => change(setTargetKb)(e.target.value === '' ? NaN : Number(e.target.value))}
              className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            />
            <p className={note}>
              Tries qualities from {TARGET_MAX_QUALITY} down to {TARGET_MIN_QUALITY} and keeps the highest whose file fits.
              The pixel size is not changed; if even quality {TARGET_MIN_QUALITY} does not fit, you are told the smallest
              size it reached.
            </p>
          </div>
        )}
      </section>

      {previewFacts && !done && (
        <section data-testid="preview-facts-section" aria-labelledby="ci-preview-heading" className="flex flex-col gap-1.5">
          <h3 id="ci-preview-heading" className={heading}>
            Preview{preview.current ? '' : ' (updating…)'}
          </h3>
          <FactList facts={previewFacts} testId="preview-facts" />
        </section>
      )}

      {batch && (
        <section className="flex flex-col gap-2" aria-labelledby="ci-files-heading">
          <h3 id="ci-files-heading" className={heading}>
            Images ({items.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {items.map((it, i) => (
              <li key={it.id} data-testid="file-row" className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-current={i === index ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded px-1 py-1 text-left',
                    i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-primary)]',
                  )}
                >
                  {it.file.name}
                </button>
                <span className="shrink-0 tabular-nums text-[var(--color-text-secondary)]">{formatBytes(it.file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeOne(it.id)}
                  aria-label={`Remove ${it.file.name}`}
                  data-testid="file-remove"
                  className="flex size-7 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DropZone accept={ACCEPTED} multiple onFiles={addFiles} compact compactLabel="Add images" hint="JPEG, PNG, WebP, AVIF, HEIC" />

      <p className={note}>
        Compressing re-encodes the image from its pixels, so EXIF and other metadata (camera, location, date) are not
        copied into the new file. A file kept as your original is unchanged.
      </p>
    </div>
  );

  /* ── Result ───────────────────────────────────────────────────────────── */

  const totalBefore = result ? result.outputs.reduce((s, o) => s + o.originalBytes, 0) : 0;
  const totalAfter = result ? result.outputs.reduce((s, o) => s + o.blob.size, 0) : 0;
  const missed = !!output?.stats.target && !output.stats.target.met;

  const resultPanel =
    done && result ? (
      <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="result-panel">
        {output && (
          <section aria-labelledby="ci-facts-heading" className="flex flex-col gap-1.5">
            <h3 id="ci-facts-heading" className={heading} data-testid="facts-heading">
              {batch ? `${output.name}: ` : ''}
              {output.facts.outcome}
            </h3>
            <FactList facts={output.facts} testId="image-facts" />
          </section>
        )}

        {batch && (
          <section aria-labelledby="ci-batch-heading" className="flex flex-col gap-1.5">
            <h3 id="ci-batch-heading" className={heading}>
              {plural(result.outputs.length, 'image')}: {formatBytes(totalBefore)} → {formatBytes(totalAfter)}
              {savedPercent(totalBefore, totalAfter) > 0 ? ` (${savedPercent(totalBefore, totalAfter)}% smaller)` : ''}
            </h3>
            <ul data-testid="batch-facts" className="flex flex-col gap-0.5 text-xs">
              {result.outputs.map((o, i) => (
                <li key={o.itemId}>
                  <button
                    type="button"
                    data-testid="batch-fact"
                    onClick={() => setSelected(i)}
                    aria-current={i === index ? 'true' : undefined}
                    className={cn(
                      'w-full rounded px-1 py-1 text-left',
                      i === index ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    {o.name} · {formatBytes(o.originalBytes)} → {formatBytes(o.blob.size)} · {o.facts.outcome}
                  </button>
                </li>
              ))}
            </ul>
            <MultiFileDownload
              files={resultFiles}
              zipName="compressed-images.zip"
              noun={{ one: 'image', other: 'images' }}
              listLabel="Your compressed images"
              folderStartIn="pictures"
              controller={downloads}
              hidePrimary
            />
          </section>
        )}

        {missed ? (
          <NextStep href="/resize-image/" label="Resize Image">
            Still too large? Make it smaller in pixels with
          </NextStep>
        ) : (
          <NextStep href="/resize-image/" label="Resize Image">
            Need different dimensions? Try
          </NextStep>
        )}
      </div>
    ) : undefined;

  /* ── What the visitor is told ─────────────────────────────────────────── */

  const actionLabel = batch ? `Compress ${items.length} images` : 'Compress image';
  const beside = wide ? 'on the right' : 'below';
  const anyFailed = items.find((it) => it.failed);
  const loading = items.some((it) => !it.info && !it.failed);

  let prompt: string;
  let promptTone: 'info' | 'success' | 'error' = 'info';
  if (loading) prompt = batch ? 'Reading your images…' : 'Reading your image…';
  else if (anyFailed) {
    prompt = `${anyFailed.file.name} could not be read as an image. Remove it or choose another file.`;
    promptTone = 'error';
  } else if (running) prompt = batch ? 'Compressing your images…' : 'Compressing your image…';
  else if (run.phase === 'error') {
    prompt = 'The image could not be compressed. Try again.';
    promptTone = 'error';
  } else if (done) {
    const missedAny = result!.outputs.some((o) => o.stats.target && !o.stats.target.met);
    const keptAll = result!.outputs.every((o) => o.stats.returnedOriginal);
    if (missedAny) {
      prompt = batch
        ? `Not every image could be brought under ${targetLabel(targetBytes)} — see the facts, then download or make changes.`
        : `This image could not be brought under ${targetLabel(targetBytes)}. See the smallest size reached, then download or make changes.`;
      promptTone = 'error';
    } else if (keptAll && !batch) {
      prompt = 'Compressing did not make this image smaller, so your original is kept. Download it, or make changes.';
    } else {
      prompt = batch
        ? 'Choose an image above to compare it with its original, then download them.'
        : 'Compare the compressed image with your original, then download it.';
      promptTone = 'success';
    }
  } else if (phone && !optionsOpen) {
    prompt = `Open Options to choose the format and ${mode === 'target-size' ? 'target size' : 'quality'}, then press ${actionLabel}.`;
  } else if (mode === 'target-size') {
    prompt = `Enter the largest file size you can accept ${beside}, then press ${actionLabel}.`;
  } else if (live) {
    prompt = `Choose the format and quality ${beside}; the comparison updates as you go. Then press ${actionLabel}.`;
  } else {
    prompt = `Choose the format ${beside}, press Preview to see the result, then press ${actionLabel}.`;
  }

  const hint =
    mode === 'target-size'
      ? `Finds the highest ${formatLabel(effectiveFormat)} quality that fits under ${targetInvalid ? 'the size you enter' : targetLabel(targetBytes)}.`
      : effectiveFormat === 'png'
        ? 'Saves a lossless PNG at the same pixel size, or keeps your original if that is smaller.'
        : `Saves ${formatLabel(effectiveFormat)} at quality ${quality}, same pixel size — or keeps your original if that is smaller.`;

  const disabledReason = loading
    ? 'Reading the image…'
    : anyFailed
      ? `${anyFailed.file.name} could not be read as an image`
      : targetInvalid
        ? 'Enter a target size of at least 1 KB'
        : null;

  const progress = Math.round(((step.index + run.progress / 100) / Math.max(1, step.count)) * 100);

  let summary: string | undefined;
  if (result && !batch && result.outputs[0]) {
    const o = result.outputs[0];
    summary = `${o.name} · ${formatBytes(o.blob.size)} · ${o.facts.outcome}`;
  } else if (result) {
    summary = `${plural(result.outputs.length, 'image')} · ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}`;
  }

  const single = result && result.outputs.length === 1 ? result.outputs[0] : null;
  const download = single
    ? {
        label: 'Download',
        onDownload: () => downloadBlob(single.blob, single.name),
        ariaLabel: `Download ${single.name}`,
      }
    : {
        label: downloads.primaryLabel,
        onDownload: downloads.handlePrimary,
        ariaLabel: downloads.primaryAriaLabel,
        busyLabel: downloads.primaryBusyLabel,
        doneLabel: downloads.primaryDoneLabel,
      };

  return (
    <ToolWorkspace
      toolId="compress-image"
      active={active}
      empty={<DropZone accept={ACCEPTED} multiple onFiles={addFiles} hint="JPEG, PNG, WebP, AVIF, HEIC · single or batch" />}
      title={batch ? 'Compress these images' : 'Compress this image'}
      prompt={prompt}
      promptTone={promptTone}
      optionsOpen={optionsOpen}
      onOptionsOpenChange={setOptionsOpen}
      fileBar={
        batch ? (
          <WorkspaceFileBar
            files={items.map((it) => it.file)}
            noun="image"
            onAdd={addFiles}
            onRemove={removeAll}
            accept={ACCEPTED}
            disabled={running}
          />
        ) : item ? (
          <WorkspaceFileBar
            file={item.file}
            extra={item.info ? `${item.info.width} × ${item.info.height} px` : undefined}
            onRemove={removeAll}
            onReplace={replaceFile}
            accept={ACCEPTED}
            disabled={running}
          />
        ) : null
      }
      stage={stage}
      controls={controls}
      result={resultPanel}
      action={
        <ActionBar
          phase={run.phase}
          label={actionLabel}
          runningLabel="Compressing…"
          onRun={compress}
          disabledReason={disabledReason}
          hint={hint}
          progress={progress}
          progressLabel={batch ? `Compressing ${step.index + 1} of ${step.count}` : run.progressLabel}
          onCancel={run.cancel}
          download={download}
          summary={summary}
          onEditAgain={invalidate}
          error={run.error}
        />
      }
    />
  );
}
